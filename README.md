# ⚡ Kidlat

**Kidlat** is a blazing fast, natively-compiled web framework for Node.js — with **zero runtime dependencies**.

Kidlat bypasses Node's `http` module entirely. TCP sockets, TLS termination and HTTP/1.1 parsing live in a custom C++ layer on `libuv` and N-API, and everything above it — router, JSON-Schema validator, response serializer, logger — is written for Kidlat from scratch.

> **Kidlat 2.0** is a ground-up rewrite: faster, dependency-free and continuously fuzzed. Upgrading from 1.x? See [Upgrading from 1.x](#-upgrading-from-1x) and the [CHANGELOG](https://github.com/KidlatJS/Kidlat/blob/main/CHANGELOG.md).

## 🚀 Features

- **Extreme performance:** pure C++ socket processing, native header serialization (status lines, Date and Content-Length built in C++ with zero JS string allocations), native route matching (static routes resolved by a C++ hash map, dynamic `:param` routes matched by a C++ trie while the request is parsed), small request bodies delivered together with the request, synchronous `try_write` with response batching, and a request pipeline that never allocates a promise for a synchronous route (see [Benchmarks](#-benchmarks)).
- **Zero runtime dependencies:** routing, JSON-Schema validation, schema-driven serialization and structured logging are all built in. `npm install kidlat` installs Kidlat and nothing else.
- **Correct HTTP/1.1 pipelining:** responses always go out in request order, even when async handlers finish out of order.
- **Hardened parser:** strict framing rules against request smuggling (conflicting `Content-Length`/`Transfer-Encoding`, obs-fold, whitespace before colons, control bytes), limits on URL length, header size and count and pipelining depth, and deadlines that stop slow-drip (Slowloris) clients.
- **Native TLS/HTTPS:** terminated in C++; TLS 1.2+ with forward-secret AEAD ciphers only, full certificate chains, ALPN.
- **JSON Schema:** validate `body`, `querystring`, `params` and `headers` (with type coercion), and serialize responses from a schema that also acts as an allow-list.
- **Streaming:** Node streams, web streams and async iterables, with real backpressure — and released the moment the client disconnects.
- **Graceful shutdown:** drain from the load balancer, finish in-flight requests, clean up, exit — one call.
- **Production-ready endpoints:** `/health`, `/ready` with your own checks, and Prometheus `/metrics`.
- **Built-in CORS & rate limiting** (app-wide, per scope or per route), hooks, middleware, scoped plugins.
- **Cookies, forms & uploads:** `req.cookies`, `res.cookie()` with safe defaults and signed cookies, `req.formData()` for `multipart/form-data` and URL-encoded forms, with limits.
- **Security headers:** `securityHeaders: true` adds CSP, HSTS, frame, referrer and cross-origin policies — built once at startup, free per request.
- **Multi-core clustering:** workers share the port via `SO_REUSEPORT` (Linux/FreeBSD).
- **Runs in `worker_threads`:** one independent server per thread.
- **Cross-platform:** prebuilt binaries for Windows, macOS (Intel & Apple Silicon) and Linux (x64 & arm64, glibc & musl).
- **Tested continuously:** test matrix on Linux, Windows and Alpine with Node 20–26, AddressSanitizer + UBSan builds, coverage-guided fuzzing of the HTTP parser, soak tests, request-smuggling probes and TLS scanning.

## 📦 Installation

Requires **Node.js 20 or newer**.

```bash
npm install kidlat
```

Prebuilt binaries ship for Windows x64, macOS (arm64 and x64) and Linux x64 and arm64 (glibc and musl/Alpine), so no compiler is needed on those platforms.

## 🛠️ Quick Start

```javascript
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: true, // structured JSON logs, one line per event
    bodyLimit: 1048576, // 1 MB maximum payload size
    trustProxy: false // true behind one proxy (Nginx/HAProxy); a hop count or CIDRs for more
});

app.get('/', (req, res) => {
    res.send('Hello from Kidlat!');
});

// Returned values are sent: objects as JSON, strings as text
app.get('/api/info', () => ({ framework: 'Kidlat', speed: 'blazing' }));

app.post('/api/echo', async (req, res) => {
    const body = await req.json(); // also: req.text(), req.buffer()
    res.json({ success: true, received: body });
});

app.get('/users/:id', (req) => ({ id: req.params.id, q: req.query }));

const port = app.listen(3000); // throws (e.g. EADDRINUSE) if it can't bind
console.log(`⚡ Kidlat server running on http://localhost:${port}`);
```

## 🧭 Routing

```javascript
app.get('/users/:id', handler); // parameter
app.get('/files/:id(^\\d+$)', handler); // parameter with a RegExp constraint
app.get('/assets/*', handler); // wildcard → req.params['*']
app.all('/ping', handler); // every method
app.route({ method: ['GET', 'POST'], url: '/multi', handler });
```

Static segments beat parameters, which beat wildcards. `HEAD` falls back to the `GET` route automatically. Pass `ignoreTrailingSlash: true` to treat `/a/` like `/a`.

## 📨 Request & Response

| `req` | |
|---|---|
| `method`, `url`, `path`, `params`, `query`, `headers`, `header(name)` | parsed lazily |
| `ip`, `ips`, `protocol`, `hostname` | honour `X-Forwarded-*` when `trustProxy` is on |
| `json()`, `text()`, `buffer()` | body readers (JSON is guarded against `__proto__` poisoning) |
| `formData(limits?)` | `{ fields, files }` from a multipart or URL-encoded body |
| `cookies`, `signedCookies` | parsed lazily; `signedCookies` holds only values whose signature checks out |
| `id`, `log`, `fingerprint`, `aborted` | |

| `res` | |
|---|---|
| `send(body, status?)` | string → text, Buffer → octet-stream, stream → chunked, object → JSON |
| `json(obj, status?)`, `status(code)` / `code(code)` | status must be an integer from 100 to 999, otherwise a `TypeError` is thrown |
| `header(name, value)`, `headers(obj)`, `type(ct)`, `getHeader`, `removeHeader` | `value` may be an array |
| `redirect(url, code = 302)` | |
| `cookie(name, value, options?)`, `clearCookie(name, options?)` | one `Set-Cookie` per call; HttpOnly, SameSite=Lax, Path=/ and (over HTTPS) Secure by default |
| `stream(source, status?, contentType?)` | Node Readable, web ReadableStream or async iterable |

## 🔒 Advanced Usage

### Built-in Rate Limiting & CORS

```javascript
const app = new Kidlat({
    cors: {
        origin: ['https://my-frontend.com', /\.my-company\.com$/], // or '*', a function, a RegExp
        methods: 'GET,POST',
        credentials: true
    },
    rateLimit: {
        max: 100, // 100 requests
        window: 60000, // per minute per IP (keyGenerator / allowList available)
        maxKeys: 100000 // clients tracked at once; past it the oldest is dropped
    }
});

// stricter limits where it matters, on top of the app-wide one
app.post('/login', { rateLimit: { max: 5, window: 15 * 60_000, skipSuccessfulRequests: true } }, login);
app.post('/webhook', { rateLimit: false }, hook); // exempt
await app.register(api, { prefix: '/api', rateLimit: { max: 1000 } }); // one counter per scope
```

### Cookies, Forms & Uploads

```javascript
const app = new Kidlat({ cookies: { secret: process.env.COOKIE_SECRET } }); // 32+ characters; an array rotates keys

app.post('/prefs', (req, res) => {
    res.cookie('theme', 'dark', { maxAge: 30 * 86400 }); // seconds
    res.cookie('session', 'abc', { signed: true });
    return { theme: req.cookies.theme, session: req.signedCookies.session };
});

app.post('/receipts', { bodyLimit: 10 * 1024 * 1024 }, async (req) => { // per-route body limit
    const { fields, files } = await req.formData({ maxFiles: 1, allowedTypes: ['image/jpeg', 'application/pdf'] });
    // files[0] = { fieldName, filename, contentType, size, data: Buffer }
});
```

### Security Headers

```javascript
const app = new Kidlat({ securityHeaders: true }); // OWASP defaults for APIs
const web = new Kidlat({ securityHeaders: { frameOptions: 'SAMEORIGIN', contentSecurityPolicy: false } });
```

### JSON Schema Validation & Serialization

Kidlat compiles schemas into specialised functions at startup. Invalid input gets a `400 Bad Request` before your handler runs, with error details in the standard JSON Schema form (`instancePath`, `keyword`, `params`, `message`).

```javascript
app.addSchema({ $id: 'user', type: 'object', properties: { name: { type: 'string' } } });

app.post('/api/users', {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'age'],
            properties: {
                username: { type: 'string', minLength: 3 },
                age: { type: 'integer', minimum: 18 },
                role: { type: 'string', enum: ['user', 'admin'], default: 'user' }
            },
            additionalProperties: false
        },
        querystring: { type: 'object', properties: { dryRun: { type: 'boolean' } } }, // "true" → true
        response: {
            200: { type: 'object', properties: { id: { type: 'integer' }, username: { type: 'string' } } }
        }
    }
}, (req, res) => {
    const { username } = req.parsedBody;
    // only id and username are serialized — anything else on the object is dropped
    res.json({ id: 1, username, passwordHash: 'never sent' });
});
```

Supported keywords: `type` (incl. `nullable`), `enum`, `const`, `required`, `properties`, `additionalProperties`, `patternProperties`, `propertyNames`, `min/maxProperties`, `dependentRequired`, `minLength`, `maxLength`, `pattern`, `format` (email, uri, uuid, date, date-time, time, ipv4, ipv6, hostname, …), `minimum`, `maximum`, `exclusiveMinimum/Maximum`, `multipleOf`, `items`, `prefixItems`, `min/maxItems`, `uniqueItems`, `contains`, `allOf`, `anyOf`, `oneOf`, `not`, `if/then/else`, `default` and `$ref`.

### Hooks, Middleware & Plugins

```javascript
app.addHook('onRequest',  (req, res) => { /* sync, async, or (req, res, done) */ });
app.addHook('preHandler', async (req, res) => { if (!req.headers.authorization) res.code(401).send('Unauthorized'); });
app.addHook('onSend',     (req, res, payload) => payload); // may replace the payload
app.addHook('onResponse', (req, res) => metrics.observe(res.statusCode));

app.use(async (req, res, next) => {
    const t = Date.now();
    await next();
    req.log.info({ ms: Date.now() - t }, 'timed');
});

app.setErrorHandler((err, req, res) => res.code(err.statusCode || 500).json({ error: err.message }));
app.setNotFoundHandler((req, res) => res.code(404).json({ error: 'nope' }));

await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);
    admin.get('/dashboard', () => ({ ok: true }));
}, { prefix: '/admin' });
```

Throw `httpError(404, 'No such user')` (exported from `kidlat`) or any error with a `statusCode` to control the response. Errors without one become `500 Internal Server Error`, and they are logged rather than swallowed.

### Streaming

```javascript
import fs from 'fs';

app.get('/download', (req, res) => res.stream(fs.createReadStream('big.zip'), 200, 'application/zip'));

// Server-Sent Events: runs as long as it keeps writing; stops when the client leaves
app.get('/events', (req, res) => res.stream((async function* () {
    for (let i = 0; ; i++) {
        yield `data: tick ${i}\n\n`;
        await new Promise((r) => setTimeout(r, 1000));
    }
})(), 200, 'text/event-stream'));
```

If a stream fails halfway, Kidlat aborts the connection, so the client never mistakes a truncated body for a complete one. When the client disconnects, the source is stopped and released straight away.

### Multi-core Clustering

```javascript
import { Kidlat, cluster } from 'kidlat';

cluster(() => {
    const app = new Kidlat();
    app.get('/', (req, res) => res.send('Worker responding!'));
    app.listen(3000);
});
```

By default `cluster()` starts one worker per CPU core, and each worker is a full Node.js process (roughly 50–60 MB of memory at rest). On a shared or small machine, pass a count: `cluster(fn, { workers: 2 })`.

Each worker binds the port with `SO_REUSEPORT`, and the kernel spreads connections across them. That is available on Linux and FreeBSD; on Windows and macOS, `cluster()` runs the app in a single process and logs a warning. Crashed workers are restarted, with a back-off if they keep crashing.

### Native HTTPS (TLS)

```javascript
import fs from 'fs';
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    https: {
        cert: fs.readFileSync('./fullchain.pem'), // leaf + intermediates
        key: fs.readFileSync('./key.pem')
    }
});

app.get('/', (req, res) => res.send('Secure connection!'));
app.listen(443);
```

TLS 1.2 is limited to forward-secret AEAD cipher suites (ECDHE with AES-GCM or ChaCha20), TLS 1.3 is enabled, and client-initiated renegotiation is refused. Every current browser and HTTP client connects; very old clients (IE on Windows 7, Java 7) do not.

### Health Checks & Metrics

```javascript
const app = new Kidlat({
    health: {
        checks: { database: () => db.ping(), cache: () => redis.ping() }, // each must resolve within 2 s
    },
    metrics: true,
});
```

| Endpoint | |
|---|---|
| `GET /health` | **Liveness** — `200` as long as the process can answer |
| `GET /ready` | **Readiness** — `200` when every check passes, `503` (with per-check details) when one fails or times out, and while the server is draining for shutdown. Point your load balancer here. |
| `GET /metrics` | **Prometheus** text format: requests by method / route pattern / status, a latency histogram per route, open connections, memory, CPU, event-loop delay |

Health routes are registered ahead of CORS, rate limiting and your own hooks, so probes are never throttled or blocked by auth. Restrict scraping with `metrics: { allow: (req) => … }`, move it with `metrics: { path: '/internal/metrics' }`, or set `path: false` and serve `app.metrics.render()` yourself. Paths are configurable for health too (`path`, `readyPath`, `timeout`).

### Graceful Shutdown

```javascript
app.listen(3000);
app.enableGracefulShutdown({
    drainDelay: 10_000, // /ready answers 503 this long before the server stops accepting
    timeout: 30_000, // max wait for in-flight requests
    onShutdown: () => db.close(), // runs after the server has closed
});
```

On `SIGTERM` or `SIGINT`, Kidlat reports "not ready" so the load balancer drains it, finishes in-flight requests (answered with `Connection: close`), runs `onShutdown`, and exits. A second signal exits immediately. Calling the returned function triggers the same sequence by hand.

For full control, `await app.close()` does just the middle part: stop accepting, finish in-flight requests, close idle keep-alive sockets.

### Server Options

| Option | Default | |
|---|---|---|
| `bodyLimit` | `1048576` | bytes; bigger bodies get `413`. Also a route option, to raise or lower it per route |
| `keepAliveTimeout` | `30000` | ms an idle keep-alive socket stays open |
| `headersTimeout` | `30000` | ms to receive a request head, from its first byte → `408` (slow-drip guard) |
| `requestTimeout` | `120000` | ms to receive a whole request (head + body) from its first byte → `408`; also the max time a request may wait for its response with no I/O (`0` = off). Streaming responses that keep writing are not cut off |
| `maxConnections` | `16384` | over the cap, new sockets get `503`. On Linux, Kidlat warns at startup if the open-file limit (`ulimit -n`) is too low for this |
| `defaultHeaders` | `{ 'X-Content-Type-Options': 'nosniff' }` | added to every response; `{}` sends none. Wins over `securityHeaders` |
| `securityHeaders` | off | `true` or `{ contentSecurityPolicy, strictTransportSecurity, frameOptions, referrerPolicy, crossOriginOpenerPolicy, crossOriginResourcePolicy, permittedCrossDomainPolicies }` (each a string, `false`, or for HSTS `{ maxAge, includeSubDomains, preload }`) |
| `cookies` | off | `{ secret }` (string or array, 32+ characters) for signed cookies |
| `logger` | `false` | `true`, `{ level, stream }`, or your own logger object with `info()` / `child()` |
| `health` | off | `true` or `{ path, readyPath, checks, timeout }` — see [Health Checks & Metrics](#health-checks--metrics) |
| `metrics` | off | `true` or `{ path, allow, buckets, exclude }` |
| `trustProxy`, `ignoreTrailingSlash`, `genReqId`, `reusePort`, `backlog` | | |

## 📊 Benchmarks

Every Kidlat release on the same machine, routes and load: one server process on a 12-thread Windows machine (Node 24), 100 connections, median of at least 6 rounds in random order. The load generator runs on the same machine as the server, so absolute numbers are modest; compare the versions with each other.

**Requests per second** (higher is better)

| Scenario | Kidlat 1.x | Kidlat 2.2 | Kidlat 2.3 | **Kidlat 2.4** |
|---|---|---|---|---|
| `GET /` → JSON, pipelining 10 | 11.0k | 37.8k | 51.9k | **50.1k** |
| `GET /user/:id`, pipelining 10 | 11.4k | 42.3k | 48.1k | **44.7k** |
| `POST /echo` (parse and echo JSON), pipelining 10 | 9.5k | 28.4k | 25.2k | **33.4k** |
| `GET /` → JSON | 7.8k | 10.9k | 12.6k | **12.4k** |
| `GET /user/:id` | 7.2k | 10.8k | 9.7k | **10.7k** |
| `POST /echo` (parse and echo JSON) | 7.1k | 8.4k | 7.6k | **9.9k** |

**Server CPU per request, pipelining 10** (lower is better — the steadier measure on a shared machine)

| Scenario | Kidlat 1.x | Kidlat 2.2 | Kidlat 2.3 | **Kidlat 2.4** |
|---|---|---|---|---|
| `GET /` → JSON | 74.1 µs | 17.4 µs | 16.2 µs | **16.5 µs** |
| `GET /user/:id` | 66.7 µs | 17.6 µs | 17.1 µs | **17.5 µs** |
| `POST /echo` (parse and echo JSON) | 93.2 µs | 27.0 µs | 31.7 µs | **21.8 µs** |
| Memory under load | 207 MB | 68 MB | 68 MB | **68 MB** |
| Crashes | 10 of 36 runs | none | none | **none** |

Kidlat 2.x serves 3.5–4.5× the requests of 1.x at pipelining 10, using about a quarter of the CPU per request and a third of the memory. 2.4 serves about 30% more JSON `POST` requests than 2.3 at about 30% less CPU each; on `GET` routes 2.3 and 2.4 are within run-to-run variation, with the same CPU per request. Kidlat 1.x can crash under load — upgrade to 2.x. Independent Linux results are published by [KidlatJS/benchmarks](https://github.com/KidlatJS/benchmarks).

A benchmark gate runs nightly and on every release tag in CI, and fails the build if a change makes Kidlat slower.

## ⚙️ How it works

Most Node.js web frameworks sit on top of Node's built-in `http` module, which builds JavaScript Streams and EventEmitters for every connection and request.

**Kidlat** replaces that whole network layer:

- **Native I/O.** The C++ layer accepts sockets on Node's own libuv loop, parses heads in place from a shared read buffer, and crosses into JavaScript once per request.
- **Native response headers.** The full HTTP response head — status line, Content-Type, Content-Length, Date, Connection — is assembled directly in C++ from a pre-computed status table and a cached Date header. On the common path, zero JS strings are allocated for the head, eliminating millions of short-lived allocations per second that would pressure V8's garbage collector.
- **Routing in the parser.** Routes are registered in a C++ segment-level trie, consulted while the request head is parsed: static routes by a hash-map lookup, dynamic `:param` routes by the trie. The route and parameter offsets reach JavaScript in a shared buffer, with no extra native call. Anything the native table can't decide exactly (RegExp-constrained parameters) goes to the JavaScript router, which stays the source of truth.
- **Small bodies arrive with the request.** A `Content-Length` body up to 16 KB that is already received is handed over together with the head, so `req.json()` resolves without waiting for more events.
- **One-call responses.** A response without custom headers is built entirely in C++ — status line, headers and body, encoded to UTF-8 once.
- **Batched, in-order writes.** Every response produced while handling one socket read — including async handlers that resolve immediately — goes out in a single `try_write` syscall, in request order.
- **Lean JavaScript side.** Each route is compiled into a flat array of steps when it is registered; routes with no hooks, middleware or validation call the handler directly. A synchronous route never allocates a promise, and request fields are parsed only when you read them.
- **Fresh objects for every request.** `req` and `res` are never reused, so state an app attaches to them (`req.user`, sessions) can't reach another request.

## 🔄 Upgrading from 1.x

Most apps need no changes. Check these:

- **Node.js 20+** is required.
- `res.send(object)` now sends **JSON** (1.x sent `"[object Object]"`).
- **Response schemas** serialize only declared properties — declare every field you return.
- **Schema `default` values** are now applied to bodies, query strings and params.
- `listen()` **throws** if the port can't be bound (e.g. `EADDRINUSE`) and returns the bound port.
- HTTP/1.1 requests without a `Host` header get `400`.
- `requestTimeout` now limits how long a client may take to **send** a request (→ `408`).
- `cluster()` uses multiple processes on Linux/FreeBSD only.

The [CHANGELOG](https://github.com/KidlatJS/Kidlat/blob/main/CHANGELOG.md) has the full list with what to do for each.

The [SECURITY](https://github.com/KidlatJS/security) Reproducible security tests for Kidlat: parser fuzzing, request-smuggling probes, a soak test and a TLS scan. Every run records the exact environment, inputs and raw results in [results/](https://github.com/KidlatJS/security/tree/main/results).
## 📄 License
Licensed under [MIT](https://github.com/kidlatjs/kidlat/blob/HEAD/LICENSE).