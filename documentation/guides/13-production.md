# Running in production

## Health checks & metrics

```javascript
const app = new Kidlat({
    logger: { level: 'info' },
    trustProxy: true,
    health: {
        checks: { database: () => db.ping(), cache: () => redis.ping() },
        timeout: 2000,                                   // per check
    },
    metrics: { allow: (req) => req.ip.startsWith('10.') },
});
```

| Endpoint | Use for | Returns |
|---|---|---|
| `GET /health` | liveness probe | `200 {"status":"ok","uptime":…}` while the process can answer |
| `GET /ready` | **load balancer health check**, readiness probe | `200` when all checks pass; `503` with per-check details when one fails or times out, or while shutting down |
| `GET /metrics` | Prometheus scraping | requests by method / route / status, latency histograms, open connections, memory, CPU, event-loop delay |

- Health routes are registered **before** CORS, rate limiting and your hooks, so
  probes are never throttled or blocked by auth.
- Paths are configurable: `health: { path, readyPath }`, `metrics: { path }`.
  `metrics: { path: false }` disables the route; serve `app.metrics.render()`
  yourself (e.g. on an internal-only server).
- Metric labels use the route **pattern** (`/users/:id`), never the raw URL.

## Graceful shutdown

```javascript
app.listen(3000);
app.enableGracefulShutdown({
    drainDelay: 10_000,           // keep serving while /ready reports 503, so the LB can drain
    timeout: 30_000,              // max wait for in-flight requests
    onShutdown: () => db.close(), // after the server has closed
});
```

On `SIGTERM` or `SIGINT`: `/ready` turns `503` and responses carry
`Connection: close` → after `drainDelay` the server stops accepting → in-flight
requests finish → `onShutdown()` → exit. A second signal exits immediately.
The function it returns triggers the same sequence by hand.

Without the helper, `await app.close()` stops accepting, finishes in-flight
requests and closes idle keep-alive connections.

## Timeouts and your load balancer

| Option | Default | Set it to |
|---|---|---|
| `keepAliveTimeout` | 30 s | **a few seconds longer** than your load balancer's idle timeout (e.g. 65 s behind a 60 s ALB/nginx) — otherwise the LB can reuse a connection Kidlat just closed and return a 502 |
| `requestTimeout` | 120 s | at least your slowest legitimate upload |
| `headersTimeout` | 30 s | rarely needs changing |
| `maxConnections` | 16384 | what one instance should hold; needs an open-file limit above it |

## Open-file limit

Each connection uses a file descriptor. On Linux, Kidlat warns at startup if
`maxConnections` is above what the process's limit allows. Raise it:

```bash
ulimit -n 65536                       # shell
# systemd unit:  LimitNOFILE=65536
# Docker:        docker run --ulimit nofile=65536:65536 …
```

## Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
# exec form, so node receives SIGTERM directly for graceful shutdown
CMD ["node", "server.mjs"]
```

```bash
docker run -p 3000:3000 --ulimit nofile=65536:65536 --stop-timeout 45 my-app
```

`--stop-timeout` should exceed `drainDelay + timeout`. The `node:*-alpine` images
have no prebuilt binary — use the Debian-based images (`node:22`, `node:22-slim`).

---

← [HTTPS](12-https.md) · [All guides](../Guides.md) · [Scaling: clustering & worker threads](14-scaling.md) →
