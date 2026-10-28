/*!
 * kidlat - security headers for APIs (securityHeaders option)
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

const HEADERS = [
    ['contentSecurityPolicy', 'Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
    ['strictTransportSecurity', 'Strict-Transport-Security', {}],
    ['frameOptions', 'X-Frame-Options', 'DENY'],
    ['referrerPolicy', 'Referrer-Policy', 'no-referrer'],
    ['crossOriginOpenerPolicy', 'Cross-Origin-Opener-Policy', 'same-origin'],
    ['crossOriginResourcePolicy', 'Cross-Origin-Resource-Policy', 'same-origin'],
    ['permittedCrossDomainPolicies', 'X-Permitted-Cross-Domain-Policies', 'none'],
];
const KNOWN = new Set(HEADERS.map(([key]) => key));

function hsts(v) {
    if (typeof v === 'string') return v;
    const maxAge = v.maxAge ?? 31536000;
    if (!Number.isInteger(maxAge) || maxAge < 0) throw new TypeError('securityHeaders.strictTransportSecurity.maxAge must be a whole number of seconds');
    if (v.preload && (maxAge < 31536000 || v.includeSubDomains === false)) {
        throw new TypeError('securityHeaders.strictTransportSecurity: preload requires maxAge >= 31536000 and includeSubDomains');
    }
    return `max-age=${maxAge}` + (v.includeSubDomains === false ? '' : '; includeSubDomains') + (v.preload ? '; preload' : '');
}

export function securityHeaders(options) {
    const o = options === true ? {} : options;
    for (const key of Object.keys(o)) {
        if (!KNOWN.has(key)) throw new TypeError(`securityHeaders: unknown option "${key}"`);
    }
    const out = {};
    for (const [key, name, fallback] of HEADERS) {
        const v = o[key] ?? fallback;
        if (v === false) continue;
        out[name] = key === 'strictTransportSecurity' ? hsts(v) : String(v);
    }
    return out;
}
