# Kidlat Guides

A practical guide to building with Kidlat 2.x (up to date with 2.5) — from a first
route to running it in production. Each section stands on its own; skim the table of contents and jump in.

Kidlat is a web framework for Node.js whose network layer — sockets, TLS, HTTP
parsing — is native C++, with routing, validation, serialization and logging built
in. It has **no runtime dependencies**.

## Contents

1. [Getting started](#1-getting-started)
2. [Routing](#2-routing)
3. [Requests](#3-requests)
4. [Responses](#4-responses)
5. [Validation & serialization](#5-validation--serialization)
6. [The request lifecycle: hooks & middleware](#6-the-request-lifecycle-hooks--middleware)
7. [Errors](#7-errors)
8. [Plugins & scopes](#8-plugins--scopes)
9. [Streaming & Server-Sent Events](#9-streaming--server-sent-events)
10. [Logging](#10-logging)
11. [Security](#11-security)
12. [HTTPS](#12-https)
13. [Running in production](#13-running-in-production)
14. [Scaling: clustering & worker threads](#14-scaling-clustering--worker-threads)
15. [Testing your app](#15-testing-your-app)
16. [What Kidlat doesn't do (and what to use instead)](#16-what-kidlat-doesnt-do-and-what-to-use-instead)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Getting started

Requires **Node.js 20 or newer**. Prebuilt binaries ship for Windows x64, macOS
(Apple Silicon and Intel) and Linux x64 and arm64 (glibc and musl/Alpine) — no
compiler needed.

```bash
npm install kidlat
```

Kidlat is an ES module. Use `import` (and `"type": "module"` in your
`package.json`, or `.mjs` files).

```javascript
// server.mjs
import { Kidlat } from 'kidlat';

const app = new Kidlat();

app.get('/', () => 'Hello from Kidlat!');

const port = app.listen(3000);
console.log(`Listening on http://localhost:${port}`);
```

```bash
node server.mjs
```

### `listen()`

```javascript
app.listen(3000); // all interfaces, IPv4 + IPv6
app.listen(3000, '127.0.0.1'); // one interface (an IP address or 'localhost')
app.listen({ port: 3000, host: '::1' });
const port = app.listen(0); // any free port — handy in tests
app.listen(3000, (port) => console.log(port));
```

`listen()` binds **synchronously** and returns the bound port. If it can't bind,
it **throws** — check `err.code` (`EADDRINUSE`, `EACCES`, …):

```javascript
try {
    app.listen(3000);
} catch (err) {
    if (err.code === 'EADDRINUSE') console.error('Port 3000 is already in use');
    throw err;
}
```

`app.address()` returns `{ port }`, and `app.printRoutes()` lists the registered
routes.

---

## 2. Routing

```javascript
app.get('/users', listUsers);
app.post('/users', createUser);
app.put('/users/:id', replaceUser);
app.patch('/users/:id', updateUser);
app.delete('/users/:id', deleteUser);
app.head('/users', headUsers); // rarely needed: HEAD falls back to GET
app.options('/users', optionsUsers);
app.all('/ping', ping); // every method above
app.route({ method: ['GET', 'POST'], url: '/multi', handler });
```

Every method also accepts an options object (for schemas, route-level hooks,
`bodyLimit`, `rateLimit` or `config`) before the handler, or with the handler
inside it:

```javascript
app.post('/users', { schema: { body: userSchema } }, createUser);
app.post('/users', { schema: { body: userSchema }, handler: createUser });
app.post('/upload', { bodyLimit: 10 * 1024 * 1024 }, upload); // this route only
app.post('/login', { rateLimit: { max: 5, window: 60_000 } }, login); // see §11
```

### Parameters and wildcards

```javascript
app.get('/users/:id', (req) => req.params.id); // '/users/42' → '42'
app.get('/users/:id/posts/:post', (req) => req.params); // { id, post }
app.get('/files/:id(^\\d+$)', byNumber); // only digits
app.get('/files/:name', byName); // everything else
app.get('/assets/*', (req) => req.params['*']); // '/assets/css/a.css' → 'css/a.css'
```

- Parameters match **one path segment**. Values are percent-decoded
  (`/users/a%20b` → `'a b'`); a malformed escape gets `400`.
- Parameters are **strings**. Use a `params` schema to get numbers (see §5).
- The wildcard must be the last segment.

### Which route wins

At every segment: a **static** segment beats a **parameter**, which beats a
**wildcard**. Constrained parameters (`:id(…)`) are tried before plain ones.
Kidlat backtracks, so `/users/new/edit` and `/users/:id/profile` both work.

```javascript
app.get('/users/me', me); // GET /users/me → me
app.get('/users/:id', byId); // GET /users/42 → byId
```

### Trailing slashes

By default `/about` and `/about/` are different routes. To treat them the same:

```javascript
const app = new Kidlat({ ignoreTrailingSlash: true });
```

### Not found

Unmatched requests get `404 Not Found` (and `405 Method Not Allowed` for methods
Kidlat doesn't know). To customise:

```javascript
app.setNotFoundHandler((req, res) => res.code(404).json({ error: `No route for ${req.method} ${req.path}` }));
```

---

## 3. Requests

Most request fields are parsed **only when you first read them**, so you don't pay
for what you don't use.

| Property | |
|---|---|
| `req.method`, `req.url`, `req.path` | `url` includes the query string, `path` doesn't |
| `req.params` | route parameters |
| `req.query` | parsed query string |
| `req.headers` | lower-cased names; `req.header('X-Api-Key')` for a single header |
| `req.ip`, `req.ips` | client address (see `trustProxy` below) |
| `req.protocol`, `req.hostname` | `'http'`/`'https'`, host without port (`''` if the request has no valid host) |
| `req.httpVersion` | `'1.1'` or `'1.0'` |
| `req.cookies`, `req.signedCookies` | parsed cookies (see [Cookies](#cookies)) |
| `req.id` | request id (`req-1`, `req-2`, … or your `genReqId`) |
| `req.log` | logger bound to this request's id |
| `req.parsedBody` / `req.body` | the body after JSON parsing / schema validation |
| `req.aborted` | `true` if the client disconnected mid-request |
| `req.fingerprint` | SHA-256 of IP + User-Agent + Accept-Language |

### Query strings

```
/search?q=hello+world&tag=a&tag=b&flag
```

```javascript
req.query  // { q: 'hello world', tag: ['a', 'b'], flag: '' }
```

`+` decodes to a space, repeated keys become arrays, values are always strings
(or arrays of strings) — use a `querystring` schema for numbers and booleans.

### Headers

Repeated headers are joined with `, ` (`Cookie` with `; `), except headers that
may only appear once (`Host`, `Content-Type`, `Authorization`, …) where the first
value wins.

### Bodies

```javascript
app.post('/echo', async (req, res) => {
    const data = await req.json(); // parsed JSON (an empty body gives {})
    // or: await req.text()  — UTF-8 string
    // or: await req.buffer() — raw Buffer
    res.json(data);
});
```

- Bodies larger than **`bodyLimit`** (default 1 MB) are answered with
  `413 Payload Too Large` — immediately if `Content-Length` says so, otherwise as
  soon as the limit is crossed. Set `new Kidlat({ bodyLimit: 10 * 1024 * 1024 })`
  for the whole app, or `{ bodyLimit }` in a route's options to raise or lower it
  for one route.
- Invalid JSON rejects with an error whose `statusCode` is `400`; if you don't
  catch it, the client gets `400 Invalid JSON`.
- JSON containing `__proto__` (or `constructor.prototype`) is rejected with `400`,
  to protect against prototype pollution.
- Chunked uploads and `Expect: 100-continue` work transparently.

### Forms and file uploads

`req.formData(limits?)` parses `multipart/form-data` and
`application/x-www-form-urlencoded` bodies:

```javascript
app.post('/avatar', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const { fields, files } = await req.formData({
        maxFiles: 1,
        maxFileSize: 2 * 1024 * 1024,
        allowedTypes: ['image/png', 'image/jpeg'],
    });
    const [file] = files; // { fieldName, filename, contentType, size, data }
    await storage.put(`avatars/${crypto.randomUUID()}`, file.data);
    return { name: fields.displayName };
});
```

| Limit | Default | Over it |
|---|---|---|
| `maxFields` | 100 | `413` |
| `maxFieldSize` | 100 KB | `413` |
| `maxFiles` | 10 | `413` |
| `maxFileSize` | no limit (the route's `bodyLimit` still applies) | `413` |
| `allowedTypes` | any | `415` |

- Other content types get `415`; malformed bodies (missing boundary, bad part
  headers, part headers over 8 KB) get `400`.
- Repeated field names become arrays, like query strings. `fields` has no
  prototype.
- `filename` loses any directory part, but it is still client input — don't use
  it as a path on disk.
- The whole body is buffered in memory (capped by `bodyLimit`); `file.data` is a
  `Buffer` view into it, not a copy. For very large uploads, upload straight to
  object storage (e.g. pre-signed URLs) instead.

### Cookies

```javascript
app.get('/', (req) => req.cookies.theme ?? 'light'); // parsed on first use

app.post('/prefs', (req, res) => {
    res.cookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 }); // maxAge in seconds
    res.clearCookie('legacy');
    return { ok: true };
});
```

Defaults are `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` when the request
came over HTTPS (`req.protocol`, so `trustProxy` counts). Options: `maxAge`,
`expires` (a `Date`), `domain`, `path`, `secure`, `httpOnly`, `sameSite`
(`'strict'`, `'lax'`, `'none'` or `false`), `partitioned`, `signed`.

Settings a browser would reject or mis-scope **throw** instead of being sent:
invalid names, `;` or control characters in `path`/`domain`, `sameSite: 'none'`
without `secure`, and `__Secure-` / `__Host-` names without their required
attributes.

**Signed cookies** can't be changed by the client without detection:

```javascript
const app = new Kidlat({ cookies: { secret: process.env.COOKIE_SECRET } }); // 32+ characters

res.cookie('uid', user.id, { signed: true });
req.signedCookies.uid; // the value, or undefined if missing or tampered with
```

The signature (HMAC-SHA256) covers the name and value, so a signed value can't be
copied into another cookie. To rotate keys, pass an array — `secret: [newKey,
oldKey]` — new cookies are signed with the first, and any of them verifies.
Signing proves a value came from you; it doesn't hide it. Don't put secrets in
cookies.

### Behind a proxy

When Kidlat runs behind a load balancer or reverse proxy, the socket address is
the proxy's. Set `trustProxy` to read the client's from `X-Forwarded-*`:

```javascript
new Kidlat({ trustProxy: true }); // one proxy: the socket peer
new Kidlat({ trustProxy: 2 }); // CDN → load balancer → Kidlat
new Kidlat({ trustProxy: ['10.0.0.0/8', 'loopback'] }); // proxies by address / CIDR
new Kidlat({ trustProxy: (addr, hop) => addr.startsWith('10.') });

req.ip // the client: the first hop (from the socket outwards) that isn't a trusted proxy
req.ips // client first, then the trusted proxies, socket peer last
req.protocol // from X-Forwarded-Proto ('http' or 'https' only)
req.hostname // from X-Forwarded-Host, if it is a well-formed host[:port]
```

Address lists accept IPs, CIDR ranges and the presets `'loopback'`,
`'linklocal'` and `'uniquelocal'` (private ranges).

Kidlat walks `X-Forwarded-For` from the right, because proxies **append** the
address they saw: the leftmost entries are whatever the client sent. So set the
number of proxies (or their ranges) correctly:

- **Too few** (e.g. `true` behind CDN → load balancer): every client looks like
  the CDN edge's address, and they share one rate limit.
- **Too many**: a client can prepend a fake address and use it as their IP.

`X-Forwarded-Proto` and `-Host` are read only when the socket peer is trusted,
and the value added by the nearest proxy wins.

> **Changed in 2.5:** `trustProxy: true` used to take the *leftmost*
> `X-Forwarded-For` entry, which a client can forge. It now means exactly one
> trusted proxy.

---

## 4. Responses

### Sending

```javascript
res.send('text'); // text/plain; charset=utf-8
res.send(Buffer.from([1, 2])); // application/octet-stream
res.send({ ok: true }); // JSON
res.send(readableStream); // chunked (see §9)
res.send(); // empty body

res.json({ ok: true }); // JSON, through the response schema if there is one
res.code(201).json(created); // status() is an alias of code()
res.json(created, 201); // same — but an explicit status()/code() call wins
res.redirect('/login'); // 302; res.redirect('/new', 301) or res.redirect(301, '/new')
res.cookie('theme', 'dark'); // see §3 Cookies
```

Status codes must be integers from 100 to 999; anything else throws a
`TypeError`. Don't pass request input (`res.code(req.query.code)`) straight
through.

Or just **return** a value from the handler — strings, objects, Buffers and
streams are sent the same way:

```javascript
app.get('/user/:id', async (req) => {
    const user = await db.users.find(req.params.id);
    return user; // sent as JSON
});
```

A handler that neither sends nor returns anything leaves the request hanging until
a timeout — make sure every path responds.

### Headers

```javascript
res.header('Cache-Control', 'no-store');
res.header('Set-Cookie', ['a=1; HttpOnly', 'b=2; Secure']); // arrays → one header line each
res.headers({ 'X-One': '1', 'X-Two': '2' });
res.type('text/html; charset=utf-8');
res.getHeader('cache-control');  res.hasHeader('x-one');  res.removeHeader('x-one');
```

- Control characters (CR, LF, NUL, …) are stripped from header values, so
  input can't inject header lines.
- `Content-Length`, `Transfer-Encoding` and `Connection` are always computed by
  Kidlat. Setting `Connection: close` closes the connection after the response.
- Every response gets `Date`, `Connection` and `X-Content-Type-Options: nosniff`.
  Change the defaults with `new Kidlat({ defaultHeaders: { … } })` (or `null`),
  and add the usual API security headers with `securityHeaders: true` (§11).
  `res.header()` overrides a default for one response.

### Automatic behaviour

- `HEAD` requests get the headers (including the correct `Content-Length`) without a body.
- `204`, `304` and `1xx` responses never have a body or `Content-Length`.
- `res.sent` tells you whether a response has gone out; sending twice is ignored.

---

## 5. Validation & serialization

Schemas are standard **JSON Schema**. Kidlat compiles each one into a specialised
function when the route is registered, so validating costs very little per request.

### Validating input

```javascript
app.post('/users', {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'email'],
            properties: {
                username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-z0-9_]+$' },
                email: { type: 'string', format: 'email' },
                age: { type: 'integer', minimum: 13 },
                role: { type: 'string', enum: ['user', 'admin'], default: 'user' },
            },
            additionalProperties: false,
        },
        querystring: {
            type: 'object',
            properties: { dryRun: { type: 'boolean', default: false } },
        },
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        headers: { type: 'object', required: ['x-api-key'], properties: { 'x-api-key': { type: 'string' } } },
    },
}, (req) => {
    req.parsedBody; // validated body, with role defaulted to 'user'
    req.query.dryRun; // a real boolean
});
```

- **Defaults** are filled in for missing properties.
- **Query strings, params and headers are strings on the wire**, so their
  validators **coerce** to the declared type: `"42"` → `42`, `"true"` → `true`,
  a single value → a one-element array for `type: 'array'`.
- Header names in schemas can be written in any case.

When validation fails, the handler doesn't run and the client gets `400`:

```json
{
  "error": "Bad Request",
  "details": [{
    "instancePath": "/username",
    "schemaPath": "#/properties/username/minLength",
    "keyword": "minLength",
    "params": { "limit": 3 },
    "message": "must NOT have fewer than 3 characters"
  }]
}
```

Validation stops at the first error. Invalid JSON gets `{ "error": "Invalid JSON body" }`.

### Serializing output

A response schema makes JSON output faster **and** acts as an allow-list — only
declared properties are sent:

```javascript
app.get('/me', {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: { id: { type: 'integer' }, name: { type: 'string' } },
            },
            '4xx': { type: 'object', properties: { error: { type: 'string' } } },
        },
    },
}, async (req) => {
    return db.users.find(req.userId); // passwordHash, tokens… are never sent
});
```

Keys can be an exact status (`200`), a class (`'2xx'`, `'4xx'`) or `default`.
`additionalProperties: true` lets undeclared fields through.

### Shared schemas

```javascript
app.addSchema({
    $id: 'user',
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
});

app.post('/users', { schema: { body: { $ref: 'user#' } } }, create);
app.get('/users', { schema: { response: { 200: { type: 'array', items: { $ref: 'user#' } } } } }, list);
```

`$ref` also works with local pointers (`#/$defs/node`), including recursive schemas.

### Supported keywords

`type` (incl. arrays of types and `nullable`), `enum`, `const`, `required`,
`properties`, `additionalProperties`, `patternProperties`, `propertyNames`,
`minProperties`, `maxProperties`, `dependentRequired`, `dependencies`, `minLength`,
`maxLength`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `items`, `prefixItems`, `additionalItems`,
`minItems`, `maxItems`, `uniqueItems`, `contains`, `allOf`, `anyOf`, `oneOf`, `not`,
`if`/`then`/`else`, `default`, `$ref`.

Formats: `email`, `uri`, `uri-reference`, `uuid`, `date`, `date-time`, `time`,
`ipv4`, `ipv6`, `hostname`, `regex`, `json-pointer`, `byte`.

### Using the compilers directly

```javascript
import { compileValidator, compileSerializer } from 'kidlat';

const validate = compileValidator(schema, { coerceTypes: false, useDefaults: true });
if (!validate(data)) console.log(validate.errors);

const stringify = compileSerializer(schema);
stringify(data); // JSON string
```

---

## 6. The request lifecycle: hooks & middleware

Every request goes through these stages, in order. Any stage can send a response,
which ends the request there.

```
onRequest hooks → route matching → preValidation hooks → schema validation
  → preHandler hooks → middleware (app.use) → handler
  → onSend hooks → response written → onResponse hooks
```

### Hooks

```javascript
app.addHook('onRequest', (req, res) => {
    if (!req.headers.authorization) res.code(401).send('Unauthorized'); // stops here
});

app.addHook('preHandler', async (req) => {
    req.user = await auth.verify(req.headers.authorization);
});

app.addHook('onSend', (req, res, payload) => {
    return payload; // return a new payload to replace it
});

app.addHook('onResponse', (req, res) => {
    metrics.observe(req.path, res.statusCode); // after the response went out
});
```

Hooks can be **sync**, **async**, or **callback style** `(req, res, done) => done()`.
Synchronous hooks and handlers never allocate a promise, so they're the fastest.

Hooks can also be attached to a single route (any hook name, including
`onResponse`):

```javascript
app.get('/admin', { preHandler: requireAdmin }, handler);
```

### Middleware

```javascript
app.use(async (req, res, next) => {
    const started = Date.now();
    await next(); // run the rest of the chain
    req.log.info({ ms: Date.now() - started }, 'timed'); // runs after the handler
});

app.use((req, res, next) => {
    loadSession(req, (err) => next(err)); // callback style works too
});
```

`next(err)` sends the error to the error handler.

> **Order matters.** A route captures the hooks and middleware registered
> **before** it. Register global hooks and `app.use()` first, routes after.

---

## 7. Errors

Throw (or reject) anywhere in a hook, middleware or handler:

```javascript
import { httpError } from 'kidlat';

app.get('/users/:id', async (req) => {
    const user = await db.users.find(req.params.id);
    if (!user) throw httpError(404, 'No such user');
    return user;
});
```

Any error with a numeric `statusCode` (or `status`) between 400 and 599 controls
the response. By default:

- **4xx** → that status, with the error's message as text.
- **5xx** and errors without a status → `500 Internal Server Error`; the message is
  **not** sent to the client, and the error is logged (to stderr if you didn't
  configure a logger) — crashes are never silent.

Custom error handler:

```javascript
app.setErrorHandler((err, req, res) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    res.code(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
});
```

If the error handler itself throws, or doesn't send anything, Kidlat falls back to
the default response.

---

## 8. Plugins & scopes

`register()` creates a **scope**: routes, hooks, middleware and error handlers
added inside it stay inside it.

```javascript
await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);
    admin.setErrorHandler((err, req, res) => res.code(403).json({ error: err.message }));
    admin.get('/stats', getStats); // → GET /admin/stats
}, { prefix: '/admin' });

app.get('/public', publicPage); // not affected by requireAdmin
```

A scope inherits everything registered on its parent before it. `register()` also
takes `rateLimit` — one counter shared by every route in the scope, or `false` to
drop the limiters it inherited (§11). Plugins can live
in their own files (`export default async function (app, opts) { … }`) — pass the
module or its default export to `register()`.

### Decorators

```javascript
app.decorate('db', db); // app.db
app.decorateRequest('user', null); // req.user (default value)
app.decorateResponse('ok', function (data) { return this.json({ ok: true, data }); });
```

`decorate` throws if the name already exists, so plugins can't silently overwrite
each other.

---

## 9. Streaming & Server-Sent Events

`res.stream(source, status?, contentType?)` — or `res.send(source)` / returning it —
sends a **chunked** response (to HTTP/1.0 clients, which have no chunked encoding:
the raw bytes, ended by closing the connection) from:

- a Node `Readable` (files, `stream.Readable.from(...)`, …)
- a web `ReadableStream`
- any **async iterable** (async generators)

```javascript
import fs from 'fs';

app.get('/download', (req, res) =>
    res.stream(fs.createReadStream('report.pdf'), 200, 'application/pdf'));
```

### Server-Sent Events

```javascript
app.get('/events', (req, res) => res.stream((async function* () {
    try {
        for (let i = 0; ; i++) {
            yield `data: ${JSON.stringify({ tick: i })}\n\n`;
            await new Promise((r) => setTimeout(r, 1000));
        }
    } finally {
        console.log('client went away'); // runs when the client disconnects
    }
})(), 200, 'text/event-stream'));
```

- **Backpressure:** if the client reads slowly, the source is paused instead of
  buffering in memory.
- **Disconnects:** when the client leaves, the source is stopped (the generator's
  `finally` runs; Node streams are destroyed) straight away.
- **Errors:** if the source fails halfway, the connection is aborted, so the
  client can't mistake a truncated body for a complete one.
- **Timeouts:** a stream that keeps writing is never cut off by `requestTimeout`.
  Send something (even a `: ping\n\n` comment) at least every couple of minutes.

---

## 10. Logging

```javascript
const app = new Kidlat({ logger: true }); // info level, stdout
const app = new Kidlat({ logger: { level: 'debug' } });
const app = new Kidlat({ logger: { level: 'info', stream: myWritable } });
const app = new Kidlat({ logger: myLogger }); // any object with info()/child()…
```

Logs are **newline-delimited JSON**:

```json
{"level":30,"time":1760410000000,"pid":4242,"hostname":"web-1","reqId":"req-3f","msg":"incoming request","req":{"method":"GET","url":"/users/7","remoteAddress":"10.0.0.9"}}
```

Levels: `trace` 10, `debug` 20, `info` 30, `warn` 40, `error` 50, `fatal` 60, `silent`.

```javascript
app.get('/orders', (req) => {
    req.log.info({ count: 3 }, 'loaded orders'); // carries this request's reqId
    req.log.error(new Error('boom')); // errors are serialised with stack
});
```

- With logging on, every request logs `incoming request` and `request completed`
  (with `responseTime` in ms). Turn that off with `disableRequestLogging: true`.
- Logs are buffered and written asynchronously, and flushed on exit. If the
  destination can't keep up, at most 4 MB of log lines wait in memory; further
  lines are dropped and a `warn` line says how many.
- Custom request ids: `new Kidlat({ genReqId: (req) => req.headers['x-request-id'] ?? crypto.randomUUID() })`.
- `import { Logger } from 'kidlat'` gives you the same logger for the rest of your app.

---

## 11. Security

Most protections are on by default. Here's what Kidlat does for you, and what you
should configure.

### Built in

- **Strict HTTP parsing** — requests with ambiguous framing (both
  `Content-Length` and `Transfer-Encoding`, duplicate `Content-Length`, unknown
  transfer codings, whitespace before a colon, line folding, bare LF, control
  characters, malformed chunk sizes and trailers) are rejected. This is what
  prevents **request smuggling** behind a proxy.
- **Host checks** — an absolute-form URL (`GET http://host/path`) must match
  `Host`, and may not contain userinfo (`user@host`); the `*` target is only
  allowed for `OPTIONS`.
- **Size limits** — URL 8 KB (`414`), headers 64 KB / 200 fields (`431`),
  body `bodyLimit` (`413`).
- **Slow-client limits** — `headersTimeout` (30 s) and `requestTimeout` (120 s)
  count from a request's **first byte**, so a client trickling bytes can't hold a
  connection open (`408`). A TLS handshake must also finish within
  `headersTimeout`.
- **Connection cap** — `maxConnections` (16384); extra connections get `503`.
- **Header injection** — control characters are stripped from response header
  values, and the native writer refuses a malformed header block.
- **Prototype pollution** — JSON bodies with `__proto__` (also when spelled with
  `\u` escapes) are rejected.
- **`X-Content-Type-Options: nosniff`** on every response.

### Security headers

```javascript
const app = new Kidlat({ securityHeaders: true });
```

adds the OWASP defaults for APIs to every response:

| Option | Header | Default |
|---|---|---|
| `contentSecurityPolicy` | `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `strictTransportSecurity` | `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `frameOptions` | `X-Frame-Options` | `DENY` |
| `referrerPolicy` | `Referrer-Policy` | `no-referrer` |
| `crossOriginOpenerPolicy` | `Cross-Origin-Opener-Policy` | `same-origin` |
| `crossOriginResourcePolicy` | `Cross-Origin-Resource-Policy` | `same-origin` |
| `permittedCrossDomainPolicies` | `X-Permitted-Cross-Domain-Policies` | `none` |

Change one with a string, or turn it off with `false`. HSTS also takes
`{ maxAge, includeSubDomains, preload }`:

```javascript
new Kidlat({
    securityHeaders: {
        contentSecurityPolicy: "default-src 'self'", // serving HTML
        strictTransportSecurity: { maxAge: 63072000, preload: true },
        crossOriginResourcePolicy: false,
    },
});
```

Unknown options, and `preload` without a one-year `maxAge` and
`includeSubDomains`, throw at startup. The headers are part of the precomputed
default header block, so they cost nothing per request; `defaultHeaders` and
`res.header()` override them.

### CORS

```javascript
const app = new Kidlat({
    cors: {
        origin: ['https://app.example.com', /\.example\.com$/], // or '*', a string, a RegExp, or (origin, req) => boolean
        methods: 'GET,POST,PUT,DELETE',
        headers: 'Content-Type,Authorization',
        exposedHeaders: 'X-Request-Id',
        credentials: true,
        maxAge: 86400,
    },
});
```

With a list, RegExp or function, the request's `Origin` is reflected when allowed
(with `Vary: Origin`). `OPTIONS` requests are answered `204` with the preflight
headers.

`origin: '*'` together with `credentials: true` **throws at startup**: it would let
any website read responses for a signed-in user. List the allowed origins instead.

### Rate limiting

```javascript
const app = new Kidlat({
    rateLimit: {
        max: 100, // requests…
        window: 60_000, // …per minute
        keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
        allowList: ['10.0.0.5'],
    },
});
```

Over the limit: `429` with `Retry-After`; every response carries
`X-RateLimit-Limit/Remaining/Reset`.

| Option | Default | |
|---|---|---|
| `max`, `window` | 100, 60 000 ms | requests per fixed window |
| `keyGenerator` | client IP | `(req) => key` |
| `allowList` | — | keys (or IPs) that are never limited |
| `ipv6Subnet` | `64` | IPv6 clients are grouped by this prefix, because one subscriber usually owns a whole /64; `128` = per address |
| `maxKeys` | 100 000 | clients tracked at once; past it the oldest entry is dropped |
| `skipSuccessfulRequests` | `false` | only responses with status ≥ 400 count — for login forms |
| `hook` | `'onRequest'` | `'preHandler'` runs after validation, so `keyGenerator` can use `req.body` |

#### Per route and per scope

Limits stack: the app-wide limiter runs first, then those of the scope and the
route.

```javascript
// its own counter, on top of the app-wide limit
app.post('/login', {
    schema: { body: loginSchema }, // fills req.body before preHandler
    rateLimit: {
        max: 5, window: 15 * 60_000,
        skipSuccessfulRequests: true,
        hook: 'preHandler',
        keyGenerator: (req) => `${req.ip}:${req.body.username}`,
    },
}, login);

// one counter shared by every route in the scope
await app.register(apiRoutes, { prefix: '/api', rateLimit: { max: 1000 } });

// no limiter at all (drops the inherited ones)
app.get('/internal/status', { rateLimit: false }, status);
```

`rateLimit` also takes an array to apply several limiters (e.g. per second and
per hour).

Counters are per process — with `cluster()` or several instances, each counts
separately. For a shared limit, rate-limit at your load balancer or edge.

### Checklist for production

- Set `trustProxy` to the number (or address ranges) of proxies in front of
  Kidlat — no more (§3).
- Turn on `securityHeaders: true`.
- Lower `bodyLimit` on routes that don't need big bodies — or raise it only where needed.
- Give login and password-reset routes their own `rateLimit`.
- Sign session cookies (`cookies: { secret }`) and keep the secret out of the repo.
- Use response schemas on anything that returns database rows, so internal fields can't leak.
- Never send `err.message` of 5xx errors to clients (the default handler doesn't).

---

## 12. HTTPS

```javascript
import fs from 'fs';

const app = new Kidlat({
    https: {
        cert: fs.readFileSync('/etc/ssl/fullchain.pem'), // leaf certificate + intermediates
        key: fs.readFileSync('/etc/ssl/privkey.pem'), // unencrypted PEM key
    },
});
app.listen(443);
```

- Use the **full chain** file (e.g. `fullchain.pem` from Let's Encrypt), not just
  the leaf certificate — clients need the intermediates.
- **TLS 1.2 and 1.3** only. TLS 1.2 is limited to forward-secret, authenticated
  cipher suites (ECDHE with AES-GCM or ChaCha20); client-initiated renegotiation is
  refused. Every current browser and HTTP client connects; very old ones (IE on
  Windows 7, Java 7) don't.
- A wrong key or an unreadable certificate makes `listen()` throw with a clear
  message, instead of failing on the first connection.
- With `cluster()`, workers share a session-ticket key automatically so TLS
  sessions resume on any worker. Running several machines? Set the same
  `KIDLAT_TLS_TICKET_KEY` (96 hex characters) on each.

Often simpler: terminate TLS at your load balancer or reverse proxy and run Kidlat
on plain HTTP behind it (with `trustProxy` set, §3).

---

## 13. Running in production

### Health checks & metrics

```javascript
const app = new Kidlat({
    logger: { level: 'info' },
    trustProxy: true,
    health: {
        checks: { database: () => db.ping(), cache: () => redis.ping() },
        timeout: 2000, // per check
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

### Graceful shutdown

```javascript
app.listen(3000);
app.enableGracefulShutdown({
    drainDelay: 10_000, // keep serving while /ready reports 503, so the LB can drain
    timeout: 30_000, // max wait for in-flight requests
    onShutdown: () => db.close(), // after the server has closed
});
```

On `SIGTERM` or `SIGINT`: `/ready` turns `503` and responses carry
`Connection: close` → after `drainDelay` the server stops accepting → in-flight
requests finish → `onShutdown()` → exit. A second signal exits immediately.
The function it returns triggers the same sequence by hand.

Without the helper, `await app.close()` stops accepting, finishes in-flight
requests and closes idle keep-alive connections.

### Timeouts and your load balancer

| Option | Default | Set it to |
|---|---|---|
| `keepAliveTimeout` | 30 s | **a few seconds longer** than your load balancer's idle timeout (e.g. 65 s behind a 60 s ALB/nginx) — otherwise the LB can reuse a connection Kidlat just closed and return a 502 |
| `requestTimeout` | 120 s | at least your slowest legitimate upload |
| `headersTimeout` | 30 s | rarely needs changing |
| `maxConnections` | 16384 | what one instance should hold; needs an open-file limit above it |

### Open-file limit

Each connection uses a file descriptor. On Linux, Kidlat warns at startup if
`maxConnections` is above what the process's limit allows. Raise it:

```bash
ulimit -n 65536 # shell
# systemd unit: LimitNOFILE=65536
# Docker: docker run --ulimit nofile=65536:65536 …
```

### Docker

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

`--stop-timeout` should exceed `drainDelay + timeout`. Debian-based images
(`node:22`, `node:22-slim`) and Alpine images (`node:22-alpine`) all have prebuilt
binaries, on x64 and arm64.

---

## 14. Scaling: clustering & worker threads

### `cluster()` — one process per core (Linux)

```javascript
import { Kidlat, cluster } from 'kidlat';

cluster(() => {
    const app = new Kidlat();
    app.get('/', () => `Hello from ${process.pid}`);
    app.listen(3000);
}, { workers: 4 });  // default: one per CPU core
```

Every worker binds the same port with `SO_REUSEPORT` and the **kernel** spreads
connections across them. Crashed workers are restarted automatically, with a
back-off if they keep crashing.

This needs **Linux** (or FreeBSD). On Windows and macOS, `cluster()` runs your app
in a single process and prints a warning — scale those with several instances
behind a load balancer instead.

Each worker is a separate process: in-memory state (caches, rate-limit counters,
sessions) is per worker. Keep shared state in a database or cache.

### Worker threads

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

## 15. Testing your app

Listen on port `0`, use `fetch`, and close the app afterwards:

```javascript
// app.mjs
import { Kidlat } from 'kidlat';
export function buildApp() {
    const app = new Kidlat();
    app.get('/users/:id', { schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } },
        (req) => ({ id: req.params.id }));
    return app;
}
```

```javascript
// app.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.mjs';

test('GET /users/:id', async (t) => {
    const app = buildApp();
    const port = app.listen(0, '127.0.0.1');
    t.after(() => app.close());

    const res = await fetch(`http://127.0.0.1:${port}/users/7`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 7 });

    assert.equal((await fetch(`http://127.0.0.1:${port}/users/abc`)).status, 400);
});
```

```bash
node --test
```

Build the app in a function (like `buildApp` above) so each test gets a fresh
instance.

---

## 16. What Kidlat doesn't do (and what to use instead)

Kidlat keeps its core small. For these, add a library or a few lines of code:

| Need | Approach |
|---|---|
| **Sessions** | store a session id in a signed cookie (§3) and the data in Redis or your database |
| **Streaming uploads** (larger than memory) | `req.formData()` buffers the body — send large files straight to object storage with pre-signed URLs |
| **Static files** | serve them from a CDN or your reverse proxy; for a few files, `res.stream(fs.createReadStream(file), 200, type)` — validate the path so `..` can't escape your folder |
| **Compression** | let your reverse proxy / CDN compress responses |
| **HTTP/2, HTTP/3** | terminate them at your load balancer or proxy; Kidlat speaks HTTP/1.1 to it |
| **WebSockets** | not supported — run them on a separate service or port |
| **Templates / views** | render to a string with any template engine, then `res.type('text/html').send(html)` |

---

## 17. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `listen EADDRINUSE` | Another process uses the port. Find it: `ss -ltnp 'sport = :3000'` (Linux), `netstat -ano \| findstr :3000` (Windows). |
| `listen EACCES` | Ports below 1024 need extra privileges — use a higher port behind your load balancer. |
| `kidlat: no usable native binary for …` | Your platform has no prebuilt binary (supported: Windows x64, macOS arm64/x64, Linux x64/arm64 with glibc or musl), or the install is incomplete or mixed (`built for native ABI …`) — delete `node_modules/kidlat` and reinstall. |
| `TypeError` at startup naming `cors`, `rateLimit`, `securityHeaders`, `trustProxy` or `cookies.secret` | An invalid option — e.g. `origin: '*'` with `credentials: true`, or a cookie secret under 32 characters. The message says which. |
| `TypeError` from `res.cookie()` | The cookie would be rejected by browsers (e.g. `sameSite: 'none'` without `secure`, `__Host-` with a `domain`) — see §3 Cookies. |
| Every client has the same `req.ip` / shares one rate limit | `trustProxy` counts fewer proxies than you have (e.g. `true` behind CDN → load balancer) — set the hop count or ranges (§3). |
| `415` from `req.formData()` | The request isn't `multipart/form-data` or `application/x-www-form-urlencoded`, or a file type isn't in `allowedTypes`. |
| `TypeError: listen: host must be an IP address` | `listen()` takes an IP or `'localhost'`, not a hostname. |
| A route returns `400` with `details` | Schema validation failed — the `details` say which field and why. |
| `413 Payload Too Large` | Raise `bodyLimit` (for that route only, if you can), or a `formData()` limit. |
| `408 Request Timeout` | The client sent its request too slowly. For genuinely slow uploads, raise `requestTimeout`. |
| `503` with "Too many connections" | `maxConnections` reached — raise it (and the open-file limit) or add instances. |
| `502` at the load balancer, now and then | `keepAliveTimeout` is shorter than the load balancer's idle timeout — make it longer (§13). |
| A request never gets a response | A code path neither sends nor returns anything, or a hook awaited something that never settles. |
| Hook or middleware doesn't run for a route | It was registered **after** the route (§6), or in a different `register()` scope. |
| `cluster()` prints "running a single process" | You're on Windows or macOS — expected (§14). |
| Response is missing fields | A response schema doesn't declare them (§5) — add them or use `additionalProperties: true`. |
| `res.send(obj)` behaves differently than in 1.x | 2.x sends objects as JSON — see the CHANGELOG for all 1.x → 2.x changes. |
