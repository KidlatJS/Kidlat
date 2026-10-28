/*!
 * kidlat - CORS onRequest hook
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 *
 * origin: '*' (default) | 'https://a.com' | ['https://a.com', /\.b\.com$/] |
 *         RegExp | (origin, req) => boolean
 * A list, RegExp or function reflects the request's Origin when it is
 * allowed (and adds Vary: Origin so caches keep responses apart).
 */

import { sanitizeHeaderValue } from '../http/serialize.js';

const list = (v) => (v === undefined || v === null || v === '' ? v : sanitizeHeaderValue(Array.isArray(v) ? v.join(',') : v));

export function createCorsHook(options) {
    const o = options === true ? {} : options;
    const origin = o.origin ?? '*';
    const methods = list(o.methods) || 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
    const allowHeaders = list(o.headers ?? o.allowedHeaders) || 'Content-Type,Authorization';
    const exposed = list(o.exposedHeaders);
    const credentials = !!o.credentials;
    const maxAge = sanitizeHeaderValue(String(o.maxAge ?? 86400));

    if (origin === '*' && credentials) {
        throw new TypeError(
            "cors: origin '*' cannot be combined with credentials: true. List the allowed origins " +
            "(a string, an array, a RegExp or an (origin, req) => boolean function).");
    }

    let check = null;
    if (typeof origin === 'function') check = origin;
    else if (origin instanceof RegExp) check = (v) => origin.test(v);
    else if (Array.isArray(origin)) {
        check = (v) => origin.some((x) => (x instanceof RegExp ? x.test(v) : x === v));
    }
    const fixed = check === null ? sanitizeHeaderValue(String(origin)) : null;

    return function cors(req, res) {
        if (fixed !== null) {
            res._trustedHeader('access-control-allow-origin', 'Access-Control-Allow-Origin', fixed);
        } else {
            res._trustedHeader('vary', 'Vary', 'Origin');
            const reqOrigin = req.headers.origin;
            if (reqOrigin && check(reqOrigin, req)) res.header('Access-Control-Allow-Origin', reqOrigin);
        }
        if (credentials) res._trustedHeader('access-control-allow-credentials', 'Access-Control-Allow-Credentials', 'true');
        if (exposed) res._trustedHeader('access-control-expose-headers', 'Access-Control-Expose-Headers', exposed);
        if (req.method === 'OPTIONS') {
            res._trustedHeader('access-control-allow-methods', 'Access-Control-Allow-Methods', methods);
            res._trustedHeader('access-control-allow-headers', 'Access-Control-Allow-Headers', allowHeaders);
            res._trustedHeader('access-control-max-age', 'Access-Control-Max-Age', maxAge);
            res.code(204).send();
        }
    };
}
