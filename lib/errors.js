/*!
 * kidlat - HTTP errors
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { STATUS_TEXT } from './constants.js';

export function httpError(statusCode, message, props) {
    const err = new Error(message || STATUS_TEXT[statusCode] || 'Error');
    err.statusCode = statusCode;
    if (props) Object.assign(err, props);
    return err;
}

export function statusOf(err) {
    const s = err && (err.statusCode ?? err.status);
    return Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}
