# Kidlat Runbook

How to run a Kidlat service in production, and what to do when something goes
wrong.

---

## 1. Running it

### Recommended setup

```javascript
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: { level: 'info' },               // JSON logs to stdout
    health: { checks: { database: () => db.ping() } },
    metrics: { allow: (req) => req.ip.startsWith('10.') },   // scrape from the internal network only
    trustProxy: true,                        // one load balancer / proxy in front; use a hop count or its CIDRs for more
    keepAliveTimeout: 65_000,                // longer than the load balancer's idle timeout (see below)
});

// ... routes ...

app.listen(3000);
app.enableGracefulShutdown({
    drainDelay: 10_000,                      // ≥ how long the LB takes to notice /ready = 503
    timeout: 30_000,                         // max wait for in-flight requests
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
upload, and `headersTimeout` (30 s) rarely needs changing.

### WebSockets behind a proxy

WebSocket routes (`app.ws()`) share the HTTP port, so the proxy in front must pass
upgrades through. AWS ALB, Google Cloud LB and Cloudflare do this by default; nginx
needs it per location:

```nginx
location /ws/ {
    proxy_pass http://kidlat;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;                 # longer than the route's idleTimeout
}
```

- **Idle timeouts.** Kidlat pings a quiet socket halfway through its `idleTimeout`
  (default 120 s, so after 60 s) and drops it at the deadline. The ping must go out
  *before* the proxy's own idle timeout closes the connection: keep `idleTimeout`
  under **2×** the proxy's idle timeout. Behind an ALB (60 s), use `idleTimeout: 100`.
- **Origin check.** Browsers send `Origin`, and by default it must match the
  request's own scheme and host. Behind a TLS-terminating proxy that only works
  with `trustProxy` set (so `X-Forwarded-Proto` / `X-Forwarded-Host` are used);
  without it every browser upgrade gets `403`. If the site and the WebSocket are
  on different hosts, list them in the route's `origins`.
- **Several instances.** `app.publish()` reaches subscribers in *this* process
  only. To reach every instance, forward with `app.ws.onPublish(fn)` to a broker
  (Redis, NATS…) and deliver what the broker sends back with `app.publishLocal()`.
- **Deploys.** Shutdown sends close code `1001` to every open socket. Clients should
  reconnect with backoff and jitter, or a deploy turns into a reconnect storm on
  the instances that stay up.

### Capacity

- **Open files:** every connection needs a file descriptor. Kidlat warns at startup
  on Linux if `maxConnections` (default 16384) is above what the open-file limit
  allows. Raise it with `LimitNOFILE=65536` (systemd), `--ulimit nofile=65536:65536`
  (Docker) or `ulimit -n 65536`.
- **CPU cores:** on Linux, `cluster()` runs one worker per core sharing the port.
  On Windows/macOS it runs one process — scale with more instances instead.
- **WebSockets count as connections:** each open socket holds one of the
  `maxConnections` slots for as long as it stays open. Size `maxConnections` for
  your peak concurrent sockets *plus* HTTP traffic.
- **Memory per socket:** a socket whose client stops reading can hold up to
  `maxBackpressure` (1 MiB) of queued output before Kidlat closes it, and a
  message being reassembled up to `maxPayload` (64 KiB). Budget the worst case
  as sockets × (`maxBackpressure` + `maxPayload`), or lower the two limits for
  routes with many sockets.

---

## 2. Rolling back

Every release is published as `latest`. To go back, pin the previous version:

```bash
npm install kidlat@2.5.0 --save-exact
```

Then redeploy. Keep the previous release's lockfile and build artifact so a
rollback is a redeploy, not a rebuild. Each version ships its own native binary
(2.6.0 is ABI 7, 2.5.0 is ABI 6), so reinstall rather than copying
`node_modules/kidlat` between versions.

Code that uses features newer than the version you go back to has to be reverted
with it:

| Going back to | Remove first |
|---|---|
| 2.5.x | `app.ws()`, `app.publish()` / `publishLocal()`, `app.ws.onPublish()` |
| 1.3.5 | everything 2.x: `health`, `metrics`, `enableGracefulShutdown`, `res.stream`, schemas for `querystring`/`params`, and the above |

To roll forward again: `npm install kidlat@latest --save-exact`.

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

A WebSocket upgrade is logged as a request with status `101`; refused upgrades
appear with their status (`403`, `426`, or whatever `upgrade()` sent). Errors
thrown in `open`, `message` or `drain` are logged at level 50 as
`open handler failed`, `message handler failed` or `drain handler failed` (stack
under `err`), and that socket is closed with `1011`.

```bash
# upgrades, accepted and refused
jq -c 'select(.res.statusCode == 101 or .res.statusCode == 426) | {time, url: .req.url, status: .res.statusCode}' app.log
```

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
| **KidlatWsBackpressureCloses** | clients on slow networks, or the app sending faster than clients can read | Check `kidlat_ws_messages_total{direction="out"}` for a send spike; send less (batch, coalesce, drop stale updates), raise `maxBackpressure`, or use `onBackpressureLimit: 'drop'` |
| **KidlatWsAbnormalCloses** | the proxy cutting idle sockets, network drops, a deploy elsewhere | If it matches a proxy idle timeout, lower `idleTimeout` (§1). Check `kidlat_ws_closes_total` by code — table below |

### Status codes Kidlat sends by itself

| Code | Meaning |
|---|---|
| 101 | WebSocket upgrade accepted |
| 400 | Malformed request (bad framing, invalid JSON, missing `Host`, schema validation, half-valid WebSocket handshake) |
| 403 | WebSocket upgrade from a browser `Origin` that isn't allowed |
| 426 | Plain request to a WebSocket-only path, or an unsupported `Sec-WebSocket-Version` |
| 404 / 405 | No route / unknown method |
| 408 | Request head or body didn't arrive within `headersTimeout` / `requestTimeout` |
| 413 | Body larger than `bodyLimit` |
| 414 / 431 | URL over 8 KB / headers over 64 KB or too many |
| 501 / 505 | Unsupported `Transfer-Encoding` / HTTP version |
| 503 | Over `maxConnections`, or `/ready` failing / draining |

### WebSocket close codes

From `kidlat_ws_closes_total{code}` and the `close(ws, code)` handler:

| Code | Meaning | What to check |
|---|---|---|
| 1000 | Normal close | — |
| 1001 | Going away: server shutdown, or the browser left the page | Expected during deploys |
| 1002 | Protocol error from the client (unmasked frame, bad opcode…) | A broken or hostile client; check the IP |
| 1006 | No close frame: the connection just dropped (network, proxy, `terminate()`, idle timeout) | Proxy idle timeouts (§1), network |
| 1007 | Invalid UTF-8 in a text message or close reason | A client sending binary as text |
| 1008 | Policy: `maxBackpressure` reached, `messageRate` exceeded, or over 100 pings/s | Slow clients or floods; see the backpressure alert |
| 1009 | Message over `maxPayload` (counted after decompression) | Raise `maxPayload` if legitimate |
| 1011 | An `open` / `message` / `drain` handler threw | Level 50 logs: `… handler failed` |
| 3000–4999 | Your application's own codes | — |

### Startup failures

| Message | Fix |
|---|---|
| `listen EADDRINUSE` | Another process holds the port: `ss -ltnp 'sport = :3000'` (Linux) / `netstat -ano \| findstr :3000` (Windows) |
| `listen EACCES` | Ports < 1024 need privileges — use a higher port behind the LB |
| `no usable native binary … stale binary` | The installed prebuild doesn't match this Kidlat version — reinstall, or `npm run build` in a source checkout |
| `options.https.key does not match options.https.cert` | Wrong key file for the certificate |
| `Could not load options.https.cert` | Not a PEM certificate; use the full chain (leaf + intermediates) |

---

## 5. Diagnostics

**Heap snapshot** (memory leaks) — start with the flag, then signal the process:

```bash
node --heapsnapshot-signal=SIGUSR2 app.js
kill -USR2 <pid>          # writes Heap.<date>.<pid>.heapsnapshot in the working directory
```

Open it in Chrome DevTools → Memory. Take two, an hour apart, and use *Comparison*.
A snapshot pauses the process for seconds and needs about 2× the heap in memory —
take it on an instance that is out of rotation if you can.

**CPU profile** (event loop blocked, high CPU):

```bash
node --cpu-prof --cpu-prof-dir=/tmp/prof app.js     # written on exit
```

**Diagnostic report** (state at a crash or on demand):

```bash
node --report-on-fatalerror --report-uncaught-exception --report-on-signal app.js
kill -USR2 <pid>          # only if --heapsnapshot-signal isn't using USR2
```

**Native crash** (process dies with SIGSEGV/SIGABRT and no JS stack): enable core
dumps (`ulimit -c unlimited`, or `LimitCORE=infinity` in systemd), reproduce, and
keep the core file, the exact `kidlat` and Node versions (`kidlat_info` metric),
and the last requests from the logs. A crashing request can be replayed against the
parser fuzzer: `fuzz/run-windows.cmd <file>` or `build/fuzz/parser_fuzz <file>`.
For a crash on a WebSocket connection, save the client's raw frames and fuzz the
frame parser with them: `fuzz\run-windows.cmd ws` (corpus in `fuzz/corpus-ws`).

**WebSocket state right now:** `/metrics` shows open sockets
(`kidlat_ws_sockets`), traffic, closes by code and backpressure events. A socket
count that keeps rising while traffic is flat usually means clients that vanish
without closing; they are dropped at `idleTimeout`, so check it isn't `0` (off).

---

## 6. Checking a release before rollout

```bash
# on a production-like Linux box: 24-hour soak (fails on errors, leaks or leftover state)
node test/stress/soak.mjs --duration 86400

# the same, with WebSocket clients alongside the HTTP load
node test/stress/soak.mjs --duration 86400 --ws

# WebSocket throughput: echo, broadcast and connection churn
node benchmarks/ws-load.mjs --scenarios echo,broadcast,churn

# WebSocket protocol conformance (Autobahn TestSuite, needs Docker)
node scripts/autobahn.mjs

# from a separate machine against a deployed instance
node benchmarks/remote.mjs --url http://10.0.0.5:3000/api/health-heavy-route --duration 60
```

Roll out as a canary first: one instance at ~5% of traffic for a week, comparing
5xx rate and p99 latency with the current version; then 25% → 50% → 100% with at
least 48 h at each step.
