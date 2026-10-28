/*!
 * kidlat - cookies: parse Cookie, build Set-Cookie, sign and verify values
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import crypto from 'crypto';
import { isToken, hasControlChar } from './http/serialize.js';

const SIGNED_PREFIX = 's:';
const MIN_SECRET_LENGTH = 32;
const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' };

function decodeValue(s) {
    if (s.length > 1 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34) s = s.slice(1, -1); // "quoted"
    if (s.indexOf('%') === -1) return s;
    try { return decodeURIComponent(s); } catch { return s; }
}

export function parseCookies(header) {
    const out = Object.create(null);
    if (!header) return out;
    let i = 0;
    const n = header.length;
    while (i < n) {
        let end = header.indexOf(';', i);
        if (end === -1) end = n;
        const eq = header.indexOf('=', i);
        if (eq !== -1 && eq < end) {
            const name = header.slice(i, eq).trim();
            if (name !== '' && out[name] === undefined) out[name] = decodeValue(header.slice(eq + 1, end).trim());
        }
        i = end + 1;
    }
    return out;
}

function attr(name, value) {
    const s = String(value);
    if (s.indexOf(';') !== -1 || hasControlChar(s)) throw new TypeError(`cookie: invalid ${name} ${JSON.stringify(s)}`);
    return s;
}

export function serializeCookie(name, value, options, secureDefault, signer) {
    if (!isToken(name)) throw new TypeError(`cookie: invalid name ${JSON.stringify(name)}`);
    const o = options || {};
    let v = value === undefined || value === null ? '' : String(value);
    if (o.signed) {
        if (signer === null) throw new TypeError('cookie: signed cookies need new Kidlat({ cookies: { secret } })');
        v = signer.sign(name, v);
    }
    const secure = o.secure ?? secureDefault;
    const path = o.path === undefined ? '/' : attr('path', o.path);
    const sameSite = o.sameSite === undefined ? 'Lax' : o.sameSite === false ? null : SAME_SITE[String(o.sameSite).toLowerCase()];
    if (sameSite === undefined) throw new TypeError(`cookie: sameSite must be 'strict', 'lax', 'none' or false`);

    if (sameSite === 'None' && !secure) throw new TypeError('cookie: sameSite none requires secure');
    if (name.startsWith('__Secure-') && !secure) throw new TypeError('cookie: __Secure- cookies require secure');
    if (name.startsWith('__Host-') && (!secure || path !== '/' || o.domain !== undefined)) {
        throw new TypeError('cookie: __Host- cookies require secure, path "/" and no domain');
    }

    let out = name + '=' + encodeURIComponent(v);
    if (o.maxAge !== undefined) {
        const s = Math.floor(Number(o.maxAge));
        if (!Number.isFinite(s)) throw new TypeError('cookie: maxAge must be a number of seconds');
        out += '; Max-Age=' + s;
    }
    if (o.expires !== undefined) {
        if (!(o.expires instanceof Date) || Number.isNaN(o.expires.getTime())) throw new TypeError('cookie: expires must be a valid Date');
        out += '; Expires=' + o.expires.toUTCString();
    }
    if (o.domain !== undefined) out += '; Domain=' + attr('domain', o.domain);
    out += '; Path=' + path;
    if (secure) out += '; Secure';
    if (o.httpOnly !== false) out += '; HttpOnly';
    if (sameSite !== null) out += '; SameSite=' + sameSite;
    if (o.partitioned) out += '; Partitioned';
    return out;
}

export function createSigner(secret) {
    const secrets = Array.isArray(secret) ? secret : [secret];
    if (secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || s.length < MIN_SECRET_LENGTH)) {
        throw new TypeError(`cookies.secret must be a string (or array of strings) of at least ${MIN_SECRET_LENGTH} characters`);
    }
    const mac = (key, name, value) => crypto.createHmac('sha256', key).update(name + '=' + value).digest('base64url');

    return {
        sign: (name, value) => SIGNED_PREFIX + value + '.' + mac(secrets[0], name, value),

        unsign(name, signed) {
            if (!signed.startsWith(SIGNED_PREFIX)) return undefined;
            const dot = signed.lastIndexOf('.');
            if (dot < SIGNED_PREFIX.length) return undefined;
            const value = signed.slice(SIGNED_PREFIX.length, dot);
            const given = Buffer.from(signed.slice(dot + 1));
            for (const key of secrets) {
                const expected = Buffer.from(mac(key, name, value));
                if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return value;
            }
            return undefined;
        },
    };
}
