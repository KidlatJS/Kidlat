/*!
 * kidlat - request object
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import crypto from 'crypto';
import { httpError } from './errors.js';
import { proxyChain, peerTrusted, validHost, lastValue } from './trust-proxy.js';
import { parseCookies } from './cookies.js';
import { parseQuery, parseForm } from './form.js';

const BODY_RECEIVING = 1;
const BODY_DONE = 2;
const BODY_FAILED = 3;

const EMPTY = Buffer.alloc(0);

const SINGLE_VALUED = new Set([
    'age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from',
    'host', 'if-modified-since', 'if-unmodified-since', 'last-modified', 'location',
    'max-forwards', 'proxy-authorization', 'referer', 'retry-after', 'server', 'user-agent',
]);

const LETTER_ESCAPE = /\\u00[4-7][0-9a-fA-F]/;

export function hasPoison(text) {
    return text.indexOf('__proto__') !== -1 ||
        (text.indexOf('constructor') !== -1 && text.indexOf('prototype') !== -1) ||
        (text.indexOf('\\u') !== -1 && LETTER_ESCAPE.test(text));
}
function rejectPoison(key, value) {
    if (key === '__proto__') throw httpError(400, 'Invalid JSON: "__proto__" is not allowed');
    if (key === 'constructor' && value !== null && typeof value === 'object' &&
        Object.prototype.hasOwnProperty.call(value, 'prototype')) {
        throw httpError(400, 'Invalid JSON: "constructor.prototype" is not allowed');
    }
    return value;
}

export class KidlatRequest {
    constructor(server, method, url, path, queryStr, rawHeaders, socketIp, connId, contentLength) {
        this.server = server;
        this._init(method, url, path, queryStr, rawHeaders, socketIp, connId, contentLength);
    }

    _init(method, url, path, queryStr, rawHeaders, socketIp, connId, contentLength) {
        this.method = method;
        this.httpVersion = '1.1'; // '1.0' set by the server for HTTP/1.0 requests
        this.url = url;
        this.path = path;
        this.socketIp = socketIp;
        this.params = null;
        this.parsedBody = null;
        this.aborted = false;

        this._queryStr = queryStr;
        this._rawHeaders = rawHeaders;
        this._headers = null;
        this._query = null;
        this._id = null;
        this._log = null;
        this._fingerprint = null;
        this._ips = null;
        this._cookies = null;
        this._connId = connId;
        this._res = null;

        // contentLength: 0 = no body, > 0 = Content-Length, -1 = chunked
        this._expected = contentLength;
        this._bodyState = contentLength === 0 ? BODY_DONE : BODY_RECEIVING;
        this._chunks = null;
        this._size = 0;
        this._bodyBuf = null;
        this._waiters = null;
        this._bodyError = null;
        this._inline = null;
        this._inlineAscii = false;
    }

    _setInline(body, ascii) {
        this._inline = body;
        this._inlineAscii = ascii;
        this._size = body.length;
        this._bodyState = BODY_DONE;
    }

    _inlineText() {
        return this._inlineAscii ? this._inline : Buffer.from(this._inline, 'latin1').toString('utf8');
    }

    get headers() {
        if (this._headers !== null) return this._headers;
        const out = Object.create(null);
        const raw = this._rawHeaders;
        const n = raw.length;
        let i = 0;
        while (i < n) {
            let nl = raw.indexOf('\r\n', i);
            if (nl === -1) nl = n;
            const colon = raw.indexOf(':', i);
            if (colon !== -1 && colon < nl) {
                const key = raw.slice(i, colon).toLowerCase();
                let vs = colon + 1;
                let ve = nl;
                while (vs < ve && (raw.charCodeAt(vs) === 32 || raw.charCodeAt(vs) === 9)) vs++;
                while (ve > vs && (raw.charCodeAt(ve - 1) === 32 || raw.charCodeAt(ve - 1) === 9)) ve--;
                const val = raw.slice(vs, ve);
                const prev = out[key];
                if (prev === undefined) out[key] = val;
                else if (key === 'cookie') out[key] = prev + '; ' + val;
                else if (!SINGLE_VALUED.has(key)) out[key] = prev + ', ' + val;
            }
            i = nl + 2;
        }
        return (this._headers = out);
    }

    header(name) {
        return this.headers[name.toLowerCase()];
    }

    get query() {
        return this._query !== null ? this._query : (this._query = parseQuery(this._queryStr));
    }
    set query(value) { this._query = value; }

    get cookies() {
        return this._cookies !== null ? this._cookies : (this._cookies = parseCookies(this.headers.cookie));
    }

    get signedCookies() {
        const signer = this.server._cookieSigner;
        if (signer === null) throw new TypeError('req.signedCookies needs new Kidlat({ cookies: { secret } })');
        const out = Object.create(null);
        const all = this.cookies;
        for (const name in all) {
            const value = signer.unsign(name, all[name]);
            if (value !== undefined) out[name] = value;
        }
        return out;
    }

    get body() { return this.parsedBody; }
    set body(value) { this.parsedBody = value; }

    get id() {
        return this._id !== null ? this._id : (this._id = this.server._genReqId(this));
    }
    set id(value) { this._id = value; }

    get log() {
        if (this._log !== null) return this._log;
        const logger = this.server.logger;
        return (this._log = this.server._logRequests ? logger.child({ reqId: this.id }) : logger);
    }
    set log(value) { this._log = value; }

    get ip() {
        if (this.server._trust === null) return this.socketIp;
        return this.ips[0];
    }

    get ips() {
        if (this._ips !== null) return this._ips;
        return (this._ips = proxyChain(this.server._trust, this.socketIp, this.headers['x-forwarded-for']));
    }

    get protocol() {
        if (peerTrusted(this.server._trust, this.socketIp)) {
            const fwd = this.headers['x-forwarded-proto'];
            if (fwd) {
                const proto = lastValue(fwd).toLowerCase();
                if (proto === 'https' || proto === 'http') return proto;
            }
        }
        return this.server.httpsOptions ? 'https' : 'http';
    }

    get hostname() {
        let h = null;
        if (peerTrusted(this.server._trust, this.socketIp)) {
            const fwd = this.headers['x-forwarded-host'];
            if (fwd) h = validHost(lastValue(fwd));
        }
        if (h === null) h = validHost(this.headers.host);
        if (h === null) return '';
        if (h[0] === '[') return h.slice(0, h.indexOf(']') + 1); // [::1]:3000
        const colon = h.indexOf(':');
        return colon === -1 ? h : h.slice(0, colon);
    }

    get fingerprint() {
        if (this._fingerprint) return this._fingerprint;
        const h = this.headers;
        return (this._fingerprint = crypto
            .createHash('sha256')
            .update(`${this.ip}|${h['user-agent'] || ''}|${h['accept-language'] || ''}`)
            .digest('hex'));
    }

    get bodyComplete() { return this._bodyState === BODY_DONE; }

    buffer() {
        if (this._bodyState === BODY_DONE) return Promise.resolve(this._rawBody());
        return this._whenDone().then(() => this._rawBody());
    }

    text() {
        if (this._inline !== null) return Promise.resolve(this._inlineText());
        return this.buffer().then((b) => b.toString('utf8'));
    }

    json() {
        if (this.parsedBody !== null) return Promise.resolve(this.parsedBody);
        if (this._bodyState === BODY_DONE) {
            try { return Promise.resolve(this._parseJson()); } catch (err) { return Promise.reject(err); }
        }
        return this._whenDone().then(() => this._parseJson());
    }

    formData(options) {
        return this.buffer().then((body) => parseForm(this.headers['content-type'], body, options));
    }

    _parseJson() {
        if (this.parsedBody !== null) return this.parsedBody;
        let text;
        if (this._inline !== null) {
            text = this._inlineText();
        } else {
            const buf = this._rawBody();
            if (buf.length === 0) return (this.parsedBody = {});
            text = buf.toString('utf8');
        }
        if (text.length === 0) return (this.parsedBody = {});
        let value;
        try {
            value = hasPoison(text) ? JSON.parse(text, rejectPoison) : JSON.parse(text);
        } catch (err) {
            if (err.statusCode) throw err;
            throw httpError(400, 'Invalid JSON');
        }
        return (this.parsedBody = value);
    }

    _rawBody() {
        if (this._bodyBuf === null) {
            if (this._inline !== null) return (this._bodyBuf = Buffer.from(this._inline, 'latin1'));
            const c = this._chunks;
            this._bodyBuf = c === null ? EMPTY : c.length === 1 ? c[0] : Buffer.concat(c, this._size);
            this._chunks = null;
        }
        return this._bodyBuf;
    }

    _whenDone() {
        if (this._bodyState === BODY_DONE) return Promise.resolve();
        if (this._bodyState === BODY_FAILED) return Promise.reject(this._bodyError);
        return new Promise((resolve, reject) => {
            (this._waiters || (this._waiters = [])).push(resolve, reject);
        });
    }

    _push(chunk) {
        if (this._bodyState !== BODY_RECEIVING) return false;
        this._size += chunk.length;
        const route = this._res._route;
        if (this._size > (route !== null ? route.bodyLimit : this.server.bodyLimit)) {
            this._fail(httpError(413, 'Payload Too Large'));
            const res = this._res;
            if (res !== null && !res.sent) {
                res._close = true;
                res.code(413).send('Payload Too Large');
            }
            return false;
        }
        (this._chunks || (this._chunks = [])).push(chunk);
        if (this._expected > 0 && this._size >= this._expected) {
            this._complete();
            return false;
        }
        return true;
    }

    _complete() {
        if (this._bodyState !== BODY_RECEIVING) return;
        this._bodyState = BODY_DONE;
        const w = this._waiters;
        this._waiters = null;
        if (w !== null) for (let i = 0; i < w.length; i += 2) w[i]();
    }

    _fail(err) {
        if (this._bodyState !== BODY_RECEIVING) return;
        this._bodyState = BODY_FAILED;
        this._bodyError = err;
        this._chunks = null;
        const w = this._waiters;
        this._waiters = null;
        if (w !== null) for (let i = 1; i < w.length; i += 2) w[i](err);
    }
}
