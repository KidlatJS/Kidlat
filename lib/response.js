/*!
 * kidlat - response object
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { native } from './native.js';
import { statusLine, httpDate, sanitizeHeaderValue, assertHeaderName } from './http/serialize.js';
import { pickSerializer } from './schema.js';
import { serializeCookie } from './cookies.js';

const EPOCH = new Date(0);

const TEXT  = 'text/plain; charset=utf-8';
const JSON_ = 'application/json; charset=utf-8';
const OCTET = 'application/octet-stream';

// Above this, a string body is handed to native separately instead of being concatenated onto the head first
const INLINE_BODY_MAX = 16384;

const CT_CODE = { [TEXT]: 1, [JSON_]: 2, [OCTET]: 3 };

function checkStatus(code) {
    if (!Number.isInteger(code) || code < 100 || code > 999) {
        throw new TypeError(`Invalid status code: ${JSON.stringify(String(code)).slice(0, 40)}`);
    }
    return code;
}

const isThenable = (v) => v !== null && typeof v === 'object' && typeof v.then === 'function';

const nameKeys = new Map();
const NAME_CACHE_MAX = 1024;

function headerKey(name) {
    let key = nameKeys.get(name);
    if (key === undefined) {
        assertHeaderName(name);
        key = name.toLowerCase();
        if (nameKeys.size < NAME_CACHE_MAX) nameKeys.set(name, key);
    }
    return key;
}

export class KidlatResponse {
    constructor(server, request, connId, seq, close, route, hooks) {
        this.server = server;
        this._init(request, connId, seq, close, route, hooks);
    }

    _init(request, connId, seq, close, route, hooks) {
        this.request = request;
        this.statusCode = 200;
        this.sent = false;

        this._connId = connId;
        this._seq = seq;
        this._close = close;
        this._route = route;
        this._hooks = hooks;
        this._statusSet = false;
        this._h = null;
    }

    status(code) {
        this.statusCode = checkStatus(code);
        this._statusSet = true;
        return this;
    }

    code(code) { return this.status(code); }

    header(name, value) {
        const key = headerKey(name);
        const v = Array.isArray(value) ? value.map(sanitizeHeaderValue) : sanitizeHeaderValue(value);
        this._trustedHeader(key, name, v);
        if (key === 'connection' && /\bclose\b/i.test(v)) this._close = true;
        return this;
    }

    _trustedHeader(key, name, value) {
        const h = this._h;
        if (h === null) {
            this._h = [key, name, value];
            return this;
        }
        for (let i = 0; i < h.length; i += 3) {
            if (h[i] === key) {
                h[i + 1] = name;
                h[i + 2] = value;
                return this;
            }
        }
        h.push(key, name, value);
        return this;
    }

    setHeader(name, value) { return this.header(name, value); }

    headers(obj) {
        for (const k of Object.keys(obj)) this.header(k, obj[k]);
        return this;
    }

    getHeader(name) {
        const i = indexOf(this._h, name.toLowerCase());
        return i === -1 ? undefined : this._h[i + 2];
    }

    getHeaders() {
        const h = this._h;
        if (h === null) return {};
        const pairs = [];
        for (let i = 0; i < h.length; i += 3) pairs.push([h[i], h[i + 2]]);
        return Object.fromEntries(pairs);
    }

    hasHeader(name) {
        return indexOf(this._h, name.toLowerCase()) !== -1;
    }

    removeHeader(name) {
        const i = indexOf(this._h, name.toLowerCase());
        if (i !== -1) this._h.splice(i, 3);
        return this;
    }

    type(contentType) { return this.header('Content-Type', contentType); }

    cookie(name, value, options) {
        const line = serializeCookie(name, value, options, this.request.protocol === 'https', this.server._cookieSigner);
        const i = indexOf(this._h, 'set-cookie');
        if (i === -1) return this._trustedHeader('set-cookie', 'Set-Cookie', [line]);
        const v = this._h[i + 2];
        this._h[i + 2] = typeof v === 'string' ? [v, line] : v.concat(line);
        return this;
    }

    clearCookie(name, options) {
        return this.cookie(name, '', { ...options, signed: false, maxAge: 0, expires: EPOCH });
    }

    send(body, status) {
        if (this.sent) return this;
        if (status !== undefined && !this._statusSet) this.statusCode = checkStatus(status);
        if (body === undefined || body === null) return this._finish('', TEXT);
        if (typeof body === 'string') return this._finish(body, TEXT);
        if (typeof body === 'object') {
            if (body instanceof Uint8Array) return this._finish(body, OCTET);
            if (typeof body.pipe === 'function' || typeof body.getReader === 'function' ||
                (typeof body[Symbol.asyncIterator] === 'function' && !Array.isArray(body))) {
                return this.stream(body);
            }
            return this.json(body);
        }
        return this._finish(String(body), TEXT);
    }

    json(obj, status) {
        if (this.sent) return this;
        if (status !== undefined && !this._statusSet) this.statusCode = checkStatus(status);
        const serializers = this._route !== null ? this._route.serializers : null;
        const serialize = serializers !== null ? pickSerializer(serializers, this.statusCode) : null;
        let payload = serialize !== null ? serialize(obj) : JSON.stringify(obj);
        if (payload === undefined) payload = '';
        return this._finish(payload, JSON_);
    }

    redirect(a, b) {
        const [code, url] = typeof a === 'number' ? [a, b] : [b || 302, a];
        this.header('Location', encodeURI(decodeURIComponentSafe(url)));
        if (!this._statusSet) this.statusCode = checkStatus(code);
        return this._finish('', TEXT);
    }

    stream(source, status, contentType) {
        if (this.sent) return this;
        if (status !== undefined && !this._statusSet) this.statusCode = checkStatus(status);
        this.sent = true;
        if (contentType && !this.hasHeader('content-type')) this.header('Content-Type', contentType);

        const code = this.statusCode;
        if (this.request.method === 'HEAD' || code === 204 || code === 304) {
            native.send(this._connId, this._seq, this._head(OCTET, ''), undefined, this._close);
            destroySource(source);
            if (this.server._trackResponses) this.server._afterResponse(this.request, this);
            return this;
        }
        const raw = this.request.httpVersion === '1.0' && native.rawStreams === true;
        if (raw) this._close = true;
        const head = this._head(OCTET, raw ? '' : 'Transfer-Encoding: chunked\r\n');
        if (!native.streamStart(this._connId, this._seq, head)) {
            destroySource(source);
            return this;
        }
        this.server._pipe(this, source, raw);
        return this;
    }

    _finish(payload, type) {
        this.sent = true;
        const hooks = this._hooks.onSend;
        if (hooks.length === 0) {
            this._write(payload, type);
            return this;
        }
        return this._runOnSend(hooks, 0, payload, type);
    }

    _runOnSend(hooks, i, payload, type) {
        for (; i < hooks.length; i++) {
            let result;
            try {
                result = hooks[i](this.request, this, payload);
            } catch (err) {
                return this._onSendFailed(err);
            }
            if (isThenable(result)) {
                const next = i + 1;
                return result.then(
                    (r) => this._runOnSend(hooks, next, r === undefined ? payload : r, type),
                    (err) => this._onSendFailed(err)
                );
            }
            if (result !== undefined) payload = result;
        }
        this._write(payload, type);
        return this;
    }

    _onSendFailed(err) {
        this.sent = false;
        this._hooks = { ...this._hooks, onSend: [] };
        this.server._handleError(err, this.request, this);
        return this;
    }

    _head(defaultType, lengthLine) {
        if (this.server._closing !== null || this.server._draining) this._close = true;
        let head = statusLine(this.statusCode);
        const h = this._h;
        if (h === null) {
            if (defaultType !== undefined) head += 'Content-Type: ' + defaultType + '\r\n';
            return head + lengthLine + 'Date: ' + httpDate() +
                (this._close ? '\r\nConnection: close\r\n' : '\r\nConnection: keep-alive\r\n') +
                this.server._defaultHeaderBlock + '\r\n';
        }

        let hasType = false, hasDate = false;
        for (let j = 0; j < h.length; j += 3) {
            const key = h[j];
            if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') continue;
            if (key === 'content-type') hasType = true;
            else if (key === 'date') hasDate = true;
            const name = h[j + 1], v = h[j + 2];
            if (typeof v === 'string') head += name + ': ' + v + '\r\n';
            else for (let i = 0; i < v.length; i++) head += name + ': ' + v[i] + '\r\n';
        }
        if (!hasType && defaultType !== undefined) head += 'Content-Type: ' + defaultType + '\r\n';
        head += lengthLine;
        if (!hasDate) head += 'Date: ' + httpDate() + '\r\n';
        head += this._close ? 'Connection: close\r\n' : 'Connection: keep-alive\r\n';
        const defaults = this.server._defaultHeaderList;
        for (let i = 0; i < defaults.length; i++) {
            if (indexOf(h, defaults[i][0]) === -1) head += defaults[i][1];
        }
        return head + '\r\n';
    }

    _write(payload, type) {
        const code = this.statusCode;
        if (this.server._closing !== null || this.server._draining) this._close = true;
        const flags = (this._close ? 1 : 0) | (this.request.method === 'HEAD' ? 2 : 0);
        if (this._h === null) native.respond(this._connId, this._seq, code, CT_CODE[type] ?? 0, payload, flags);
        else this._writeWithHeaders(code, payload, type, flags);
        if (this.server._trackResponses) this.server._afterResponse(this.request, this);
    }

    _writeWithHeaders(code, payload, type, flags) {
        const h = this._h;
        const defaultKeys = this.server._defaultHeaderKeys;
        const noBody = code === 204 || code === 304 || code < 200;
        let ct = CT_CODE[type] ?? 0;
        let hasType = false;
        let block = '';
        for (let j = 0; j < h.length; j += 3) {
            const key = h[j];
            if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') continue;
            if (key === 'content-type') {
                hasType = true;
                if (noBody) continue;
                ct = 0;
            } else if (key === 'date') {
                flags |= 4;
            } else if (defaultKeys.has(key)) {
                flags |= 8;
            }
            const name = h[j + 1], v = h[j + 2];
            if (typeof v === 'string') block += name + ': ' + v + '\r\n';
            else for (let i = 0; i < v.length; i++) block += name + ': ' + v[i] + '\r\n';
        }
        if (ct === 0 && !noBody && type !== undefined && !hasType) block += 'Content-Type: ' + type + '\r\n';
        if (flags & 8) block += this._buildDefaultHeaders(h) ?? '';
        native.respond(this._connId, this._seq, code, ct, payload, flags, block);
    }

    _buildDefaultHeaders(h) {
        const defaults = this.server._defaultHeaderList;
        if (defaults.length === 0) return undefined;
        let out = '';
        for (let i = 0; i < defaults.length; i++) {
            if (indexOf(h, defaults[i][0]) === -1) out += defaults[i][1];
        }
        return out || undefined;
    }
}

function indexOf(h, key) {
    if (h === null) return -1;
    for (let i = 0; i < h.length; i += 3) if (h[i] === key) return i;
    return -1;
}

function decodeURIComponentSafe(s) {
    try { return decodeURI(s); } catch { return s; }
}

function destroySource(source) {
    if (source && typeof source.destroy === 'function') source.destroy();
    else if (source && typeof source.cancel === 'function') source.cancel().catch(() => {});
}
