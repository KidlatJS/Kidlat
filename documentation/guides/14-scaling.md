# Scaling: clustering & worker threads

## `cluster()` — one process per core (Linux)

```javascript
import { Kidlat, cluster } from 'kidlat';

cluster(() => {
    const app = new Kidlat();
    app.get('/', () => `Hello from ${process.pid}`);
    app.listen(3000);
}, { workers: 4 });             // default: one per CPU core
```

Every worker binds the same port with `SO_REUSEPORT` and the **kernel** spreads
connections across them. Crashed workers are restarted automatically, with a
back-off if they keep crashing.

This needs **Linux** (or FreeBSD). On Windows and macOS, `cluster()` runs your app
in a single process and prints a warning — scale those with several instances
behind a load balancer instead.

Each worker is a separate process: in-memory state (caches, rate-limit counters,
sessions) is per worker. Keep shared state in a database or cache.

## Worker threads

Each thread can run its own Kidlat server (on its own port):

```javascript
// worker.mjs
import { parentPort } from 'worker_threads';
import { Kidlat } from 'kidlat';
const app = new Kidlat();
app.get('/', () => 'hi');
parentPort.postMessage(app.listen(0));
```

Terminating a worker closes its server and frees its port.

---

← [Running in production](13-production.md) · [All guides](../Guides.md) · [Testing your app](15-testing.md) →
