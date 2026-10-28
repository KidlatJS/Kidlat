/*!
 * kidlat - form bodies: application/x-www-form-urlencoded (also used for query strings) and multipart/form-data
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { httpError } from './errors.js';
import { isToken, hasControlChar } from './http/serialize.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART = 'multipart/form-data';
const MAX_PART_HEADER = 8192;
const CRLF2 = Buffer.from('\r\n\r\n');
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

const DEFAULTS = {
    maxFields: 100,
    maxFieldSize: 102400,
    maxFiles: 10,
    maxFileSize: Infinity,
    allowedTypes: null,
};

function appendValue(out, key, val) {
    const prev = out[key];
    if (prev === undefined) out[key] = val;
    else if (Array.isArray(prev)) prev.push(val);
    else out[key] = [prev, val];
}

function decodeComponent(s) {
    if (s.indexOf('+') !== -1) s = s.replace(/\+/g, ' ');
    if (s.indexOf('%') === -1) return s;
    try { return decodeURIComponent(s); } catch { return s; }
}

export function parseQuery(qs) {
    const out = Object.create(null);
    if (!qs) return out;
    let i = 0;
    const n = qs.length;
    while (i < n) {
        let amp = qs.indexOf('&', i);
        if (amp === -1) amp = n;
        if (amp > i) {
            const eq = qs.indexOf('=', i);
            if (eq !== -1 && eq < amp) appendValue(out, decodeComponent(qs.slice(i, eq)), decodeComponent(qs.slice(eq + 1, amp)));
            else appendValue(out, decodeComponent(qs.slice(i, amp)), '');
        }
        i = amp + 1;
    }
    return out;
}

function parseParams(s, start, fail) {
    const out = Object.create(null);
    let i = start;
    const n = s.length;
    while (i < n) {
        while (i < n && (s[i] === ';' || s[i] === ' ' || s[i] === '\t')) i++;
        if (i >= n) break;
        const eq = s.indexOf('=', i);
        if (eq === -1) fail('malformed header parameter');
        const name = s.slice(i, eq).trim().toLowerCase();
        if (!isToken(name)) fail('malformed header parameter');
        let value;
        i = eq + 1;
        if (s[i] === '"') {
            const close = s.indexOf('"', i + 1);
            if (close === -1) fail('unterminated quoted string');
            value = s.slice(i + 1, close);
            i = close + 1;
        } else {
            let end = s.indexOf(';', i);
            if (end === -1) end = n;
            value = s.slice(i, end).trim();
            i = end;
        }
        if (out[name] !== undefined) fail('repeated header parameter');
        out[name] = value;
    }
    return out;
}

function parsePartHeaders(text, fail) {
    let disposition, type;
    for (const line of text.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0 || !isToken(line.slice(0, colon))) fail('malformed part header');
        const value = line.slice(colon + 1).trim();
        if (hasControlChar(value)) fail('malformed part header');
        const name = line.slice(0, colon).toLowerCase();
        if (name === 'content-disposition') {
            if (disposition !== undefined) fail('repeated Content-Disposition');
            disposition = value;
        } else if (name === 'content-type') {
            if (type !== undefined) fail('repeated Content-Type');
            type = value;
        }
    }
    if (disposition === undefined) fail('part without Content-Disposition');
    const semi = disposition.indexOf(';');
    if ((semi === -1 ? disposition : disposition.slice(0, semi)).trim().toLowerCase() !== 'form-data') {
        fail('Content-Disposition is not form-data');
    }
    const params = parseParams(disposition, semi === -1 ? disposition.length : semi, fail);
    if (params.name === undefined) fail('part without a name');
    const semiT = type === undefined ? -1 : type.indexOf(';');
    return {
        name: unquote(params.name),
        filename: params.filename === undefined ? undefined : baseName(unquote(params.filename)),
        type: type === undefined ? 'text/plain' : (semiT === -1 ? type : type.slice(0, semiT)).trim().toLowerCase(),
    };
}

const unquote = (s) => (s.indexOf('%22') === -1 ? s : s.replaceAll('%22', '"'));

function baseName(name) {
    const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).trim();
    return base === '.' || base === '..' ? '' : base;
}

function parseMultipart(buf, boundary, lim) {
    const fail = (why) => { throw httpError(400, `Invalid multipart body: ${why}`); };
    const fields = Object.create(null);
    const files = [];
    let fieldCount = 0;

    const delim = Buffer.from('\r\n--' + boundary);
    let pos;
    if (buf.length >= delim.length - 2 && buf.compare(delim, 2, delim.length, 0, delim.length - 2) === 0) {
        pos = delim.length - 2;
    } else {
        const first = buf.indexOf(delim);
        if (first === -1) fail('boundary not found');
        pos = first + delim.length;
    }

    for (;;) {
        if (buf[pos] === 45 && buf[pos + 1] === 45) break;
        while (buf[pos] === 32 || buf[pos] === 9) pos++;
        if (buf[pos] !== 13 || buf[pos + 1] !== 10) fail('malformed boundary line');
        pos += 2;
        if (buf[pos] === 13 && buf[pos + 1] === 10) fail('part without Content-Disposition'); // empty header block
        const headLen = buf.subarray(pos, pos + MAX_PART_HEADER + CRLF2.length).indexOf(CRLF2);
        if (headLen === -1) fail('part headers missing or too large');
        const part = parsePartHeaders(buf.toString('utf8', pos, pos + headLen), fail);

        const start = pos + headLen + CRLF2.length;
        const end = buf.indexOf(delim, start);
        if (end === -1) fail('unterminated part');
        const size = end - start;

        if (part.filename === undefined) {
            if (++fieldCount > lim.maxFields) throw httpError(413, 'Too many form fields');
            if (size > lim.maxFieldSize) throw httpError(413, 'Form field too large');
            appendValue(fields, part.name, buf.toString('utf8', start, end));
        } else if (part.filename !== '' || size !== 0) { // browsers send an empty file part when none was chosen
            if (files.length >= lim.maxFiles) throw httpError(413, 'Too many files');
            if (size > lim.maxFileSize) throw httpError(413, 'File too large');
            if (lim.allowedTypes !== null && !lim.allowedTypes.includes(part.type)) throw httpError(415, 'File type not allowed');
            files.push({ fieldName: part.name, filename: part.filename, contentType: part.type, size, data: buf.subarray(start, end) });
        }
        pos = end + delim.length;
    }
    return { fields, files };
}

function limitsOf(options) {
    if (options === undefined) return DEFAULTS;
    for (const key of Object.keys(options)) {
        if (!(key in DEFAULTS)) throw new TypeError(`formData: unknown option "${key}"`);
    }
    const lim = { ...DEFAULTS, ...options };
    if (lim.allowedTypes !== null) lim.allowedTypes = lim.allowedTypes.map((t) => t.toLowerCase());
    return lim;
}

export function parseForm(contentType, buf, options) {
    const lim = limitsOf(options);
    const ct = contentType || '';
    const semi = ct.indexOf(';');
    const mime = (semi === -1 ? ct : ct.slice(0, semi)).trim().toLowerCase();

    if (mime === URLENCODED) {
        const fields = parseQuery(buf.toString('utf8'));
        let count = 0;
        for (const key in fields) {
            for (const v of [].concat(fields[key])) {
                if (++count > lim.maxFields) throw httpError(413, 'Too many form fields');
                if (Buffer.byteLength(v) > lim.maxFieldSize) throw httpError(413, 'Form field too large');
            }
        }
        return { fields, files: [] };
    }
    if (mime === MULTIPART) {
        const boundary = parseParams(ct, semi === -1 ? ct.length : semi, (why) => { throw httpError(400, `Invalid Content-Type: ${why}`); }).boundary;
        if (boundary === undefined || !BOUNDARY.test(boundary)) throw httpError(400, 'Invalid multipart boundary');
        return parseMultipart(buf, boundary, lim);
    }
    throw httpError(415, 'Unsupported Media Type: expected a form body');
}
