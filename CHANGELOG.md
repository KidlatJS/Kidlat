# Changelog

## 2.5.0 — Next

The native addon changed (ABI 6): install 2.5.0 with its matching prebuilt
binaries, or rebuild from source.

### Features

All in JavaScript, and opt-in: a request that doesn't use them does no extra
work (the request object gains one field, a lazily parsed cookie cache).

- **Cookies.** `req.cookies` (parsed on first use), `res.cookie(name, value,
  options)` and `res.clearCookie(name, options)`. Defaults are `Path=/`,
  `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came over HTTPS;
  `maxAge` is in seconds. Settings a browser would reject or mis-scope throw:
  invalid names, `;` or control characters in `path`/`domain`, `SameSite=None`
  without `Secure`, and `__Secure-`/`__Host-` names without their required
  attributes. **Signed cookies** with `new Kidlat({ cookies: { secret } })`:
  HMAC-SHA256 over name and value (so a value can't be moved to another
  cookie), secrets of 32+ characters, key rotation with an array;
  `req.signedCookies` leaves tampered values out.
- **Forms and file uploads.** `req.formData(limits)` → `{ fields, files }` for
  `multipart/form-data` and `application/x-www-form-urlencoded` (`415` for other
  types). Limits on field count and size, file count and size, and allowed
  file types (`413` / `415`); malformed bodies (missing boundary, duplicate
  `Content-Disposition` or parameters, headers without a colon or with
  control characters, part headers over 8 KB) are a `400`. Filenames lose
  their directory part; field objects are prototype-free. Names and filenames
  follow the browser encoding (WHATWG HTML): `%22` is a quote, backslashes are
  kept. The body is buffered, capped by the route's `bodyLimit`; file data is
  a view into it, not a copy.
- **`bodyLimit` per route.** `app.post('/upload', { bodyLimit: 10 * 1024 * 1024 },
  …)` raises or lowers the app-wide limit for one route, for declared,
  inline and chunked bodies.
- **Rate limits per route and per scope**, on top of the app-wide one:
  `{ rateLimit: {...} }` on a route (its own counter), on `register()` (one
  counter for the scope), `rateLimit: false` to drop inherited limiters, or
  an array of limiters. New options: `skipSuccessfulRequests` (only responses
  with status >= 400 count, for logins) and `hook: 'preHandler'` (runs after
  validation, so `keyGenerator` can use `req.body`).
- **`securityHeaders` option.** `true` adds the OWASP API defaults —
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `Strict-Transport-Security`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Cross-Origin-Opener-Policy` and `-Resource-Policy:
  same-origin`, `X-Permitted-Cross-Domain-Policies: none`. Each can be changed
  or turned off; unknown options and an invalid HSTS `preload` throw at
  startup. They become part of the default header block, so they cost nothing
  per request; `defaultHeaders` and `res.header()` override them.

### Performance

- **Responses with custom headers are written in one native call.** Every
  response — with or without `res.header()`, `rateLimit` or `cors` — now goes
  through the native `respond()`: JS hands over the custom headers as one
  block, and the status line, `Content-Length`, `Date`, `Connection` and default
  headers are added in C++. The separate header writer (`sendResponse`) is gone,
  and with it the 4 KB custom-header / 1 KB default-header limits that sent
  larger heads down a slower all-JS path. End-to-end with `rateLimit` and `cors`
  on, server CPU per request is a further ~3% lower; routes without custom
  headers are unchanged (within run-to-run noise).
- **Responses with custom headers are cheaper.** Any `res.header()` call — and
  so every response with `rateLimit` or `cors` on — built its header block twice
  (once to check it fits the native writer, once to send it), kept headers in
  slow dictionary-mode objects and re-validated each name with a RegExp. Header
  blocks are now built once, headers live in a `Map`, and validated names are
  cached. The JavaScript cost of a response with 3–4 custom headers drops by
  60–65% (≈2.3 → 0.94 µs in a micro-benchmark); end-to-end with `rateLimit` and
  `cors` on, server CPU per request is ~4% lower. `res.getHeaders()` still
  returns a plain object.
- **Built-in rate limiting and CORS cost less per request.** Their headers
  (fixed or numeric values, checked once at startup) skip the per-request name
  and value checks of `res.header()`, and IPv6 client keys are cached instead
  of re-parsed. With both on, a JSON route went from ~58k to ~69k req/s locally
  (pipelining 10).
- **Response headers and the rate limiter do less work per request.**
  - Headers live in one flat array instead of two `Map`s. That is one
    allocation per response instead of two, and a short scan instead of hashing.
  - The rate limiter reads a clock refreshed every 10 ms instead of calling
    `Date.now()` (about 170 ns on Windows) on every request.
  - The limiter reuses its `X-RateLimit-Remaining` strings instead of
    formatting a number each time.
  - Measured in-process, the JavaScript cost of a response is lower by:
    - 8–23% with four custom headers
    - 32–40% with `rateLimit` and `cors`
    - 40% with `rateLimit` alone
  - Responses without headers are unchanged to slightly faster: the header
    branch moved out of `_write` so it stays inlined.
- **Route parameters build a fixed-shape object.** Each route compiles its
  `req.params` builder once, so the object has its final shape at once
  instead of growing key by key: ~3× faster to build (35 → 11 ns for one
  parameter).
- **The parser checks URLs and header values 8 bytes at a time.** The
  control-byte check that every URL and header value goes through now screens
  a 64-bit word per step and only looks at single bytes in a word that might
  hold one, instead of testing each byte.
- **One wall-clock read per event-loop turn for `Date`.** Responses produced
  in the same loop iteration (a pipelined burst, a batch of reads) share it
  instead of calling `time()` each.
- The `GET /user/:id` gap between 2.3 and 2.4 in the README table no longer
  reproduces: interleaved A/B runs put the current code ~2.6% *below* 2.3.1 in
  server CPU per request on that route.

### Fixes

- **An `onResponse` hook on a single route never ran** unless the app also had
  an app-wide `onResponse` hook (or request logging): routes didn't switch on
  response tracking. They do now.
- **Response schemas could serialize `Object.prototype` members.** A declared
  property named `toString`, `constructor`, `valueOf` and the like was read
  through the prototype chain when the object didn't have it, so the response
  contained e.g. `"toString":"function toString() { [native code] }"` or
  `"constructor":{"name":"Object"}`. Function values are now skipped, as
  `JSON.stringify` does, and a declared `__proto__` is read only as an own
  property. Getters on a class prototype (ORM rows) still serialize.
- **Streams to HTTP/1.0 clients were sent chunked.** HTTP/1.0 has no chunked
  encoding, so a 1.0 client (some health checkers, `ab`, old proxies) saw the
  chunk-size lines as part of the body. Those responses now carry the raw
  bytes with `Connection: close`, and the body ends when the connection
  closes. New: `req.httpVersion` (`'1.1'` or `'1.0'`). The addon advertises
  this as `rawStreams`; with an older binary of the same ABI, streams stay
  chunked as before.
- **A throw while a request was being set up could crash the process.** A
  custom `genReqId`, a logger or a request decorator that threw reached Node
  as an uncaught exception. The request is now answered with a 500 (through
  the error handler when the response exists) and the server keeps running.
- **The status-line table was filled lazily from every thread.** Under
  `worker_threads` the first responses on each thread wrote the shared table
  at the same time. It is now filled once when the addon loads.

### Platforms

- **Prebuilt binaries for Linux arm64 and for musl (Alpine)**, x64 and arm64.
  musl binaries live in `prebuilds/linux-<arch>-musl/`, and the loader picks
  the folder by the running libc, so a glibc binary is never tried on Alpine.

### Security

- **A spoofed `X-Forwarded-For` became `req.ip`.** With `trustProxy: true`,
  `req.ip` was the *leftmost* `X-Forwarded-For` entry. Proxies append the real
  client to that header, so the leftmost entry is whatever the client sent: one
  request header got past the built-in rate limiter, and faked the address in
  logs, `req.fingerprint` and IP allow-lists. The chain is now walked from the
  socket peer outwards, and the first hop that isn't a trusted proxy is the
  client. `trustProxy` now also takes a hop count, a list of addresses / CIDR
  ranges (plus `'loopback'`, `'linklocal'`, `'uniquelocal'`), or an
  `(addr, hop) => boolean` function.
  **Behaviour change:** `true` now means *one* trusted proxy (the socket peer).
  With several proxies in front (CDN → load balancer → Kidlat), set the hop count
  (`trustProxy: 2`) or their address ranges, or every client behind one CDN edge
  will appear as that edge's address.
- **`X-Forwarded-Host` was used without validation.** Any value became
  `req.hostname`, so apps building absolute URLs from it (password-reset links,
  redirects) could be pointed at another domain. `X-Forwarded-Proto` and `-Host`
  are now read only when the socket peer is trusted, the value added by the
  nearest proxy is used, `X-Forwarded-Proto` must be `http` or `https`, and a
  `Host` / `X-Forwarded-Host` that isn't a well-formed `host[:port]` is ignored
  (`req.hostname` is `''` if no valid host remains).
- **IPv6 clients could rotate addresses to reset their rate limit.** A subscriber
  usually controls a whole /64 (2^64 addresses), and each address had its own
  counter. The default key now groups IPv6 clients by /64 — new
  `rateLimit.ipv6Subnet` option (default `64`, `128` = per address). An address
  in `allowList` still matches by its full form.
- **Custom header blocks are checked natively before they are sent.** JS
  already validates header names and strips CR/LF from values; `respond()` now
  checks the framing of the whole block again (token name, colon, no bare CR or
  LF, one CRLF per line) and closes the connection instead of sending a block
  that could split the response.
- `req.ips` now lists only the client and the trusted proxies (client first,
  socket peer last), not entries a client could have forged.
- **Chunked trailers could hide a request (smuggling).** Trailer lines weren't
  validated: a bare LF ended a line, and lines needed no colon. In
  `0\r\n\nGET /admin …` a proxy that ends the body at the bare LF sees a second
  request that Kidlat swallowed as trailers. Trailer fields now follow the
  header rules (token name, colon, no control bytes, CRLF only); anything else
  is a 400 and the connection closes.
- **Chunk sizes with stray whitespace were accepted.** `5 junk\r\n` was read
  as size 5 with an extension, where another parser could read it otherwise.
  Whitespace after a chunk size is now allowed only before a `;` extension.
- **The JSON prototype-poisoning check could be bypassed with escapes.**
  `{"__proto__": …}` (or an escaped `constructor` / `prototype`) didn't
  contain the literal key the fast check looks for, so it skipped the checking
  parser. Bodies with a `\u` escape that could spell part of a key name (a
  character from U+0040 to U+007F: every letter and `_`) now go through it
  too. Escapes of non-ASCII text, which Python's `json.dumps` writes for every
  accented or non-Latin character, keep the fast path: on a 257-byte body like
  that, checking every escape would have cost ~11 µs per parse instead of
  ~2 µs.
- **`cors: { origin: '*', credentials: true }` reflected every origin.** That
  lets any website read responses for a signed-in user. **Behaviour change:**
  this combination now throws at startup; list the allowed origins (string,
  array, RegExp or function).
- **Absolute-form URLs must match `Host`.** For `GET http://a.com/x` the RFC
  makes the URL's host authoritative, but `req.hostname` read `Host`, so a
  request could carry two different hosts (cache poisoning). A mismatch, a
  userinfo part, or an absolute URL with a query but no path is now a 400.
  The `*` target is accepted only for `OPTIONS`.
- **A TLS handshake had no deadline.** Each handshake byte refreshed the idle
  timer, and `headersTimeout` only starts with the first HTTP byte, so a
  client trickling a ClientHello one byte at a time held a connection (and a
  `maxConnections` slot) forever. A handshake must now finish within
  `headersTimeout` (or `keepAliveTimeout` when that is 0).
- **Userinfo in an absolute-form URL is rejected outright.** `GET
  http://u@host/` was refused only because it didn't match `Host`; a request
  that also sent `Host: u@host` got through. Any `@` in the authority is now
  a 400.
- **`HEAD` could run the `GET` route and skip the `HEAD` route's hooks.**
  When the native route table couldn't decide a `HEAD` path (a
  RegExp-constrained parameter), it fell back to the `GET` route instead of
  letting the JS router find the `HEAD` route.
- **Response header values lose all control characters,** not only CR and LF
  (NUL and friends are invalid in field values and some proxies cut the header
  there), and the native block check refuses them too.

### Tests

- `test/cookies.test.js`, `test/forms.test.js`, `test/route-options.test.js`:
  the features above — parsing and building edge cases, every rejection rule,
  signing and key rotation, multipart bodies from `fetch`'s own `FormData`,
  per-route and per-scope limits, `skipSuccessfulRequests`, per-route
  `bodyLimit` for declared, inline and chunked bodies, and route-level
  `onResponse`.
- `test/security-probes.test.js`: a "2.5 hardening" suite with a regression
  test for each fix in the Security section above, plus checks that valid
  extensions, trailers, matching absolute-form and `OPTIONS *` still work.
- `test/property.test.js`: seeded property tests (3,000 cases each in
  `npm test`, 200,000 with a fresh seed nightly) — query strings against
  `URLSearchParams`, request headers against a reference parser, validation
  with coercion (what it accepts must re-validate without coercion; nothing
  touches `Object.prototype`), and the serializer against `JSON.stringify`
  with quotes, control characters and lone surrogates. It found the serializer
  bug above.
- `benchmarks/compare.mjs`: new `headers` scenario (JSON with four custom
  headers, all four frameworks, gated like the others) and `plugins` (Kidlat
  with `rateLimit` + `cors`, tracked). Kidlat's server CPU per request with
  four headers is 0.95× uWS's locally.
- `test/stress/soak.mjs --full`: production-like options (rate limiting with
  constant key eviction, CORS, `trustProxy` with a new client address per
  request, logging, metrics) and a new **weekly 5-hour soak** workflow running it.
- Prebuild workflow builds and tests on `ubuntu-24.04-arm` and in Alpine
  containers (x64 and arm64).
- The parser fuzz target also drives the response head writer: the header
  block check is compared with a reference implementation on every input, and
  every accepted block is written into a full head that must stay correctly
  framed (one blank line, at the end; no bare CR or LF).
- `test/native-path.test.js`: an app header replacing a default header, custom
  `Content-Type`, 20 KB and 150-header responses, UTF-8 and empty values, and
  six malformed blocks passed straight to `respond()` that must close the
  connection unsent.
- New `test/trust-proxy.test.js`: spoofed leftmost `X-Forwarded-For` with
  `true`, hop counts, CIDR lists, functions and an untrusted peer; a rate limit
  that holds while the spoofed entry rotates; `X-Forwarded-Proto` / `-Host`
  injection attempts; IPv6 /64 grouping and `ipv6Subnet: 128`; option
  validation at startup.

## 2.4.0 — 2026-10-17

**Faster request and response paths, security and memory-bound fixes.** No
breaking API changes (one new option: `rateLimit.maxKeys`).
The native addon changed (ABI 5): install the 2.4.0 package with its matching
prebuilt binaries, or rebuild from source.

### Performance

- **Routing happens in the parser.** The native route table is consulted while
  the request head is parsed, and the route index plus parameter offsets come
  to JavaScript in a shared buffer: no second native call, no per-request
  argument objects. Anything the native table can't decide exactly
  (RegExp-constrained parameters, unknown methods) is still routed by the
  JavaScript router, which remains the source of truth.
- **Small request bodies arrive with the request.** A body with a
  `Content-Length` up to 16 KB (and within `bodyLimit`) that is already fully
  received is delivered together with the head, so `req.json()` / `req.text()`
  resolve without waiting on further body events. Larger and chunked bodies
  stream as before.
- **One-call responses.** Responses without custom headers are built entirely
  in native code: status line, content type, `Content-Length`, date,
  connection and default headers, with the body encoded to UTF-8 exactly once.
- **Direct dispatch.** Routes with no hooks, middleware or schema validation
  call the handler directly.
- Local measurements (100 connections, pipelining 10): `POST` with a JSON body
  is ~26% faster than 2.3.x; `GET` routes are unchanged to slightly faster.

### Security

- **Response splitting through the status code.** `res.status()`,
  `res.send(body, status)`, `res.json(obj, status)`, `res.redirect()` and
  `res.stream()` now accept only an integer status between 100 and 999 and
  throw a `TypeError` otherwise. Before, a value derived from input — e.g.
  `res.status(req.query.code)` — could inject header lines into the response.
  The native writer also rejects out-of-range status codes.
- **A RegExp-constrained route could be bypassed by a wildcard (2.3.x).** With
  routes such as `/a/:id(^\d+$)` and `/*`, the 2.3 native router could send a
  request for `/a/123` to the wildcard instead of the constrained route,
  skipping any auth or validation attached to it. The native router now hands
  every such decision to the JavaScript router.
- **Logging could exhaust memory when output is slow.** With `logger` on and a
  destination slower than the request rate (a terminal, a pipe, a container
  log driver), unwritten log lines piled up in memory without limit — over
  500 MB within seconds under load. At most 4 MB of log text is now queued;
  further lines are dropped and a warning reports how many.
- **The rate limiter's client table is bounded.** It tracked every distinct
  key for the whole window, so a flood from many addresses (cheap with IPv6)
  grew memory without limit. New `rateLimit.maxKeys` option (default
  100,000); past it the oldest entry is dropped.
- **Bare-LF requests are rejected immediately.** A request head whose
  lines end in `\n` instead of `\r\n` never matched the end-of-head
  sequence, so the connection sat open until `headersTimeout` (30 s) before
  getting a 408. Such heads now get `400 Bad Request` as soon as the bare LF
  arrives.
- Routes whose path exceeds the maximum URL length are rejected at
  registration instead of being truncated; default headers larger than 64 KB
  are rejected at startup.

### Tests

- Resource tests: slow log output and a flood of rate-limit keys stay within
  their memory caps.
- New native-path suite: 3,000 randomized routing comparisons between the
  native table and the JavaScript router (with and without
  `ignoreTrailingSlash`), inline bodies, the one-call response path and status
  injection.
- The parser fuzz target now also exercises the native router and checks the
  request contract (route index, parameter offsets, inline body framing) on
  every input.
- New `test/security-probes.test.js`: obfuscated `Transfer-Encoding`, signed
  and negative `Content-Length`, overflowing chunk sizes, NUL bytes, invalid
  methods and versions, 2,000 headers, a 50 MB upload refused without being
  buffered, 2,000 abandoned uploads leaving no state behind, 3,000 idle
  connections, and 300 half-sent heads all timed out with 408.
- `benchmarks/compare.mjs` compares against uWebSockets.js, hyper-express and
  Fastify (3 shuffled rounds, medians, server CPU measured in-process on every
  OS). Nightly and version tags fail if Kidlat needs more than 1.10× uWS's CPU
  per request or falls below Fastify's throughput.

## 2.3.1 — 2026-10-16

**Security release. Everyone on 2.3.0 should upgrade.** No API changes, no
native changes — the 2.3.0 binaries are unchanged.

### Security

- **Data could leak between requests (2.3.0 only).** 2.3.0 recycled `req` and
  `res` objects through a pool as soon as a response was written, resetting only
  Kidlat's own fields. Anything an app attached to a request — `req.user` from an
  auth hook, sessions, tenant ids, per-request caches — carried over to the next
  request that received the same object. With the common pattern of setting
  `req.user` only when a valid token is present, an **anonymous request could be
  served as a previously authenticated user**. Code that used `req`/`res` after
  sending (logging, auditing after an `await`) could also read another request's
  data. The pool is removed: every request gets fresh objects. It had no
  measurable performance benefit (garbage collection was ~0.4% of CPU time under
  benchmark load with or without it).
- **`X-Content-Type-Options: nosniff` is sent by default again.** 2.3.0 dropped
  it from the defaults; it stops browsers from interpreting a response as a
  different content type than declared. `defaultHeaders: {}` still turns it off.
- **Long response headers are no longer truncated.** 2.3.0's native response
  writer copied headers into fixed-size buffers (content type 256 B, default
  headers 1 KB, custom headers 4 KB) and cut anything longer mid-line, producing
  malformed responses — e.g. several `Set-Cookie` headers or a large
  `Content-Security-Policy`. Responses with headers that don't fit are now
  written through a path without these limits.

- **A rejected promise from a handler could crash the process (2.3.0).**
  2.3.0's fast path decided whether a handler was asynchronous from its
  function type. A plain function returning a promise — e.g.
  `(req) => db.find(req.params.id)` — was treated as synchronous: the promise
  itself was sent as `{}`, and if it rejected, the rejection was unhandled,
  which terminates Node by default. Handlers are now inspected by what they
  return, so these routes send the resolved value, and rejections reach the
  error handler (`404`/`500`/…) like any other error.

### Tests

- `test/handlers.test.js`: nine handler styles (sync, async, plain function
  returning a promise, `res.send`, throws, rejections) give the same result on
  the direct path and the full pipeline, with no unhandled rejections.
- `test/isolation.test.js`: requests never see another request's state
  (middleware auth, sync fast path, pipelining, concurrent traffic, code running
  after the response is sent), large headers arrive intact, and `nosniff` is on
  by default. 10 of these 13 tests fail on 2.3.0.

## 2.3.0

> ⚠️ **Do not use 2.3.0** — it can leak data between requests. Upgrade to 2.3.1.

Performance release: five optimizations that close the gap with uWebSockets.js.
No breaking API changes, no new dependencies.

### Performance

- **Request/Response object pool.** `KidlatRequest` and `KidlatResponse`
  instances are recycled via a free-list instead of being allocated and
  garbage-collected on every request. At 100K+ req/s this eliminates 200K+
  allocations per second and the GC pauses they cause. Pool size is capped at
  512 per type.
- **Native route matching (C++).** Routes are now registered in both the JS
  trie and a C++ segment-level trie. On every request the native trie is tried
  first — static routes are a flat hash-map lookup, and dynamic `:param` routes
  walk the C++ trie without entering V8. Routes with RegExp-constrained
  parameters (`:id(^\d+$)`) fall back to the JS router automatically. Each
  Kidlat instance gets its own native router scope.
- **Sync-route fast path.** Routes with no hooks, no middlewares, no schema
  validators and a non-async handler skip the `runSteps` pipeline and the
  `isThenable` check entirely, using a dedicated `runSync()` code path.
- **Fast ASCII `Content-Length`.** String responses that contain only ASCII
  characters (the common case for text, JSON and error messages) compute their
  byte length with a `charCodeAt` scan instead of calling `Buffer.byteLength`.
- **Default headers removed.** The built-in `X-Content-Type-Options: nosniff`
  header is no longer sent by default. Pass
  `defaultHeaders: { 'X-Content-Type-Options': 'nosniff' }` to restore it.

### Changed

- Native ABI version bumped from 3 to 4 (prebuilds from 2.1.x / 2.2.x must be
  rebuilt).
- `defaultHeaders` now defaults to `{}` (empty). It was
  `{ 'X-Content-Type-Options': 'nosniff' }`. This saves 38 bytes on every
  response and a header-write loop iteration. Opt back in explicitly if your
  application serves HTML directly.
- `benchmarks/compare.mjs` now auto-installs missing benchmark dependencies
  (`fastify`, `autocannon`) on the fly with `npm install --no-save`, so CI
  runners no longer need them pre-installed.

## 2.2.0

### Performance

- First round of benchmark-driven optimization based on the KidlatJS/benchmarks
  results against 14 frameworks on a dedicated GitHub Actions runner.

## 2.1.0

Everything needed to run Kidlat behind a load balancer and watch it in
production. No breaking changes, no new dependencies.

### New

- **`health` option:** `GET /health` (liveness) and `GET /ready` (readiness) with
  your own async checks, each with a timeout. `/ready` answers `503` with
  per-check details when a check fails, and while the server is draining.
  Registered ahead of CORS, rate limiting and your hooks, so probes are never
  throttled or blocked by auth.
- **`metrics` option:** Prometheus endpoint (`GET /metrics`) with requests by
  method, route pattern and status; a latency histogram per route; open
  connections; memory, CPU and event-loop delay. Route labels use the registered
  pattern (`/users/:id`), so the number of series stays bounded. `allow()` to
  restrict scraping, `path: false` + `app.metrics.render()` to serve it yourself.
- **`app.enableGracefulShutdown()`:** on `SIGTERM`/`SIGINT`, `/ready` turns `503`
  and responses say `Connection: close`; after `drainDelay` the server stops
  accepting, in-flight requests finish, `onShutdown()` runs and the process exits.
  A second signal exits at once. Returns a function to trigger it by hand.
- **Open-file limit warning (Linux):** Kidlat warns at startup when
  `maxConnections` can't be reached under the process's open-file limit.

### Performance

- **Native header serialization:** The full HTTP response head (status line,
  Content-Type, Content-Length, Date, Connection and default headers) is now
  assembled entirely in C++ via the new `native.sendResponse()` call. On the
  common fast path (no custom headers), zero JS strings are allocated for the
  head — the status line comes from a pre-computed lookup table, the Date header
  is cached and reformatted at most once per second, and Content-Length is
  converted with a native `uint_to_str`. This eliminates millions of short-lived
  string allocations per second that previously pressured V8's GC. Expected gain:
  ~10–15% on GET-heavy workloads. The old `native.send()` path is preserved for
  streaming responses.

### Fixed

- `decorateRequest()` / `decorateResponse()` were shared by every Kidlat app in
  the process, so a second app (e.g. one per test) adding the same decorator
  threw "already exists". Decorators are now per app.

### Changed

- Native ABI version bumped from 2 to 3 (prebuilds from 2.0.0 must be
  rebuilt).
- When no native binary fits the platform, the error message now says which
  platforms are supported and to reinstall, instead of suggesting a source build.
- The README no longer lists repository-only commands; they moved to
  `docs/DEVELOPMENT.md` in the repository.

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
