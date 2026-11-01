/*!
 * kidlat - WebSocket routes and sockets
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 *
 * The protocol lives in C++ (src/ws/): framing, validation, ping/pong, the
 * close handshake and limits. This file declares routes, runs the upgrade
 * through the normal request pipeline, and hands whole messages to the
 * route's handlers.
 */

import { native } from './native.js';
import { WS_METHOD } from './constants.js';
import { isThenable } from './pipeline.js';
import { peerTrusted, validHost, lastValue } from './trust-proxy.js';

const DEFAULTS = Object.freeze({
    maxPayload: 64 * 1024,
    maxBackpressure: 1024 * 1024,
    onBackpressureLimit: 'close',
    idleTimeout: 120,
    compression: false,
    messageRate: null,
    maxTopicsPerSocket: 1024,
    origins: null,
    protocols: null,
});

const HANDLERS = ['upgrade', 'open', 'message', 'drain', 'close'];
// Route options passed through to the upgrade request's route (hooks, limits).
const ROUTE_OPTIONS = ['rateLimit', 'onRequest', 'preValidation', 'preHandler', 'onSend', 'onResponse', 'config', 'schema'];
const KNOWN = new Set([...Object.keys(DEFAULTS), ...HANDLERS, ...ROUTE_OPTIONS]);

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ORIGIN_RE = /^(https?):\/\/([^/?#\s@]+)$/i;

/** "scheme://host[:port]", lowercased, default port dropped. null if not an origin. */
function normalizeOrigin(o) {
    const m = ORIGIN_RE.exec(o);
    if (m === null) return null;
    const scheme = m[1].toLowerCase();
    let host = m[2].toLowerCase();
    if (validHost(host) === null) return null;
    if ((scheme === 'http' && host.endsWith(':80')) || (scheme === 'https' && host.endsWith(':443'))) {
        host = host.slice(0, host.lastIndexOf(':'));
    }
    return `${scheme}://${host}`;
}

function originsOption(v, path) {
    if (v === null || v === undefined) return null;          // same origin
    if (v === '*') return '*';
    if (!Array.isArray(v)) throw new TypeError(`ws ${path}: origins must be '*' or an array of origins`);
    const set = new Set();
    for (const o of v) {
        const n = typeof o === 'string' ? normalizeOrigin(o) : null;
        if (n === null) throw new TypeError(`ws ${path}: "${o}" is not an origin (scheme://host[:port], no path)`);
        set.add(n);
    }
    return set;
}

function protocolsOption(v, path) {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !TOKEN_RE.test(p))) {
        throw new TypeError(`ws ${path}: protocols must be an array of tokens`);
    }
    return new Set(v);
}

function count(name, path, v, { min = 0 } = {}) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
        throw new TypeError(`ws ${path}: ${name} must be a number ≥ ${min} (got ${v})`);
    }
    return v;
}

/** Validate app.ws() options and fill in the defaults (spec §3.2). */
export function normalizeWsOptions(opts, path) {
    if (opts === null || typeof opts !== 'object') throw new TypeError(`ws ${path}: options must be an object`);
    for (const k of Object.keys(opts)) {
        if (!KNOWN.has(k)) throw new TypeError(`ws ${path}: unknown option "${k}"`);
    }
    const o = { ...DEFAULTS, ...opts };
    for (const h of HANDLERS) {
        if (o[h] !== undefined && typeof o[h] !== 'function') throw new TypeError(`ws ${path}: ${h} must be a function`);
    }
    const cfg = {
        maxPayload: count('maxPayload', path, o.maxPayload, { min: 1 }),
        maxBackpressure: count('maxBackpressure', path, o.maxBackpressure, { min: 1 }),
        dropOnLimit: false,
        idleTimeoutMs: count('idleTimeout', path, o.idleTimeout) * 1000,
        compression: !!o.compression,
        rateMax: 0,
        rateWindowMs: 0,
        maxTopics: count('maxTopicsPerSocket', path, o.maxTopicsPerSocket, { min: 1 }),
        origins: originsOption(o.origins, path),
        protocols: protocolsOption(o.protocols, path),
        upgrade: o.upgrade ?? null,
        open: o.open ?? null,
        message: o.message ?? null,
        drain: o.drain ?? null,
        close: o.close ?? null,
        configId: 0,
    };
    if (o.onBackpressureLimit !== 'close' && o.onBackpressureLimit !== 'drop') {
        throw new TypeError(`ws ${path}: onBackpressureLimit must be 'close' or 'drop'`);
    }
    cfg.dropOnLimit = o.onBackpressureLimit === 'drop';
    if (o.messageRate !== null && o.messageRate !== undefined) {
        const r = o.messageRate;
        if (typeof r !== 'object') throw new TypeError(`ws ${path}: messageRate must be { max, windowMs }`);
        cfg.rateMax = count('messageRate.max', path, r.max, { min: 1 });
        cfg.rateWindowMs = count('messageRate.windowMs', path, r.windowMs, { min: 1 });
    }
    return cfg;
}

function logError(app, err, msg) {
    if (app._loggerConfigured) app.logger.error({ err }, msg);
    else console.error(`[kidlat] websocket: ${msg}\n`, err);
}

/** One per connection, fixed shape. Treat data/params/query/ip/protocol as read-only. */
export class WebSocket {
    constructor(app, connId, route, data, params, query, ip, protocol) {
        this.data = data;
        this.params = params;
        this.query = query;
        this.ip = ip;
        this.protocol = protocol;
        this._app = app;
        this._id = connId;
        this._route = route;
        this._open = false;
        this._closed = false;
    }

    get isOpen() { return this._open && !this._closed; }

    get bufferedAmount() { return this._closed ? 0 : native.wsBuffered(this._id); }

    /** 1 sent, 0 buffered (client is behind), -1 refused (closed or over the limit). */
    send(data, isBinary = typeof data !== 'string') {
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) data = toBytes(data);
        if (this._closed) return -1;
        return native.wsSend(this._id, data, isBinary);
    }

    /** true if newly subscribed, false if already (or closed). */
    subscribe(topic) {
        checkTopic(topic);
        if (this._closed) return false;
        const r = native.wsSubscribe(this._app._sid, this._id, topic);
        if (r === -1) throw new RangeError(`a socket can subscribe to at most ${this._route.maxTopics} topics`);
        return r === 1;
    }

    unsubscribe(topic) {
        checkTopic(topic);
        return this._closed ? false : native.wsUnsubscribe(this._app._sid, this._id, topic);
    }

    isSubscribed(topic) {
        checkTopic(topic);
        return this._closed ? false : native.wsIsSubscribed(this._app._sid, this._id, topic);
    }

    get topics() { return this._closed ? [] : native.wsTopics(this._app._sid, this._id); }

    /** To every subscriber of `topic` except this socket; returns how many were reached. */
    publish(topic, data, isBinary = typeof data !== 'string') {
        checkTopic(topic);
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) data = toBytes(data);
        const n = this._closed ? 0 : native.wsPublish(this._app._sid, topic, data, isBinary, this._id);
        notifyBroker(this._app, topic, data, isBinary);
        return n;
    }

    close(code = 1000, reason = '') {
        if (!validCloseCode(code)) {
            throw new TypeError(`close code must be 1000–1003, 1007–1014 or 3000–4999 (got ${code})`);
        }
        if (typeof reason !== 'string') throw new TypeError('close reason must be a string');
        if (Buffer.byteLength(reason) > 123) throw new RangeError('close reason must be at most 123 bytes of UTF-8');
        if (this._closed) return;
        native.wsClose(this._id, code, reason);
    }

    terminate() {
        if (this._closed) return;
        native.wsTerminate(this._id);
    }
}

// Codes an endpoint may send (RFC 6455 §7.4): 1004–1006 and 1015 are reserved.
const validCloseCode = (c) => Number.isInteger(c) &&
    ((c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999));

function checkTopic(topic) {
    if (typeof topic !== 'string' || topic.length === 0 || Buffer.byteLength(topic) > 256) {
        throw new TypeError('a topic must be a non-empty string of at most 256 bytes');
    }
}

function notifyBroker(app, topic, data, isBinary) {
    const fn = app._wsOnPublish;
    if (fn === null) return;
    try {
        const r = fn(topic, data, isBinary);
        if (r !== undefined && isThenable(r)) r.then(undefined, (err) => logError(app, err, 'onPublish hook failed'));
    } catch (err) {
        logError(app, err, 'onPublish hook failed');
    }
}

/** app.publish / app.publishLocal: every subscriber of `topic` in this process. */
export function publish(app, topic, data, isBinary, broker) {
    checkTopic(topic);
    if (isBinary === undefined) isBinary = typeof data !== 'string';
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) data = toBytes(data);
    const n = app._sid === 0 ? 0 : native.wsPublish(app._sid, topic, data, isBinary, -1);
    if (broker) notifyBroker(app, topic, data, isBinary);
    return n;
}

function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('send() takes a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

function fail(ws, err, what) {
    logError(ws._app, err, `${what} handler failed`);
    ws.close(1011);
}

function call(ws, fn, what, a, b) {
    try {
        const r = fn(ws, a, b);
        if (r !== undefined && isThenable(r)) r.then(undefined, (err) => fail(ws, err, what));
    } catch (err) {
        fail(ws, err, what);
    }
}

/** Native → JS callbacks for one server. They never throw. */
export function wsCallbacks(app) {
    return [
        function onOpen(ws) {
            ws._open = true;
            const fn = ws._route.open;
            if (fn !== null) call(ws, fn, 'open');
        },
        function onMessage(ws, data, isBinary) {
            const fn = ws._route.message;
            if (fn !== null) call(ws, fn, 'message', data, isBinary);
        },
        function onDrain(ws) {
            const fn = ws._route.drain;
            if (fn !== null) call(ws, fn, 'drain');
        },
        function onClose(ws, code, reason) {
            ws._closed = true;
            const fn = ws._route.close;
            if (fn === null) return;
            try {
                const r = fn(ws, code, reason);
                if (r !== undefined && isThenable(r)) r.then(undefined, (err) => logError(app, err, 'close handler failed'));
            } catch (err) {
                logError(app, err, 'close handler failed');
            }
        },
    ];
}

/** The origin this request was made to, as a browser would write it. */
function ownOrigin(req) {
    let host = null;
    if (peerTrusted(req.server._trust, req.socketIp)) {
        const fwd = req.headers['x-forwarded-host'];
        if (fwd) host = validHost(lastValue(fwd));
    }
    if (host === null) host = validHost(req.headers.host);
    return host === null ? null : normalizeOrigin(`${req.protocol}://${host}`);
}

/** Cross-site WebSocket hijacking guard. No Origin = not a browser: allowed. */
function originAllowed(cfg, req) {
    const origin = req.headers.origin;
    if (origin === undefined || cfg.origins === '*') return true;
    const n = normalizeOrigin(origin);
    if (n === null) return false;
    if (cfg.origins === null) return n === ownOrigin(req);
    return cfg.origins.has(n);
}

/** First protocol the client offered that the route supports, or null. */
function pickProtocol(cfg, req) {
    if (cfg.protocols === null) return null;
    const offered = req.headers['sec-websocket-protocol'];
    if (!offered) return null;
    for (const p of offered.split(',')) {
        const t = p.trim();
        if (cfg.protocols.has(t)) return t;
    }
    return null;
}

function accept(app, cfg, req, res, data) {
    if (res.sent) return;
    const protocol = pickProtocol(cfg, req);
    const ws = new WebSocket(app, res._connId, cfg, data, req.params, req.query, req.ip, protocol);
    res.sent = true;
    res.statusCode = 101;
    // false: the client went away while upgrade() was running
    const extensions = cfg.compression ? (req.headers['sec-websocket-extensions'] ?? null) : null;
    if (!native.wsAccept(res._connId, res._seq, ws, cfg.configId, req.headers['sec-websocket-key'] ?? '', protocol, extensions)) {
        ws._closed = true;
        return;
    }
    if (app._trackResponses) app._afterResponse(req, res);
}

function upgradeHandler(app, cfg) {
    return function wsUpgrade(req, res) {
        if (!originAllowed(cfg, req)) {
            res.code(403).send('Forbidden');
            return undefined;
        }
        if (cfg.upgrade === null) {
            accept(app, cfg, req, res, undefined);
            return undefined;
        }
        const v = cfg.upgrade(req, res);
        if (v !== undefined && isThenable(v)) {
            return v.then((data) => accept(app, cfg, req, res, data));
        }
        accept(app, cfg, req, res, v);
        return undefined;
    };
}

/** app.ws(path, options) on `scope` (the app or a register() scope). */
export function addWsRoute(scope, path, opts = {}) {
    if (typeof path !== 'string') throw new TypeError('ws: path must be a string');
    const cfg = normalizeWsOptions(opts, path);
    cfg.configId = native.wsConfig(
        cfg.maxPayload, cfg.maxBackpressure, cfg.dropOnLimit, cfg.idleTimeoutMs,
        cfg.compression, cfg.rateMax, cfg.rateWindowMs, cfg.maxTopics
    );
    const routeOpts = { ws: cfg };
    for (const k of ROUTE_OPTIONS) if (opts[k] !== undefined) routeOpts[k] = opts[k];
    scope._addRoute(WS_METHOD, path, routeOpts, upgradeHandler(scope._root, cfg));
    return scope;
}
