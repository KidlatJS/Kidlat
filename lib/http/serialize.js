/*!
 * kidlat - raw HTTP/1.1 response head building
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { STATUS_TEXT } from '../constants.js';

const statusLines = Object.create(null);

export function statusLine(code) {
    return statusLines[code]
        || (statusLines[code] = `HTTP/1.1 ${code} ${STATUS_TEXT[code] || 'Unknown'}\r\n`);
}

let dateValue = '';
let dateSecond = 0;
export function httpDate() {
    const now = Date.now();
    const sec = now - (now % 1000);
    if (sec !== dateSecond) {
        dateSecond = sec;
        dateValue = new Date(now).toUTCString();
    }
    return dateValue;
}

const CTL = /[\x00-\x08\x0a-\x1f\x7f]/;
const CTL_G = /[\x00-\x08\x0a-\x1f\x7f]/g;

export function sanitizeHeaderValue(val) {
    const s = typeof val === 'string' ? val : String(val);
    return CTL.test(s) ? s.replace(CTL_G, '') : s;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const isToken = (s) => typeof s === 'string' && TOKEN.test(s);

export const hasControlChar = (s) => CTL.test(s);

export function assertHeaderName(name) {
    if (!isToken(name)) {
        throw new TypeError(`Invalid header name: ${JSON.stringify(name)}`);
    }
}

export function headerBlock(headers) {
    let out = '';
    if (!headers) return out;
    for (const name of Object.keys(headers)) {
        assertHeaderName(name);
        out += `${name}: ${sanitizeHeaderValue(headers[name])}\r\n`;
    }
    return out;
}
