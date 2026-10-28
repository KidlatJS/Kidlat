/*!
 * kidlat - fixed-window rate limiter (onRequest hook)
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { unmapIPv4 } from '../trust-proxy.js';

const CLOCK_MS = 10;
const REMAINING_CACHE_MAX = 100_000;

export const RATE_LIMIT = Symbol('kidlat.rateLimit');

export function ipv6Prefix(addr, bits) {
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);
    let groups;
    const dbl = addr.indexOf('::');
    if (dbl === -1) {
        groups = addr.split(':');
    } else {
        const head = dbl === 0 ? [] : addr.slice(0, dbl).split(':');
        const tail = dbl + 2 === addr.length ? [] : addr.slice(dbl + 2).split(':');
        groups = head.concat(new Array(8 - head.length - tail.length).fill('0'), tail);
    }
    const out = [];
    let left = bits;
    for (let i = 0; i < 8 && left > 0; i++, left -= 16) {
        const g = parseInt(groups[i], 16) || 0;
        out.push((left >= 16 ? g : g & (0xffff << (16 - left)) & 0xffff).toString(16));
    }
    return out.join(':') + '::/' + bits;
}

export function createRateLimitHook(options) {
    const o = options === true ? {} : options;
    const max = o.max || 100;
    const window = o.window || 60_000;
    const subnet = o.ipv6Subnet === undefined ? 64 : o.ipv6Subnet;
    if (!Number.isInteger(subnet) || subnet < 1 || subnet > 128) {
        throw new TypeError('rateLimit.ipv6Subnet must be an integer from 1 to 128');
    }
    const phase = o.hook ?? 'onRequest';
    if (phase !== 'onRequest' && phase !== 'preHandler') {
        throw new TypeError("rateLimit.hook must be 'onRequest' or 'preHandler'");
    }
    const allow = new Set(o.allowList || []);
    const prefixes = new Map();
    const keyOf = typeof o.keyGenerator === 'function' ? o.keyGenerator : (req) => {
        const ip = req.ip;
        if (!ip) return 'unknown';
        if (allow.has(ip)) return ip;
        const addr = unmapIPv4(ip);
        if (subnet === 128 || addr.indexOf(':') === -1) return addr;
        let key = prefixes.get(addr);
        if (key === undefined) {
            if (prefixes.size >= 10_000) prefixes.clear();
            prefixes.set(addr, key = ipv6Prefix(addr, subnet));
        }
        return key;
    };
    const limit = String(max);
    const retryAfter = String(Math.ceil(window / 1000));
    const maxKeys = o.maxKeys > 0 ? o.maxKeys : 100_000;
    const store = new Map(); // insertion order = oldest window first

    const purge = (now) => {
        for (const [k, v] of store) if (now >= v.resetAt) store.delete(k);
    };
    setInterval(() => purge(Date.now()), window).unref();

    let clock = Date.now();
    setInterval(() => { clock = Date.now(); }, CLOCK_MS).unref();

    const remaining = Number.isInteger(max) && max > 0 && max <= REMAINING_CACHE_MAX ? new Array(max + 1) : null;
    const remainingStr = (n) => {
        if (remaining === null) return String(n);
        return remaining[n] ?? (remaining[n] = String(n));
    };

    const counted = o.skipSuccessfulRequests ? new WeakMap() : null;

    function rateLimit(req, res) {
        const key = keyOf(req);
        if (allow.has(key)) return;
        const now = clock;
        let entry = store.get(key);
        if (entry === undefined || now >= entry.resetAt) {
            if (entry !== undefined) store.delete(key);
            else if (store.size >= maxKeys) {
                purge(now);
                if (store.size >= maxKeys) store.delete(store.keys().next().value);
            }
            entry = { count: 0, resetAt: now + window, resetHeader: String(Math.ceil((now + window) / 1000)) };
            store.set(key, entry);
        }
        entry.count++;
        if (counted !== null) counted.set(res, entry);
        res._trustedHeader('x-ratelimit-limit', 'X-RateLimit-Limit', limit);
        res._trustedHeader('x-ratelimit-remaining', 'X-RateLimit-Remaining', entry.count >= max ? '0' : remainingStr(max - entry.count));
        res._trustedHeader('x-ratelimit-reset', 'X-RateLimit-Reset', entry.resetHeader);
        if (entry.count > max) {
            res._trustedHeader('retry-after', 'Retry-After', retryAfter);
            res.code(429).json({ error: 'Too Many Requests' });
        }
    }

    rateLimit[RATE_LIMIT] = true;
    rateLimit.phase = phase;
    rateLimit.refund = counted === null ? null : (req, res) => {
        const entry = counted.get(res);
        if (entry !== undefined && res.statusCode < 400) entry.count--;
    };
    if (rateLimit.refund !== null) rateLimit.refund[RATE_LIMIT] = true;
    return rateLimit;
}
