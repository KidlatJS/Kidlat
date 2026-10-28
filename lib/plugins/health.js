/*!
 * kidlat - health and readiness endpoints
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 *
 * new Kidlat({ health: true })
 * new Kidlat({ health: { path: '/health', readyPath: '/ready', timeout: 2000,
 *                        checks: { database: () => db.ping(), cache: () => redis.ping() } } })
 *
 *   GET /health  liveness:  200 while the process can answer at all.
 *   GET /ready   readiness: 200 when every check passes within `timeout`,
 *                503 when one fails or times out, or while the server is
 *                draining for shutdown — so a load balancer stops sending
 *                traffic before the process stops listening.
 *
 * These routes are registered before CORS, rate limiting and your own
 * hooks, so health probes are never throttled or blocked by auth.
 */

import { performance } from 'perf_hooks';

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function installHealth(app, options) {
    const o = options === true ? {} : options;
    const livePath = o.path ?? '/health';
    const readyPath = o.readyPath ?? '/ready';
    const timeout = o.timeout ?? 2000;
    const checks = Object.entries(o.checks || {});

    if (livePath) {
        app.get(livePath, (req, res) => {
            res.header('Cache-Control', 'no-store').json({ status: 'ok', uptime: Math.round(process.uptime()) });
        });
    }

    if (readyPath) {
        app.get(readyPath, async (req, res) => {
            res.header('Cache-Control', 'no-store');
            const root = app._root;
            if (root._draining || root._closing !== null) {
                return res.code(503).json({ status: 'draining' });
            }
            const results = {};
            let ok = true;
            await Promise.all(checks.map(async ([name, check]) => {
                const t0 = performance.now();
                try {
                    await withTimeout(Promise.resolve().then(check), timeout);
                    results[name] = { status: 'ok', ms: Math.round(performance.now() - t0) };
                } catch (err) {
                    ok = false;
                    results[name] = { status: 'fail', ms: Math.round(performance.now() - t0), error: err?.message ?? String(err) };
                }
            }));
            res.code(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fail', checks: results });
        });
    }
}
