# ⚡ Kidlat

**Kidlat** is a blazing fast, natively-compiled web framework for Node.js — with **zero runtime dependencies**.

Kidlat bypasses Node's `http` module entirely. TCP sockets, TLS termination and HTTP/1.1 parsing live in a custom C++ layer on `libuv` and N-API, and everything above it — router, JSON-Schema validator, response serializer, logger — is written for Kidlat from scratch.

> **Kidlat 2.0** is a ground-up rewrite: faster, dependency-free and continuously fuzzed. Upgrading from 1.x? See [Upgrading from 1.x](#-upgrading-from-1x) and the [CHANGELOG](CHANGELOG.md).

## 🚀 Features

- **Extreme performance:** pure C++ socket processing, synchronous `try_write` with response batching, and a request pipeline that never allocates a promise for a synchronous route (see [Benchmarks](#-benchmarks)).
- **Zero runtime dependencies:** routing, JSON-Schema validation, schema-driven serialization and structured logging are all built in. `npm install kidlat` installs Kidlat and nothing else.
- **Correct HTTP/1.1 pipelining:** responses always go out in request order, even when async handlers finish out of order.
- **Hardened parser:** strict framing rules against request smuggling (conflicting `Content-Length`/`Transfer-Encoding`, obs-fold, whitespace before colons, control bytes), limits on URL length, header size and count and pipelining depth, and deadlines that stop slow-drip (Slowloris) clients.
- **Native TLS/HTTPS:** terminated in C++; TLS 1.2+ with forward-secret AEAD ciphers only, full certificate chains, ALPN.
- **JSON Schema:** validate `body`, `querystring`, `params` and `headers` (with type coercion), and serialize responses from a schema that also acts as an allow-list.
- **Streaming:** Node streams, web streams and async iterables, with real backpressure — and released the moment the client disconnects.
- **Graceful shutdown:** `await app.close()` finishes in-flight requests and closes idle sockets.
- **Built-in CORS & rate limiting**, hooks, middleware, scoped plugins.
- **Multi-core clustering:** workers share the port via `SO_REUSEPORT` (Linux/FreeBSD).
- **Runs in `worker_threads`:** one independent server per thread.
- **Cross-platform:** prebuilt binaries for Windows, macOS (Intel & Apple Silicon) and Linux.
- **Tested continuously:** test matrix on Linux, Windows and Alpine with Node 20–26, AddressSanitizer + UBSan builds, coverage-guided fuzzing of the HTTP parser, soak tests, request-smuggling probes and TLS scanning.

## 📦 Installation

Requires **Node.js 20 or newer**.

```bash
npm install kidlat
```

Prebuilt binaries ship for Windows x64, macOS (arm64 and x64) and Linux x64, so no compiler is needed on those platforms.

## 🛠️ Quick Start

```javascript
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: true,          // structured JSON logs, one line per event
    bodyLimit: 1048576,    // 1 MB maximum payload size
    trustProxy: false      // set to true if behind Nginx/HAProxy
});

app.get('/', (req, res) => {
    res.send('Hello from Kidlat!');
});

// Returned values are sent: objects as JSON, strings as text
app.get('/api/info', () => ({ framework: 'Kidlat', speed: 'blazing' }));

app.post('/api/echo', async (req, res) => {
    const body = await req.json();       // also: req.text(), req.buffer()
    res.json({ success: true, received: body });
});

app.get('/users/:id', (req) => ({ id: req.params.id, q: req.query }));

const port = app.listen(3000);           // throws (e.g. EADDRINUSE) if it can't bind
console.log(`⚡ Kidlat server running on http://localhost:${port}`);
```

## 🧭 Routing

```javascript
app.get('/users/:id', handler);             // parameter
app.get('/files/:id(^\\d+$)', handler);     // parameter with a RegExp constraint
app.get('/assets/*', handler);              // wildcard → req.params['*']
app.all('/ping', handler);                  // every method
app.route({ method: ['GET', 'POST'], url: '/multi', handler });
```

Static segments beat parameters, which beat wildcards. `HEAD` falls back to the `GET` route automatically. Pass `ignoreTrailingSlash: true` to treat `/a/` like `/a`.

## 📨 Request & Response

| `req` | |
|---|---|
| `method`, `url`, `path`, `params`, `query`, `headers`, `header(name)` | parsed lazily |
| `ip`, `ips`, `protocol`, `hostname` | honour `X-Forwarded-*` when `trustProxy` is on |
| `json()`, `text()`, `buffer()` | body readers (JSON is guarded against `__proto__` poisoning) |
| `id`, `log`, `fingerprint`, `aborted` | |

| `res` | |
|---|---|
| `send(body, status?)` | string → text, Buffer → octet-stream, stream → chunked, object → JSON |
| `json(obj, status?)`, `status(code)` / `code(code)` | |
| `header(name, value)`, `headers(obj)`, `type(ct)`, `getHeader`, `removeHeader` | `value` may be an array |
| `redirect(url, code = 302)` | |
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
        max: 100,       // 100 requests
        window: 60000   // per minute per IP (keyGenerator / allowList available)
    }
});
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
                age:      { type: 'integer', minimum: 18 },
                role:     { type: 'string', enum: ['user', 'admin'], default: 'user' }
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
app.addHook('onSend',     (req, res, payload) => payload);      // may replace the payload
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

Each worker binds the port with `SO_REUSEPORT`, and the kernel spreads connections across them. That is available on Linux and FreeBSD; on Windows and macOS, `cluster()` runs the app in a single process and logs a warning. Crashed workers are restarted, with a back-off if they keep crashing.

### Native HTTPS (TLS)

```javascript
import fs from 'fs';
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    https: {
        cert: fs.readFileSync('./fullchain.pem'),   // leaf + intermediates
        key: fs.readFileSync('./key.pem')
    }
});

app.get('/', (req, res) => res.send('Secure connection!'));
app.listen(443);
```

TLS 1.2 is limited to forward-secret AEAD cipher suites (ECDHE with AES-GCM or ChaCha20), TLS 1.3 is enabled, and client-initiated renegotiation is refused. Every current browser and HTTP client connects; very old clients (IE on Windows 7, Java 7) do not.

### Graceful Shutdown

```javascript
process.on('SIGTERM', async () => {
    await app.close();     // stop accepting, finish in-flight requests, close keep-alive sockets
    process.exit(0);
});
```

In-flight requests are answered (with `Connection: close`) before the process exits; under load this typically takes a few hundred milliseconds.

### Server Options

| Option | Default | |
|---|---|---|
| `bodyLimit` | `1048576` | bytes; bigger bodies get `413` |
| `keepAliveTimeout` | `30000` | ms an idle keep-alive socket stays open |
| `headersTimeout` | `30000` | ms to receive a request head, from its first byte → `408` (slow-drip guard) |
| `requestTimeout` | `120000` | ms to receive a whole request (head + body) from its first byte → `408`; also the max time a request may wait for its response with no I/O (`0` = off). Streaming responses that keep writing are not cut off |
| `maxConnections` | `16384` | over the cap, new sockets get `503` |
| `defaultHeaders` | `{ 'X-Content-Type-Options': 'nosniff' }` | added to every response (`null` for none) |
| `logger` | `false` | `true`, `{ level, stream }`, or your own logger object with `info()` / `child()` |
| `trustProxy`, `ignoreTrailingSlash`, `genReqId`, `reusePort`, `backlog` | | |

## 📊 Benchmarks

Measured on a 12-thread Windows machine with 100 connections. The load generator ran on the same machine as the server, so absolute numbers are modest; compare them relative to each other. *CPU* is the server process's CPU time per request — lower is better.

| Scenario | Kidlat 1.x | Kidlat 2.0 |
|---|---|---|
| GET text | 25.5k req/s, 43 µs CPU | **30k req/s, 32 µs CPU** |
| GET text, pipelining 10 | 36k req/s, 31 µs CPU | **118k req/s, 8.5 µs CPU** |
| GET JSON + response schema | — | **27.7k req/s, 36 µs CPU** |
| POST + body validation | — | **22.4k req/s, 45 µs CPU** |
| POST + body validation, pipelining 10 | — | **91k req/s, 11 µs CPU** |

Run them yourself with `npm run bench`. A performance-regression benchmark also runs nightly in CI.

## ⚙️ How it works

Most Node.js web frameworks sit on top of Node's built-in `http` module, which builds JavaScript Streams and EventEmitters for every connection and request.

**Kidlat** replaces that whole network layer:

- **Native I/O.** The C++ layer accepts sockets on Node's own libuv loop, parses heads in place from a shared read buffer, and crosses into JavaScript once per request.
- **Batched, in-order writes.** Every response produced while handling one socket read — including async handlers that resolve immediately — goes out in a single `try_write` syscall, in request order.
- **Lean JavaScript side.** Each route is compiled into a flat array of steps when it is registered. A synchronous route runs without allocating a single promise, and request fields are parsed only when you read them.

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

The [CHANGELOG](CHANGELOG.md) has the full list with what to do for each.

## 🧪 Development

```bash
npm run build          # compile the native addon (node-gyp)
npm test               # protocol, framework, schemas, TLS, timeouts, limits,
                       # graceful shutdown, worker_threads, cluster (Linux)
npm run test:soak      # sustained load + aborting clients, checks for leaks
npm run bench          # throughput benchmarks
fuzz\run-windows.cmd   # fuzz the HTTP parser locally (Windows, needs Visual Studio)
```

CI runs on every push (Linux, Windows and Alpine with Node 20–26, sanitizer builds, parser fuzzing), and a nightly job adds longer fuzzing, a soak test, request-smuggling probes through nginx and a TLS scan.

## 📄 License
Licensed under [MIT](https://github.com/kidlatjs/kidlat/blob/HEAD/LICENSE).
