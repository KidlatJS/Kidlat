/*!
 * kidlat - structured logger
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import fs from 'fs';
import os from 'os';

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };
const NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const noop = () => {};

/* Sinks */
const MAX_PENDING_LOG = 4 * 1024 * 1024;

const droppedNotice = (n) =>
    `{"level":40,"time":${Date.now()},"msg":"log output is slower than the server: dropped ${n} line${n === 1 ? '' : 's'}"}\n`;

class FdSink {
    constructor(fd) {
        this.fd = fd;
        this.buf = '';
        this.writing = false;
        this.scheduled = false;
        this.dropped = 0;
        this._flush = () => { this.scheduled = false; this.flush(); };
        process.on('exit', () => this.flushSync());
    }
    write(line) {
        if (this.buf.length + line.length > MAX_PENDING_LOG) { this.dropped++; return; }
        this.buf += line;
        if (this.buf.length >= 65536) this.flush();
        else if (!this.scheduled) { this.scheduled = true; setImmediate(this._flush); }
    }
    flush() {
        if (this.writing || this.buf.length === 0) return;
        if (this.dropped !== 0) { this.buf = droppedNotice(this.dropped) + this.buf; this.dropped = 0; }
        const data = Buffer.from(this.buf);
        this.buf = '';
        this.writing = true;
        this._writeAll(data, 0);
    }
    _writeAll(data, off) {
        fs.write(this.fd, data, off, data.length - off, null, (err, n) => {
            if (err) {
                if (err.code === 'EAGAIN') return setTimeout(() => this._writeAll(data, off), 1);
                this.writing = false; // fd gone (EPIPE…): drop, don't crash the server
                return;
            }
            if (off + n < data.length) return this._writeAll(data, off + n);
            this.writing = false;
            if (this.buf.length) this.flush();
        });
    }
    flushSync() {
        if (this.dropped !== 0) { this.buf = droppedNotice(this.dropped) + this.buf; this.dropped = 0; }
        if (this.buf.length === 0) return;
        try { fs.writeSync(this.fd, this.buf); } catch { }
        this.buf = '';
    }
}

const fdSinks = new Map();
function fdSink(fd) {
    let sink = fdSinks.get(fd);
    if (!sink) fdSinks.set(fd, sink = new FdSink(fd));
    return sink;
}

class StreamSink {
    constructor(stream) { this.stream = stream; this.dropped = 0; }
    write(line) {
        const s = this.stream;
        if (s.writableLength > MAX_PENDING_LOG) { this.dropped++; return; }
        if (this.dropped !== 0) { s.write(droppedNotice(this.dropped)); this.dropped = 0; }
        s.write(line);
    }
    flush() {}
    flushSync() {}
}

/* Serialisation */

function serializeError(err) {
    const out = { type: err.name || 'Error', message: err.message, stack: err.stack };
    for (const k of Object.keys(err)) if (!(k in out)) out[k] = err[k];
    if (err.cause !== undefined) out.cause = err.cause instanceof Error ? serializeError(err.cause) : err.cause;
    return out;
}

const NEEDS_ESCAPE = /[\u0000-\u001f"\\\ud800-\udfff]/;
function str(s) {
    return s.length < 256 && !NEEDS_ESCAPE.test(s) ? '"' + s + '"' : JSON.stringify(s);
}

const keyCache = new Map();
function key(k) {
    let q = keyCache.get(k);
    if (q === undefined) {
        q = ',' + JSON.stringify(k) + ':';
        if (keyCache.size < 1000) keyCache.set(k, q);
    }
    return q;
}

function value(v) {
    switch (typeof v) {
    case 'string':  return str(v);
    case 'number':  return Number.isFinite(v) ? '' + v : 'null';
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint':  return '"' + v + '"';
    case 'object':
        if (v === null) return 'null';
        if (v instanceof Error) v = serializeError(v);
        try {
            const s = JSON.stringify(v);
            return s === undefined ? 'null' : s;
        } catch {
            return '"[unserializable]"';
        }
    default:
        return 'null';
    }
}

function fieldsToJson(obj) {
    let out = '';
    for (const k in obj) {
        const v = obj[k];
        if (v === undefined || typeof v === 'function') continue;
        out += key(k) + value(v);
    }
    return out;
}

const METHODS = {};
for (const n of NAMES) {
    const head = '{"level":' + LEVELS[n] + ',"time":';
    METHODS[n] = function log(objOrMsg, msg) {
        let fields = '';
        if (typeof objOrMsg === 'string') {
            msg = objOrMsg;
        } else if (objOrMsg instanceof Error) {
            fields = ',"err":' + value(objOrMsg);
            if (msg === undefined) msg = objOrMsg.message;
        } else if (objOrMsg !== null && typeof objOrMsg === 'object') {
            fields = fieldsToJson(objOrMsg);
        } else if (objOrMsg !== undefined) {
            msg = String(objOrMsg);
        }
        let line = head + Date.now() + this._prefix + this._bindings + fields;
        if (msg !== undefined) line += ',"msg":' + str(typeof msg === 'string' ? msg : String(msg));
        this._sink.write(line + '}\n');
    };
}

export class Logger {
    constructor(options = {}) {
        this._sink = options.stream ? new StreamSink(options.stream) : fdSink(options.fd ?? 1);
        const base = options.base === undefined
            ? { pid: process.pid, hostname: os.hostname() }
            : options.base;
        this._prefix = base ? fieldsToJson(base) : '';
        this._bindings = options.name ? fieldsToJson({ name: options.name }) : '';
        this.level = options.level ?? 'info';
    }

    get level() { return this._level; }
    set level(name) {
        if (!(name in LEVELS)) throw new Error(`Unknown log level "${name}"`);
        this._level = name;
        this._levelValue = LEVELS[name];
        for (const n of NAMES) this[n] = LEVELS[n] >= this._levelValue ? METHODS[n] : noop;
    }

    get levelVal() { return this._levelValue; }

    isLevelEnabled(name) { return LEVELS[name] >= this._levelValue; }

    child(bindings, options) {
        const c = Object.create(this);
        c._bindings = bindings ? this._bindings + fieldsToJson(bindings) : this._bindings;
        if (options && options.level !== undefined) c.level = options.level;
        return c;
    }

    flush() { this._sink.flush(); }
}

export function createLogger(option) {
    if (option && typeof option === 'object' && typeof option.info === 'function' && typeof option.child === 'function') {
        return option;
    }
    if (option === true) return new Logger({ level: 'info' });
    if (option && typeof option === 'object') return new Logger(option);
    return new Logger({ level: 'silent' });
}

export function isEnabled(logger, level) {
    if (typeof logger.isLevelEnabled === 'function') return logger.isLevelEnabled(level);
    return logger.level !== 'silent';
}
