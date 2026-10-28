/*!
 * kidlat
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

'use strict';

import fs from 'fs';
import net from 'net';
import { performance } from 'perf_hooks';

import { native } from './native.js';
import { Router, compileParams } from './router.js';
import { createLogger, isEnabled } from './logger.js';
import { KidlatRequest } from './request.js';
import { compileTrust } from './trust-proxy.js';
import { KidlatResponse } from './response.js';
import { compileRouteSchema } from './schema.js';
import { runSteps, runDirect, compose, handlerStep, validationStep, normalizeHook, isThenable } from './pipeline.js';
import { headerBlock, sanitizeHeaderValue } from './http/serialize.js';
import { httpError, statusOf } from './errors.js';
import {
    ALLOWED_METHODS, DEFAULT_BODY_LIMIT, HOOK_NAMES, STATUS_TEXT,
    END_BODY_DONE, END_BODY_ERROR, END_BODY_TIMEOUT,
} from './constants.js';
import { createCorsHook } from './plugins/cors.js';
import { createRateLimitHook, RATE_LIMIT } from './plugins/rate-limit.js';
import { securityHeaders } from './plugins/security-headers.js';
import { createSigner } from './cookies.js';
import { createMetrics } from './plugins/metrics.js';
import { installHealth } from './plugins/health.js';

export { cluster } from './cluster.js';
export { httpError } from './errors.js';

const DEFAULT_HEADERS = { 'X-Content-Type-Options': 'nosniff' };

const METHOD_NAMES = [undefined, 'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const INFO_LEN = 7 + 2 * 16;
const INLINE_BODY_MAX = 16384;

function cloneHooks(hooks) {
    const out = {};
    for (const name of HOOK_NAMES) out[name] = hooks[name].slice();
    return out;
}

function toArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function addRateLimits(hooks, option) {
    for (const o of toArray(option)) {
        const limiter = createRateLimitHook(o);
        hooks[limiter.phase].push(limiter);
        if (limiter.refund !== null) hooks.onResponse.push(limiter.refund);
    }
}

function applyRateLimit(hooks, option) {
    if (option === false) {
        for (const name of HOOK_NAMES) hooks[name] = hooks[name].filter((fn) => fn[RATE_LIMIT] !== true);
    } else if (option) {
        addRateLimits(hooks, option);
    }
}

function toPem(v) {
    if (v === undefined || v === null) return null;
    return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

export class Kidlat {
    /**
     * @param {object}  [options]
     * @param {boolean|object} [options.logger]      true, { level, stream }, or a pino-compatible logger
     * @param {number}  [options.bodyLimit]          max request body in bytes (default 1 MB)
     * @param {boolean|number|string|string[]|Function} [options.trustProxy]
     *                                               which proxies to believe about X-Forwarded-For/-Proto/-Host:
     *                                               true (the socket peer), a hop count, IPs/CIDRs, or
     *                                               (addr, hop) => boolean (see lib/trust-proxy.js)
     * @param {object}  [options.https]              { cert, key } (PEM, string or Buffer)
     * @param {object|boolean} [options.cors]
     * @param {object|boolean} [options.rateLimit]
     * @param {boolean} [options.ignoreTrailingSlash]
     * @param {object|null} [options.defaultHeaders] added to every response (default X-Content-Type-Options: nosniff)
     * @param {number}  [options.keepAliveTimeout]   idle keep-alive timeout in ms (default 30000)
     * @param {number}  [options.requestTimeout]     max ms to receive a whole request (head + body) from its first
     *                                               byte, and max ms a request may sit with no I/O while waiting for its
     *                                               response (default 120000, 0 = off). Expiry → 408.
     * @param {number}  [options.headersTimeout]     max ms to receive a request head (default 30000). Expiry → 408.
     * @param {number}  [options.maxConnections]     concurrent connection cap (default 16384)
     * @param {boolean} [options.reusePort]          SO_REUSEPORT (Linux/BSD) — set automatically by cluster()
     * @param {Function} [options.genReqId]          (req) => id
     * @param {boolean|object} [options.health]     /health + /ready endpoints (see lib/plugins/health.js)
     * @param {boolean|object} [options.metrics]    Prometheus /metrics endpoint (see lib/plugins/metrics.js)
     */
    constructor(options = {}) {
        this.options = options;
        this.bodyLimit = options.bodyLimit || DEFAULT_BODY_LIMIT;
        this._trust = compileTrust(options.trustProxy);
        this.trustProxy = this._trust !== null;
        this.httpsOptions = options.https || null;
        this.logger = createLogger(options.logger);
        this._loggerConfigured = options.logger !== undefined && options.logger !== false;
        this._logRequests = isEnabled(this.logger, 'info') && options.disableRequestLogging !== true;
        this._trackResponses = this._logRequests;

        this.middlewares = [];
        this.hooks = {};
        for (const name of HOOK_NAMES) this.hooks[name] = [];
        this.router = new Router({ ignoreTrailingSlash: !!options.ignoreTrailingSlash });
        this._root = this;
        this._routeTable = [];
        this._nativeRouterID = native.allocRouterID();
        this._Request = class extends KidlatRequest {};
        this._Response = class extends KidlatResponse {};
        this._prefix = '';
        this._schemas = new Map();
        this._errorHandler = null;
        this._notFoundHandler = null;
        this._notFoundSteps = null;

        this._sid = 0;
        this._port = null;
        this._closing = null;
        this._draining = false;
        this._inflight = new Map();
        this._streams = new Map();

        this._reqCounter = 0;
        this._lastRes = null;
        if (typeof options.genReqId === 'function') this._genReqId = options.genReqId;

        const defaults = {
            ...(options.securityHeaders ? securityHeaders(options.securityHeaders) : null),
            ...(options.defaultHeaders === undefined ? DEFAULT_HEADERS : options.defaultHeaders),
        };
        this._defaultHeaderBlock = headerBlock(defaults);
        this._defaultHeaderList = Object.keys(defaults).map(
            (k) => [k.toLowerCase(), `${k}: ${sanitizeHeaderValue(defaults[k])}\r\n`]
        );
        this._defaultHeaderKeys = new Set(this._defaultHeaderList.map(([k]) => k));

        if (options.health) installHealth(this, options.health);
        this.metrics = null;
        if (options.metrics) {
            this.metrics = createMetrics(this, options.metrics);
            this.metrics.install();
        }
        if (options.cors)      this.hooks.onRequest.push(createCorsHook(options.cors));
        if (options.rateLimit) addRateLimits(this.hooks, options.rateLimit);
        if (this.hooks.onResponse.length !== 0) this._trackResponses = true;

        this._cookieSigner = options.cookies?.secret !== undefined ? createSigner(options.cookies.secret) : null;
    }

    _genReqId() {
        return 'req-' + (++this._root._reqCounter).toString(36);
    }

    /* Configuration */
    use(middleware) {
        if (typeof middleware !== 'function') throw new TypeError('Middleware must be a function');
        this.middlewares.push(middleware);
        return this;
    }

    addHook(name, fn) {
        if (!this.hooks[name]) throw new Error(`Unknown hook: ${name}`);
        if (typeof fn !== 'function') throw new TypeError(`Hook ${name} must be a function`);
        this.hooks[name].push(name === 'onSend' || name === 'onResponse' ? fn : normalizeHook(fn));
        if (name === 'onResponse') this._root._trackResponses = true;
        this._root._notFoundSteps = null;
        return this;
    }

    setErrorHandler(fn) { this._errorHandler = fn; return this; }

    setNotFoundHandler(fn) {
        this._notFoundHandler = fn;
        this._root._notFoundSteps = null;
        return this;
    }

    // Register a schema so routes can $ref it by its $id
    addSchema(schema) {
        if (!schema || typeof schema.$id !== 'string') throw new Error('addSchema: schema must have a string $id');
        if (this._schemas.has(schema.$id)) throw new Error(`Schema "${schema.$id}" is already registered`);
        this._schemas.set(schema.$id, schema);
        return this;
    }

    async register(plugin, options = {}) {
        if (plugin && typeof plugin === 'object' && typeof plugin.default === 'function') plugin = plugin.default;
        const child = Object.create(this);
        child.middlewares   = this.middlewares.slice();
        child.hooks         = cloneHooks(this.hooks);
        child._prefix       = this._prefix + (options.prefix || '');
        applyRateLimit(child.hooks, options.rateLimit);
        await plugin(child, options);
        return this;
    }

    decorate(name, value) {
        if (name in this) throw new Error(`Decorator '${name}' already exists`);
        this[name] = value;
        return this;
    }

    decorateRequest(name, value) {
        const proto = this._root._Request.prototype;
        if (name in proto) throw new Error(`Request decorator '${name}' already exists`);
        proto[name] = value;
        return this;
    }

    decorateResponse(name, value) {
        const proto = this._root._Response.prototype;
        if (name in proto) throw new Error(`Response decorator '${name}' already exists`);
        proto[name] = value;
        return this;
    }

    /* Routing */

    route(opts) {
        const methods = toArray(opts.method);
        const path = opts.url ?? opts.path;
        for (const m of methods) this._addRoute(m.toUpperCase(), path, opts, opts.handler);
        return this;
    }

    _addRoute(method, path, opts, handler) {
        if (typeof opts === 'function') { handler = opts; opts = {}; }
        opts = opts || {};
        if (handler === undefined) handler = opts.handler;
        if (typeof handler !== 'function') throw new TypeError(`Handler for ${method} ${path} must be a function`);

        const fullPath = this._prefix + path;
        const { validators, serializers } = compileRouteSchema(opts.schema, this._schemas);
        const hooks = cloneHooks(this.hooks);
        applyRateLimit(hooks, opts.rateLimit);
        for (const name of HOOK_NAMES) {
            for (const fn of toArray(opts[name])) {
                hooks[name].push(name === 'onSend' || name === 'onResponse' ? fn : normalizeHook(fn));
            }
        }
        if (hooks.onResponse.length !== 0) this._root._trackResponses = true;

        const bodyLimit = opts.bodyLimit ?? this._root.bodyLimit;
        if (typeof bodyLimit !== 'number' || !(bodyLimit >= 0)) {
            throw new TypeError(`bodyLimit for ${method} ${path} must be a number of bytes (0 or more)`);
        }

        const route = {
            method,
            path: fullPath,
            bodyLimit,
            config: opts.config || {},
            scope: this,
            hooks,
            serializers,
            paramNames: [],
            steps: null,
            _direct: false,
            _handler: null,
        };
        const steps = [...hooks.onRequest, ...hooks.preValidation];
        if (validators) steps.push(validationStep(validators));
        steps.push(...hooks.preHandler, compose(this.middlewares.slice(), handlerStep(handler)));
        route.steps = steps;

        const noHooks = hooks.onRequest.length === 0 && hooks.preValidation.length === 0 &&
            hooks.preHandler.length === 0 && hooks.onSend.length === 0;
        if (noHooks && !validators && this.middlewares.length === 0) {
            route._direct = true;
            route._handler = handler;
        }

        const registered = this.router.on(method, fullPath, route);

        const routeIndex = this._root._routeTable.length;
        this._root._routeTable.push(route);
        route._routeIndex = routeIndex;
        native.addRoute(this._root._nativeRouterID, method, registered, routeIndex);

        return this;
    }

    get(path, a, b) { return this._addRoute('GET', path, a, b); }
    post(path, a, b) { return this._addRoute('POST', path, a, b); }
    put(path, a, b) { return this._addRoute('PUT', path, a, b); }
    patch(path, a, b) { return this._addRoute('PATCH', path, a, b); }
    delete(path, a, b) { return this._addRoute('DELETE', path, a, b); }
    head(path, a, b) { return this._addRoute('HEAD', path, a, b); }
    options(path, a, b) { return this._addRoute('OPTIONS', path, a, b); }
    all(path, a, b) {
        for (const m of ALLOWED_METHODS) this._addRoute(m, path, a, b);
        return this;
    }

    printRoutes() {
        return this.router.routes.map((r) => `${r.method.padEnd(7)} ${r.path}`).join('\n');
    }

    /* Request pipeline */

    _onRequest(info, url, rawHeaders, conn, connId, methodArg, inlineBody) {
        const seq = info[1] >>> 0;
        try {
            this._dispatch(info, seq, url, rawHeaders, conn, connId, methodArg, inlineBody);
        } catch (err) {
            this._dispatchFailed(err, connId, seq);
        }
        this._lastRes = null;   // don't keep the last request alive
    }

    _dispatchFailed(err, connId, seq) {
        const res = this._lastRes;
        if (res !== null && res._connId === connId && res._seq === seq) {
            if (res.sent) return;
            try {
                this._handleError(err, res.request, res);
                if (res.sent) return;
            } catch { /* fall through to the bare answer */ }
        }
        console.error('[kidlat] request setup failed:\n', err);
        native.respond(connId, seq, 500, 1, STATUS_TEXT[500], 1);
    }

    _dispatch(info, seq, url, rawHeaders, conn, connId, methodArg, inlineBody) {
        const code = info[0];
        const method = code !== 0 ? METHOD_NAMES[code] : methodArg;
        const flags = info[2];
        let contentLength = info[3] === 0x7fffffff ? Infinity : info[3];
        const routeIdx = info[4];
        const pathEnd = info[5];
        let values = null;
        if (routeIdx >= 0) {
            const n = info[6];
            if (n !== 0) {
                values = new Array(n);
                for (let i = 0; i < n; i++) values[i] = url.slice(info[7 + 2 * i], info[8 + 2 * i]);
            }
        }

        let path = url;
        let query = '';
        if (pathEnd !== url.length) {
            path = url.slice(0, pathEnd);
            query = url.slice(pathEnd + 1);
        }

        let route = null;
        if (routeIdx >= 0) {
            route = this._routeTable[routeIdx];
        } else {
            const router = this.router;
            route = router.find(method, path);
            if (route === null && method === 'HEAD') route = router.find('GET', path);
            if (route !== null) values = router.values;
        }
        const ip = conn.ip;
        const inline = (flags & 4) !== 0;
        if (inline) contentLength = inlineBody.length;

        const close = (flags & 1) !== 0 || this._closing !== null;
        const hooks = route !== null ? route.hooks : this.hooks;

        const req = new this._Request(this, method, url, path, query, rawHeaders, ip, connId, contentLength);
        if ((flags & 2) !== 0) req.httpVersion = '1.0';
        const res = new this._Response(this, req, connId, seq, close, route, hooks);
        req._res = res;
        this._lastRes = res;

        if (this._logRequests) {
            req._start = performance.now();
            req.log.info({ req: { method, url, remoteAddress: ip } }, 'incoming request');
        }

        if (contentLength !== 0) {
            const limit = route !== null ? route.bodyLimit : this.bodyLimit;
            if (contentLength > limit) {
                req._fail(httpError(413, 'Payload Too Large'));
                res._close = true;
                res.code(413).send('Payload Too Large');
                return;
            }
            if (inline) req._setInline(inlineBody, (flags & 8) !== 0);
            else this._inflight.set(connId, req);
        }

        if (route === null) {
            req.params = {};
            runSteps(this, this._notFoundSteps || this._buildNotFoundSteps(), 0, req, res);
            return;
        }

        if (route.paramNames.length !== 0) {
            try {
                req.params = (route._params ??= compileParams(route.paramNames))(values);
            } catch {
                res.code(400).send('Bad Request');
                return;
            }
        } else {
            req.params = {};
        }
        if (route._direct) runDirect(this, route._handler, req, res);
        else runSteps(this, route.steps, 0, req, res);
    }

    _buildNotFoundSteps() {
        const notFound = this._notFoundHandler
            ? handlerStep(this._notFoundHandler)
            : (req, res) => {
                if (!ALLOWED_METHODS.has(req.method)) res.code(405).send('Method Not Allowed');
                else res.code(404).send('Not Found');
            };
        return (this._notFoundSteps = [...this.hooks.onRequest, notFound]);
    }

    _onData(connId, chunk) {
        const req = this._inflight.get(connId);
        if (req !== undefined && !req._push(chunk)) this._inflight.delete(connId);
    }

    _onEnd(connId, kind) {
        const req = this._inflight.get(connId);
        if (req !== undefined) this._inflight.delete(connId);

        if (kind === END_BODY_DONE) {
            if (req !== undefined) req._complete();
            return;
        }
        if (kind === END_BODY_ERROR || kind === END_BODY_TIMEOUT) {
            const status = kind === END_BODY_TIMEOUT ? 408 : 400;
            if (req !== undefined) {
                req._res._close = true;
                req._fail(httpError(status));
                if (!req._res.sent) req._res.code(status).send(STATUS_TEXT[status]);
            }
            return;
        }
        // END_ABORTED: the client went away
        if (req !== undefined) {
            req.aborted = true;
            req._fail(httpError(400, 'Request aborted', { code: 'ECONNRESET' }));
        }
        const streams = this._streams.get(connId);
        if (streams !== undefined) {
            this._streams.delete(connId);
            for (const ctl of streams) ctl.abort();
        }
    }

    _onDrain(connId) {
        const streams = this._streams.get(connId);
        if (streams !== undefined) for (const ctl of streams) ctl.resume();
    }

    _pipe(res, source, raw = false) {
        const connId = res._connId;
        const seq = res._seq;
        const req = res.request;
        let done = false;

        let set = this._streams.get(connId);
        if (set === undefined) this._streams.set(connId, set = new Set());
        const ctl = { resume: null, abort: null };
        set.add(ctl);

        const stop = () => {
            if (done) return false;
            done = true;
            set.delete(ctl);
            if (set.size === 0 && this._streams.get(connId) === set) this._streams.delete(connId);
            return true;
        };
        const finish = (ok) => {
            if (!stop()) return;
            if (ok) native.streamEnd(connId, seq, res._close, raw);
            else native.abort(connId);
            if (this._trackResponses) this._afterResponse(req, res);
        };

        if (typeof source.pipe === 'function' && typeof source.on === 'function') {
            ctl.resume = () => source.resume();
            ctl.abort = () => { stop(); source.destroy(); };
            source.on('data', (chunk) => {
                const r = native.streamWrite(connId, seq, chunk, raw);
                if (r === 1) source.pause();
                else if (r === -1) { stop(); source.destroy(); } // connection gone
            });
            source.on('end', () => finish(true));
            source.on('error', (err) => {
                req.log.error({ err }, 'response stream failed');
                finish(false);
            });
            source.on('close', () => finish(false));
            return;
        }

        let wake = null;
        ctl.resume = () => { if (wake) { const w = wake; wake = null; w(); } };
        ctl.abort = () => { stop(); ctl.resume(); };
        (async () => {
            const iterable = typeof source.getReader === 'function' && !source[Symbol.asyncIterator]
                ? readerIterable(source)
                : source;
            try {
                for await (const chunk of iterable) {
                    if (done) break;
                    const r = native.streamWrite(connId, seq, chunk, raw);
                    if (r === -1) { stop(); break; } // connection gone
                    if (r === 1) await new Promise((resolve) => { wake = resolve; });
                }
                finish(true);
            } catch (err) {
                req.log.error({ err }, 'response stream failed');
                finish(false);
            }
        })();
    }

    _afterResponse(req, res) {
        if (this._logRequests) {
            req.log.info({
                res: { statusCode: res.statusCode },
                responseTime: req._start !== undefined ? +(performance.now() - req._start).toFixed(3) : undefined,
            }, 'request completed');
        }
        const hooks = res._hooks.onResponse;
        for (let i = 0; i < hooks.length; i++) {
            try {
                const r = hooks[i](req, res);
                if (isThenable(r)) r.catch((err) => this._logError(err, req, 'onResponse hook failed'));
            } catch (err) {
                this._logError(err, req, 'onResponse hook failed');
            }
        }
    }

    _handleError(err, req, res) {
        if (res.sent) {
            if (statusOf(err) >= 500) this._logError(err, req, 'error after response was sent');
            return;
        }
        const scope = res._route !== null ? res._route.scope : this;
        const handler = scope._errorHandler;
        if (typeof handler !== 'function') return this._defaultError(err, req, res);

        let r;
        try {
            r = handler.call(scope, err, req, res);
        } catch (e) {
            return this._defaultError(e, req, res);
        }
        if (isThenable(r)) {
            r.then(
                () => { if (!res.sent) this._defaultError(err, req, res); },
                (e) => this._defaultError(e, req, res)
            );
        } else if (!res.sent) {
            this._defaultError(err, req, res);
        }
    }

    _defaultError(err, req, res) {
        if (res.sent) return;
        const status = statusOf(err);
        if (status >= 500) this._logError(err, req, 'request failed');
        res.removeHeader('content-type');
        res._statusSet = false;
        res.statusCode = status;
        res.send(status >= 500 ? STATUS_TEXT[status] : (err.message || STATUS_TEXT[status]));
    }

    _logError(err, req, msg) {
        if (this._loggerConfigured) {
            if (isEnabled(this.logger, 'error')) req.log.error({ err }, msg);
        } else {
            console.error(`[kidlat] ${req.method} ${req.url}: ${msg}\n`, err);
        }
    }

    /* Server */

    /**
     * listen(port?, host?, callback?) or listen({ port, host }, callback?)
     * Binds synchronously and returns the bound port (handy with port 0).
     * Throws (e.g. err.code === 'EADDRINUSE') if the port can't be bound.
     */
    listen(port, host, callback) {
        if (port !== null && typeof port === 'object') {
            callback = host;
            ({ port, host } = port);
        }
        if (typeof port === 'function') { callback = port; port = undefined; }
        if (typeof host === 'function') { callback = host; host = undefined; }
        if (port === undefined || port === null) port = 3000;
        port = Number(port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new RangeError(`Port must be an integer between 0 and 65535 (got ${port})`);
        }
        if (host === 'localhost') host = '127.0.0.1';
        if (host && net.isIP(host) === 0) {
            throw new TypeError(`listen: host must be an IP address or "localhost" (got "${host}")`);
        }
        if (this._root._sid !== 0) throw new Error('Kidlat is already listening');

        const root = this._root;
        const https = root.httpsOptions;
        const cert = https ? toPem(https.cert) : null;
        const key = https ? toPem(https.key) : null;
        if (https && (!cert || !key)) throw new Error('Kidlat HTTPS requires both options.https.cert and options.https.key');

        const o = root.options;
        const info = new Int32Array(INFO_LEN);
        root._sid = native.createServer(
            root._onRequest.bind(root, info),
            root._onData.bind(root),
            root._onEnd.bind(root),
            root._onDrain.bind(root),
            info
        );
        native.configure(
            root._sid, root._nativeRouterID, !!o.ignoreTrailingSlash,
            Math.min(INLINE_BODY_MAX, root.bodyLimit), root._defaultHeaderBlock
        );
        try {
            root._port = native.listen(
                root._sid, port, host || null, o.backlog ?? 511,
                !!(o.reusePort ?? process.env.KIDLAT_REUSE_PORT === '1'),
                o.maxConnections ?? 0,
                o.keepAliveTimeout ?? o.connectionTimeout ?? -1,
                o.requestTimeout ?? -1,
                o.headersTimeout ?? -1,
                cert, key
            );
        } catch (err) {
            root._sid = 0;
            throw err;
        }
        warnIfOpenFileLimitLow(root, o.maxConnections ?? 16384);
        if (callback) callback(root._port);
        return root._port;
    }

    address() {
        return this._root._port === null ? null : { port: this._root._port };
    }

    get server() { return this._root; }

    /**
     * Shut down cleanly on SIGTERM / SIGINT (or when the returned function is
     * called): /ready starts answering 503 and responses say Connection:
     * close, then after `drainDelay` ms (time for the load balancer to notice)
     * the server stops accepting, in-flight requests finish, `onShutdown()`
     * runs (close your database here) and the process exits. A second signal
     * exits immediately.
     *
     * @param {object}   [opts]
     * @param {string[]} [opts.signals]     default ['SIGTERM', 'SIGINT']
     * @param {number}   [opts.drainDelay]  ms between "not ready" and closing (default 0)
     * @param {number}   [opts.timeout]     ms to wait for in-flight requests (default 30000)
     * @param {Function} [opts.onShutdown]  async cleanup after the server has closed
     * @param {boolean}  [opts.exit]        call process.exit() at the end (default true)
     * @returns {(reason?: string) => Promise<void>} trigger a shutdown by hand
     */
    enableGracefulShutdown(opts = {}) {
        const root = this._root;
        const {
            signals = ['SIGTERM', 'SIGINT'], drainDelay = 0, timeout = 30000, onShutdown, exit = true,
        } = opts;
        let started = null;

        const shutdown = (reason = 'shutdown') => {
            if (started) return started;
            started = (async () => {
                root._draining = true;
                if (isEnabled(root.logger, 'info')) root.logger.info({ reason, drainDelay }, 'shutting down');
                if (drainDelay > 0) await new Promise((r) => setTimeout(r, drainDelay));
                let timer;
                const outcome = await Promise.race([
                    root.close().then(() => 'closed'),
                    new Promise((r) => { timer = timeout > 0 ? setTimeout(() => r('timeout'), timeout) : null; }),
                ]);
                clearTimeout(timer);
                if (outcome === 'timeout') root._logShutdownTimeout(timeout);
                try {
                    if (onShutdown) await onShutdown();
                } catch (err) {
                    console.error('[kidlat] onShutdown failed:', err);
                }
                if (exit) process.exit(outcome === 'closed' ? 0 : 1);
            })();
            return started;
        };

        for (const sig of signals) {
            process.on(sig, () => {
                if (started) process.exit(1);   // second signal: stop now
                shutdown(sig);
            });
        }
        return shutdown;
    }

    _logShutdownTimeout(ms) {
        const msg = `requests still in flight after ${ms} ms; exiting anyway`;
        if (this._loggerConfigured) this.logger.warn({ timeout: ms }, msg);
        else console.warn(`[kidlat] ${msg}`);
    }

    close(callback) {
        const root = this._root;
        if (root._closing === null) {
            root._closing = new Promise((resolve) => {
                if (root._sid === 0 || !native.close(root._sid, () => resolve())) resolve();
            });
        }
        if (callback) root._closing.then(() => callback());
        return root._closing;
    }
}

async function* readerIterable(stream) {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

function openFileLimit() {
    if (process.platform !== 'linux') return null;
    try {
        const m = /^Max open files\s+(\d+|unlimited)/m.exec(fs.readFileSync('/proc/self/limits', 'utf8'));
        return m && m[1] !== 'unlimited' ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

export function warnIfOpenFileLimitLow(app, maxConnections, limit = openFileLimit()) {
    const headroom = 64;
    if (limit === null || maxConnections + headroom <= limit) return false;
    const msg = `maxConnections is ${maxConnections} but the open-file limit is ${limit}: ` +
        `the server can only hold about ${Math.max(0, limit - headroom)} connections. ` +
        'Raise it (ulimit -n / systemd LimitNOFILE / Docker --ulimit nofile) or lower maxConnections.';
    if (app._loggerConfigured) app.logger.warn({ maxConnections, openFileLimit: limit }, msg);
    else console.warn(`[kidlat] ${msg}`);
    return true;
}
