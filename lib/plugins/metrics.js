/*!
 * kidlat - Prometheus metrics (no dependencies)
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { performance, monitorEventLoopDelay } from 'perf_hooks';
import { readFileSync } from 'fs';
import { native } from '../native.js';
import { ALLOWED_METHODS } from '../constants.js';

const DEFAULT_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const NOT_FOUND = '(not found)';

let version = 'unknown';
try {
    version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
} catch { /* bundled without package.json */ }

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const num = (v) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN');

export function createMetrics(app, options) {
    const o = options === true ? {} : options;
    const buckets = (o.buckets || DEFAULT_BUCKETS).slice().sort((a, b) => a - b);
    const path = o.path === undefined ? '/metrics' : o.path;
    const allow = typeof o.allow === 'function' ? o.allow : null;
    const exclude = new Set([...(o.exclude || []), ...(path ? [path] : [])]);

    const series = new Map(); // "METHOD route" → { method, route, statuses, counts, sum, n }
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();

    function seriesFor(method, route) {
        const key = method + ' ' + route;
        let s = series.get(key);
        if (s === undefined) {
            s = { method, route, statuses: new Map(), counts: new Array(buckets.length).fill(0), sum: 0, n: 0 };
            series.set(key, s);
        }
        return s;
    }

    function onRequest(req) {
        req._metricsStart = performance.now();
    }

    function onResponse(req, res) {
        if (exclude.has(req.path)) return;
        const method = ALLOWED_METHODS.has(req.method) ? req.method : 'OTHER';
        const s = seriesFor(method, res._route !== null ? res._route.path : NOT_FOUND);
        s.statuses.set(res.statusCode, (s.statuses.get(res.statusCode) || 0) + 1);
        if (req._metricsStart === undefined) return;
        const secs = (performance.now() - req._metricsStart) / 1000;
        s.sum += secs;
        s.n++;
        for (let i = 0; i < buckets.length; i++) {
            if (secs <= buckets[i]) { s.counts[i]++; break; }
        }
    }

    function render() {
        const out = [];
        const metric = (name, type, help) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);

        metric('kidlat_http_requests_total', 'counter', 'Requests answered, by method, route pattern and status code.');
        for (const s of series.values()) {
            const labels = `method="${esc(s.method)}",route="${esc(s.route)}"`;
            for (const [status, count] of s.statuses) out.push(`kidlat_http_requests_total{${labels},status="${status}"} ${count}`);
        }

        metric('kidlat_http_request_duration_seconds', 'histogram', 'Time from request arrival to the end of its response.');
        for (const s of series.values()) {
            const labels = `method="${esc(s.method)}",route="${esc(s.route)}"`;
            let cumulative = 0;
            for (let i = 0; i < buckets.length; i++) {
                cumulative += s.counts[i];
                out.push(`kidlat_http_request_duration_seconds_bucket{${labels},le="${num(buckets[i])}"} ${cumulative}`);
            }
            out.push(`kidlat_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.n}`);
            out.push(`kidlat_http_request_duration_seconds_sum{${labels}} ${num(s.sum)}`);
            out.push(`kidlat_http_request_duration_seconds_count{${labels}} ${s.n}`);
        }

        const root = app._root;
        metric('kidlat_connections', 'gauge', 'Open client connections.');
        out.push(`kidlat_connections ${root._sid ? native.stats(root._sid).connections : 0}`);
        metric('kidlat_draining', 'gauge', '1 while the server is shutting down or draining.');
        out.push(`kidlat_draining ${root._draining || root._closing !== null ? 1 : 0}`);

        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        metric('process_resident_memory_bytes', 'gauge', 'Resident memory size in bytes.');
        out.push(`process_resident_memory_bytes ${mem.rss}`);
        metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use, in bytes.');
        out.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
        metric('nodejs_heap_total_bytes', 'gauge', 'V8 heap reserved, in bytes.');
        out.push(`nodejs_heap_total_bytes ${mem.heapTotal}`);
        metric('nodejs_external_memory_bytes', 'gauge', 'Memory held by Buffers and native objects, in bytes.');
        out.push(`nodejs_external_memory_bytes ${mem.external}`);
        metric('process_cpu_user_seconds_total', 'counter', 'User CPU time spent, in seconds.');
        out.push(`process_cpu_user_seconds_total ${cpu.user / 1e6}`);
        metric('process_cpu_system_seconds_total', 'counter', 'System CPU time spent, in seconds.');
        out.push(`process_cpu_system_seconds_total ${cpu.system / 1e6}`);
        metric('process_start_time_seconds', 'gauge', 'Process start time, in seconds since the Unix epoch.');
        out.push(`process_start_time_seconds ${Math.round(Date.now() / 1000 - process.uptime())}`);

        // event loop delay since the previous scrape
        metric('nodejs_eventloop_delay_seconds', 'gauge', 'Event-loop delay since the last scrape, by quantile.');
        const q = (p) => (loop.count ? loop.percentile(p) / 1e9 : 0);
        out.push(`nodejs_eventloop_delay_seconds{quantile="0.5"} ${q(50)}`);
        out.push(`nodejs_eventloop_delay_seconds{quantile="0.99"} ${q(99)}`);
        out.push(`nodejs_eventloop_delay_seconds{quantile="1"} ${loop.count ? loop.max / 1e9 : 0}`);
        loop.reset();

        metric('kidlat_info', 'gauge', 'Kidlat and Node.js versions.');
        out.push(`kidlat_info{version="${esc(version)}",node="${esc(process.version)}"} 1`);
        return out.join('\n') + '\n';
    }

    function install() {
        app.addHook('onRequest', onRequest);
        app.addHook('onResponse', onResponse);
        if (!path) return;
        app.get(path, (req, res) => {
            if (allow !== null && !allow(req)) return res.code(403).send('Forbidden');
            res.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
                .header('Cache-Control', 'no-store')
                .send(render());
        });
    }

    return { install, render };
}
