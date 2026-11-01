# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `listen EADDRINUSE` | Another process uses the port. Find it: `ss -ltnp 'sport = :3000'` (Linux), `netstat -ano \| findstr :3000` (Windows). |
| `listen EACCES` | Ports below 1024 need extra privileges — use a higher port behind your load balancer. |
| `kidlat: no usable native binary for …` | Your platform has no prebuilt binary (supported: Windows x64, macOS arm64/x64, Linux x64/arm64 with glibc or musl), or the install is incomplete — delete `node_modules/kidlat` and reinstall. |
| `TypeError: listen: host must be an IP address` | `listen()` takes an IP or `'localhost'`, not a hostname. |
| A route returns `400` with `details` | Schema validation failed — the `details` say which field and why. |
| `413 Payload Too Large` | Raise `bodyLimit`. |
| `408 Request Timeout` | The client sent its request too slowly. For genuinely slow uploads, raise `requestTimeout`. |
| `503` with "Too many connections" | `maxConnections` reached — raise it (and the open-file limit) or add instances. |
| `502` at the load balancer, now and then | `keepAliveTimeout` is shorter than the load balancer's idle timeout — make it longer ([Running in production](13-production.md#timeouts-and-your-load-balancer)). |
| A request never gets a response | A code path neither sends nor returns anything, or a hook awaited something that never settles. |
| Hook or middleware doesn't run for a route | It was registered **after** the route ([The request lifecycle: hooks & middleware](05-hooks-and-middleware.md)), or in a different `register()` scope. |
| `cluster()` prints "running a single process" | You're on Windows or macOS — expected ([Scaling: clustering & worker threads](14-scaling.md#cluster--one-process-per-core-linux)). |
| Response is missing fields | A response schema doesn't declare them ([Validation & serialization](04-validation.md)) — add them or use `additionalProperties: true`. |
| `res.send(obj)` behaves differently than in 1.x | 2.x sends objects as JSON — see the CHANGELOG for all 1.x → 2.x changes. |

---

← [What Kidlat doesn't do (and what to use instead)](16-limitations.md) · [All guides](../Guides.md)
