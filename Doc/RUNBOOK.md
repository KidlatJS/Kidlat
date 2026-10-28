# Kidlat Runbook

How to run a Kidlat service in production, and what to do when something goes
wrong.

---

## 1. Running it

### Recommended setup

```javascript
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: { level: 'info' }, // JSON logs to stdout
    health: { checks: { database: () => db.ping() } },
    metrics: { allow: (req) => req.ip.startsWith('10.') }, // scrape from the internal network only
    trustProxy: 1, // number of proxies in front (see "Proxies" below)
    securityHeaders: true, // CSP, HSTS, X-Frame-Options, … for APIs
    rateLimit: { max: 600, window: 60_000 },
    cookies: { secret: process.env.COOKIE_SECRET }, // only if you sign cookies; 32+ characters
    keepAliveTimeout: 65_000, // longer than the load balancer's idle timeout (see below)
});

// ... routes ...

app.listen(3000);
app.enableGracefulShutdown({
    drainDelay: 10_000, // ≥ how long the LB takes to notice /ready = 503
    timeout: 30_000, // max wait for in-flight requests
    onShutdown: () => db.close(),
});
```

### Load balancer

| Setting | Value |
|---|---|
| Health check path | **`/ready`** (fails during shutdown and when a dependency check fails) |
| Liveness probe (Kubernetes) | `/health` (only fails if the process is wedged) |
| Deregistration / drain delay | at least `drainDelay` |
| Idle timeout | **shorter** than Kidlat's `keepAliveTimeout` |

Why the last row matters: if Kidlat closes an idle keep-alive connection while the
load balancer is about to reuse it, that request fails (a 502 at the balancer).
Keep `keepAliveTimeout` a few seconds above the balancer's idle timeout:

| In front of Kidlat | Its idle timeout | Kidlat `keepAliveTimeout` |
|---|---|---|
| AWS ALB | 60 s (default) | `65_000` |
| nginx (`keepalive_timeout` upstream) | 60 s | `65_000` |
| Google Cloud LB | 600 s | `620_000` |
| Cloudflare | 900 s | `920_000` |

`requestTimeout` (default 120 s) must be at least as long as your slowest legitimate
upload, and `headersTimeout` (30 s) rarely needs changing. `headersTimeout` also
bounds the TLS handshake when Kidlat terminates HTTPS itself.

### Proxies

`trustProxy` must match what is actually in front of Kidlat. `req.ip` is found by
walking `X-Forwarded-For` from the socket outwards and stopping at the first
address that isn't a trusted proxy:

| In front of Kidlat | `trustProxy` |
|---|---|
| nothing (directly on the internet) | leave it off |
| one load balancer / nginx | `1` (or `true`) |
| CDN → load balancer | `2` |
| proxies with known addresses | their ranges, e.g. `['10.0.0.0/8', 'loopback']` |

Too low, and all clients behind a CDN edge share one IP (and one rate limit). Too
high, and clients can forge their IP. Since 2.5, `true` means exactly one proxy —
deployments upgraded from earlier versions with several proxies need a hop count.

### Capacity

- **Open files:** every connection needs a file descriptor. Kidlat warns at startup
  on Linux if `maxConnections` (default 16384) is above what the open-file limit
  allows. Raise it with `LimitNOFILE=65536` (systemd), `--ulimit nofile=65536:65536`
  (Docker) or `ulimit -n 65536`.
- **CPU cores:** on Linux, `cluster()` runs one worker per core sharing the port.
  On Windows/macOS it runs one process — scale with more instances instead.
- **Memory:** `req.formData()` buffers the whole body, so a route's `bodyLimit`
  is also the most memory one upload can take. Keep large limits to the routes
  that need them. The rate limiter tracks at most `rateLimit.maxKeys` (100 000)
  clients per limiter, and at most 4 MB of log lines wait for a slow log
  destination.
- **Platforms:** prebuilt binaries for Linux x64/arm64 (glibc and musl/Alpine),
  macOS and Windows x64. Docker images can be Debian- or Alpine-based.

---

## 2. Rolling back

2.x is published under the npm `next` tag; 1.3.5 is `latest`.

```bash
npm install kidlat@1.3.5 --save-exact
```

Then redeploy. Code that uses 2.x-only features (`health`, `metrics`,
`enableGracefulShutdown`, `res.stream`, schemas for `querystring`/`params`) has to
be reverted with it — keep the previous release's lockfile and build artifact so a
rollback is a redeploy, not a rebuild.

Rolling back **within 2.x** (e.g. 2.5 → 2.4.0): install the exact version and
reinstall from a clean `node_modules`, since each release that changes the native
ABI (2.4 → ABI 5, 2.5 → ABI 6) needs its own prebuilt binaries. Code that uses
2.5 features — `req.cookies`/`res.cookie()`, `req.formData()`, per-route
`bodyLimit`/`rateLimit`, `securityHeaders`, `trustProxy` as a number, list or
function — goes back with it. Never roll back to 2.3.0 (it can leak data between
requests); use 2.3.1 or later.

To roll forward again: `npm install kidlat@next --save-exact`.

---

## 3. Logs

One JSON object per line on stdout:

```json
{"level":30,"time":1760410000000,"pid":4242,"hostname":"web-1","reqId":"req-3f","msg":"incoming request","req":{"method":"GET","url":"/users/7","remoteAddress":"10.0.0.9"}}
{"level":30,"time":1760410000004,"pid":4242,"hostname":"web-1","reqId":"req-3f","res":{"statusCode":200},"responseTime":3.1,"msg":"request completed"}
```

Levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.

```bash
# everything about one request
grep '"reqId":"req-3f"' app.log

# errors only, readable
jq -c 'select(.level >= 50) | {time, reqId, msg, err: .err.message}' app.log

# slowest requests
jq -c 'select(.responseTime) | {responseTime, url: .req.url, reqId}' app.log | sort -t: -k2 -rn | head
```

Unhandled errors in handlers are logged at level 50 with the stack under `err`.

A `warn` line `log output is slower than the server: dropped N lines` means the
log destination (terminal, pipe, container log driver) can't keep up and lines
were dropped to stay within 4 MB of memory. Log to a faster destination, lower the
level, or set `disableRequestLogging: true`.

---

## 4. Alerts — what to do

Rules: [`alerts.example.yml`](alerts.example.yml).

| Alert | Likely cause | First steps |
|---|---|---|
| **KidlatDown** | crash, OOM kill, deploy gone wrong | Check restarts and the last log lines; `dmesg` for OOM; roll back if it started with a deploy |
| **KidlatHigh5xxRate** | a bug, or a dependency down | Group 5xx by `route` in metrics; read `level 50` logs for those routes; check `/ready` for failing checks |
| **KidlatHighLatencyP99** | slow dependency, CPU saturation | Which `route`? Compare with dependency latency; check CPU and `nodejs_eventloop_delay_seconds` |
| **KidlatEventLoopBlocked** | CPU-heavy or synchronous code on the request path | Take a CPU profile (§5); look for sync file I/O, big `JSON.parse`, crypto, regex backtracking |
| **KidlatRestarted** | crash or OOM | Look for `uncaughtException` / `fatal` in logs; a native crash leaves no JS stack — see §5 core dumps |
| **KidlatMemoryGrowth** | a leak (usually in app code: caches, listeners) | Take two heap snapshots an hour apart and compare (§5) |
| **KidlatConnectionsNearLimit** | traffic spike, slow clients, connection leak upstream | Raise `maxConnections` (and the open-file limit), add instances; check the LB isn't holding idle connections |
| **KidlatManyTimeouts** | slow clients, slow-drip attack, or `requestTimeout` too low for real uploads | If one IP/range: block it at the edge. If real users: raise `requestTimeout` |
| Many `429`s for unrelated users | `trustProxy` too low, so clients share a proxy's IP | Check `req.ip` in logs (`remoteAddress`); set `trustProxy` to the number of proxies (§1) |

### Status codes Kidlat sends by itself

| Code | Meaning |
|---|---|
| 400 | Malformed request (bad framing or trailers, invalid JSON, missing `Host`, absolute URL not matching `Host`, malformed form body, schema validation) |
| 404 / 405 | No route / unknown method |
| 408 | Request head or body didn't arrive within `headersTimeout` / `requestTimeout` |
| 413 | Body larger than `bodyLimit` (app-wide or the route's), or over a `formData()` limit |
| 414 / 431 | URL over 8 KB / headers over 64 KB or too many |
| 415 | `formData()` on a non-form body, or a file type outside `allowedTypes` |
| 429 | Over a `rateLimit` (with `Retry-After`) |
| 501 / 505 | Unsupported `Transfer-Encoding` / HTTP version |
| 503 | Over `maxConnections`, or `/ready` failing / draining |

### Startup failures

| Message | Fix |
|---|---|
| `listen EADDRINUSE` | Another process holds the port: `ss -ltnp 'sport = :3000'` (Linux) / `netstat -ano \| findstr :3000` (Windows) |
| `listen EACCES` | Ports < 1024 need privileges — use a higher port behind the LB |
| `no usable native binary … built for native ABI …` | The installed prebuild doesn't match this Kidlat version — delete `node_modules/kidlat` and reinstall, or `npm run build` in a source checkout |
| `cors: origin '*' cannot be combined with credentials: true` | List the allowed origins instead of `'*'` |
| `cookies.secret must be a string … of at least 32 characters` | `COOKIE_SECRET` is missing or too short in this environment |
| `TypeError` naming `trustProxy`, `rateLimit` or `securityHeaders` | Invalid option value — the message says which |
| `options.https.key does not match options.https.cert` | Wrong key file for the certificate |
| `Could not load options.https.cert` | Not a PEM certificate; use the full chain (leaf + intermediates) |

---

## 5. Diagnostics

**Heap snapshot** (memory leaks) — start with the flag, then signal the process:

```bash
node --heapsnapshot-signal=SIGUSR2 app.js
kill -USR2 <pid> # writes Heap.<date>.<pid>.heapsnapshot in the working directory
```

Open it in Chrome DevTools → Memory. Take two, an hour apart, and use *Comparison*.
A snapshot pauses the process for seconds and needs about 2× the heap in memory —
take it on an instance that is out of rotation if you can.

**CPU profile** (event loop blocked, high CPU):

```bash
node --cpu-prof --cpu-prof-dir=/tmp/prof app.js # written on exit
```

**Diagnostic report** (state at a crash or on demand):

```bash
node --report-on-fatalerror --report-uncaught-exception --report-on-signal app.js
kill -USR2 <pid> # only if --heapsnapshot-signal isn't using USR2
```

**Native crash** (process dies with SIGSEGV/SIGABRT and no JS stack): enable core
dumps (`ulimit -c unlimited`, or `LimitCORE=infinity` in systemd), reproduce, and
keep the core file, the exact `kidlat` and Node versions (`kidlat_info` metric),
and the last requests from the logs. A crashing request can be replayed against the
parser fuzzer: `fuzz/run-windows.cmd <file>` or `build/fuzz/parser_fuzz <file>`.

---

## 6. Checking a release before rollout

```bash
# on a production-like Linux box: 24-hour soak (fails on errors, leaks or leftover state)
node test/stress/soak.mjs --duration 86400

# from a separate machine against a deployed instance
node benchmarks/remote.mjs --url http://10.0.0.5:3000/api/health-heavy-route --duration 60
```

Roll out as a canary first: one instance at ~5% of traffic for a week, comparing
5xx rate and p99 latency with the current version; then 25% → 50% → 100% with at
least 48 h at each step.
