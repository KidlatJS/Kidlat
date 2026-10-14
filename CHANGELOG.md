# Changelog

## 2.0.0 — 2026-10-14

Kidlat 2.0 rewrites the native layer and builds routing, validation,
serialization and logging into Kidlat itself. It is substantially faster than
1.x, has **zero runtime dependencies**, and is tested continuously: a test matrix on
Linux / Windows / Alpine with Node 20–26, AddressSanitizer + UBSan builds,
coverage-guided fuzzing of the HTTP parser, soak tests, request-smuggling probes
and testssl.sh.

### ⚠️ Breaking changes

| Change | Before (1.x) | Now (2.0) | What to do |
|---|---|---|---|
| `res.send(object)` | sent `"[object Object]"` as text | sends JSON (`application/json`) | nothing, unless you relied on the old output |
| Text content type | `text/plain` | `text/plain; charset=utf-8` | nothing for browsers; update exact-match header checks in tests |
| HTTP/1.1 request without `Host` | accepted | `400 Bad Request` (RFC 9112) | make sure clients and health checks send `Host` |
| Schema `default` values | ignored | filled in for body, querystring and params | review schemas whose defaults you didn't expect to apply |
| Response schemas | stripped fields only if an optional serializer package happened to be installed | always serialise **only** declared properties | declare every field you send, or use `additionalProperties: true` |
| `listen()` | ignored bind errors; returned `undefined` | throws (e.g. `err.code === 'EADDRINUSE'`); returns the bound port | wrap in try/catch if you handled a "silent" failure; `listen(0)` now gives you the port |
| `requestTimeout` | idle time while a request waited for its response | Node semantics: max time to **receive** the whole request (head + body) from its first byte → `408`; also still the max idle wait for a response | raise it if clients legitimately upload very slowly |
| `cluster()` on Windows / macOS | started N workers, of which only one could bind | runs a single process with a warning (`SO_REUSEPORT` balancing is Linux/FreeBSD only) | use Linux for multi-process, or run one process per port behind a balancer |
| Unhandled handler errors | swallowed silently | logged (stderr when no logger is configured) | nothing — but you will now see errors that were hidden before |
| Minimum Node.js | — | **20** | upgrade Node 18 (end-of-life) |
| npm script `prebuild` | `prebuild` | `prebuildify` (npm ran `prebuild` before every `build`) | only affects people building Kidlat itself |

The native ABI changed: binaries from 1.x cannot be used with 2.0 (the loader
refuses them with a clear message).

### Migrating from 1.x

1. `npm install kidlat@2` on Node 20 or newer.
2. Search your code for `res.send(` with an object argument — it is now JSON.
3. If you use response schemas, check that every field your handlers return is
   declared (undeclared fields are dropped — on purpose, so internal fields such
   as password hashes can't leak).
4. If `listen()` might fail (port in use), handle the thrown error.
5. If you rely on `cluster()`, deploy on Linux.
6. Run your test suite; most apps need no other change.

### New

- **Zero runtime dependencies.** The router, JSON-Schema validator,
  schema-driven serializer, structured logger and native addon loader are all
  built into Kidlat. `npm install kidlat` installs Kidlat and nothing else.
  - Validators and serializers are compiled into specialised functions once,
    when a route is registered.
  - Static routes resolve with a single lookup.
  - Disabled log levels cost a single no-op call, and child loggers are cheap
    enough to create per request.

- **Schemas** for `querystring`, `params` and `headers` (with type coercion),
  `$ref` to schemas registered with `app.addSchema()`, `if/then/else`,
  `prefixItems`, `contains`, `propertyNames`, `dependentRequired` and more.
  Validation errors keep the same shape as in 1.x
  (`instancePath`, `schemaPath`, `keyword`, `params`, `message`).
- **Streaming** of Node streams, web `ReadableStream`s and async iterables
  (`res.stream()` / `res.send(stream)`), with backpressure.
- **Graceful shutdown:** `await app.close()` finishes in-flight requests and
  closes idle keep-alive connections.
- `listen()` accepts a host and port `0`, and returns the bound port.
- Handlers can **return** a value instead of calling `res.send()`.
- Hooks `onResponse`; callback-style hooks `(req, res, done)`;
  `setNotFoundHandler()`; scoped error handlers in plugins; `app.route()`,
  `app.all()`; `decorateRequest()` / `decorateResponse()`; `httpError()`.
- `req.text()`, `req.buffer()`, `req.ips`, `req.header()`; `res.redirect()`,
  `res.type()`, `res.headers()`, multi-value headers (e.g. `Set-Cookie`).
- Router: RegExp-constrained parameters (`/:id(^\d+$)`), wildcards
  (`/assets/*`), `ignoreTrailingSlash`.
- CORS: allow-lists, RegExp and function origins (reflected, with `Vary: Origin`),
  exposed headers. Rate limiter: `keyGenerator`, `allowList`.
- Options: `keepAliveTimeout`, `headersTimeout`, `requestTimeout`,
  `maxConnections`, `defaultHeaders`, `genReqId`, `reusePort`, `backlog`.

### Fixed

- **Chunked request bodies were dropped** (`req.json()` returned `{}`).
- **Pipelined responses could be sent out of order** when async handlers
  finished at different times; responses are now always in request order.
- **`listen()` silently "succeeded" on a port already in use**, so `cluster()`
  effectively ran one worker. On Linux, workers now share the port with
  `SO_REUSEPORT` — set directly, so it also works on Node 20, whose libuv
  ignores the newer flag.
- A burst of tiny pipelined requests could overflow the stack (the parser
  recursed once per request); it is now iterative.
- TLS served only the first certificate of a chain; intermediates are now sent.
- `HEAD` responses no longer include a body; `204`/`304` no longer send a
  `Content-Length`.
- `Connection: close` is announced on responses that end the connection
  (graceful shutdown, `408`, malformed bodies).
- A client half-closing its side still receives its responses.
- A stream whose client disconnects is released immediately.
- Query strings decode `+` as a space; repeated keys become arrays.
- Errors inside callback-style middleware reach the error handler instead of
  crashing the process.

### Security

- **Request smuggling:** strict HTTP/1.1 framing — conflicting or duplicate
  `Content-Length`, `Transfer-Encoding` other than `chunked`, whitespace before
  a colon, obs-fold, bare LF and control bytes are rejected. Verified with 35
  smuggling probes, directly and through nginx.
- **Slow-drip protection:** `headersTimeout` and `requestTimeout` count from a
  request's first byte; trickling bytes can no longer hold a connection open.
- **TLS:** TLS 1.2 limited to ECDHE + AEAD suites (forward secrecy),
  client-initiated renegotiation disabled, TLS 1.2 minimum, ALPN `http/1.1`.
- Limits on URL length (8 KB → `414`), head size and header count (`431`),
  pipelining depth, and buffered out-of-order responses.
- JSON bodies containing `__proto__` / `constructor.prototype` are rejected
  (prototype pollution).
- `Expect: 100-continue` is answered, and early responses (e.g. `413`) are no
  longer lost to a TCP reset.

### Performance

- `try_write` fast path: most responses reach the kernel with no allocation,
  copy or callback; everything produced while handling one socket read goes out
  in a single write.
- Request heads are parsed in place; one shared read buffer per thread instead
  of 64 KB per connection; timeouts handled by one timer per thread.
- A request pipeline that allocates no promises for synchronous routes.

| 100 connections | Kidlat 1.x | Kidlat 2.0 |
|---|---|---|
| GET text | 25.5k req/s, 43 µs CPU/req | ~30k req/s, ~32 µs CPU/req |
| GET text, pipelining 10 | 36k req/s, 31 µs CPU/req | ~118k req/s, ~8.5 µs CPU/req |

### Tooling

- Test suite with `node:test` (`npm test`): protocol, framework, schemas, TLS,
  timeouts, limits, graceful shutdown, `worker_threads`, cluster.
- GitHub Actions: `ci.yml` (test matrix, sanitizers, fuzzing, package check),
  `nightly.yml` (fuzzing, soak, performance-regression benchmark, smuggling probes
  through nginx, testssl.sh, macOS), `prebuild.yml` (all four prebuilds in one
  artifact).
- `fuzz/` (libFuzzer harness; `fuzz\run-windows.cmd` for local fuzzing on
  Windows), `test/stress/` (soak, smuggling, TLS), `benchmarks/compare.mjs`.
