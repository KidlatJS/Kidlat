/*!
 * kidlat - cluster helper: runs a Kidlat app in one worker process per core
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import crypto from 'crypto';

const REUSEPORT_PLATFORMS = new Set(['linux', 'freebsd', 'dragonfly']);

export async function cluster(workerFn, options = {}) {
    const { default: clusterModule } = await import('cluster');
    const os = await import('os');

    if (!clusterModule.isPrimary) {
        await workerFn();
        return;
    }

    if (!REUSEPORT_PLATFORMS.has(process.platform)) {
        console.warn(`[cluster] SO_REUSEPORT load balancing is not available on ${process.platform}; running a single process.`);
        await workerFn();
        return;
    }

    const workers = options.workers || (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
    const env = {
        KIDLAT_REUSE_PORT: '1',
        KIDLAT_TLS_TICKET_KEY: process.env.KIDLAT_TLS_TICKET_KEY || crypto.randomBytes(48).toString('hex'),
    };

    console.log(`[cluster] Primary ${process.pid} starting ${workers} workers`);
    for (let i = 0; i < workers; i++) clusterModule.fork(env);

    let recentExits = [];
    clusterModule.on('exit', (worker, code, signal) => {
        if (worker.exitedAfterDisconnect) return;
        const now = Date.now();
        recentExits = recentExits.filter((t) => now - t < 10_000);
        recentExits.push(now);
        const delay = recentExits.length > workers ? Math.min(30_000, 500 * 2 ** (recentExits.length - workers)) : 0;
        console.log(`[cluster] Worker ${worker.process.pid} exited (${signal || code}). Restarting${delay ? ` in ${delay} ms` : ''}…`);
        setTimeout(() => clusterModule.fork(env), delay);
    });
}
