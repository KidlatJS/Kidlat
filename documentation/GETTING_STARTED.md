# Getting started

This page takes you from an empty folder to a small API with validation, error
handling and a WebSocket, in about ten minutes. Every step links to the guide that
covers it in depth.

## 1. Install

Requires **Node.js 20 or newer**. Prebuilt binaries ship for Windows x64, macOS
(Apple Silicon and Intel) and Linux x64 and arm64, with glibc or musl (Alpine) —
no compiler needed.

```bash
mkdir my-api && cd my-api
npm init -y
npm install kidlat
```

Kidlat is an ES module. Use `import`, and either add `"type": "module"` to your
`package.json` or name your files `.mjs`.

## 2. Your first server

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
curl http://localhost:3000/        # Hello from Kidlat!
```

A handler can **return** what it wants to send: a string is sent as text, an
object or array as JSON. You can also call `res.send()` yourself — see
[Responses](guides/03-responses.md).

### `listen()`

```javascript
app.listen(3000);                          // all interfaces, IPv4 + IPv6
app.listen(3000, '127.0.0.1');             // one interface (an IP address or 'localhost')
app.listen({ port: 3000, host: '::1' });
const port = app.listen(0);                // any free port — handy in tests
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

## 3. Routes and parameters

```javascript
app.get('/users/:id', (req) => ({ id: req.params.id }));
app.get('/search', (req) => ({ q: req.query.q ?? '' }));
```

```bash
curl http://localhost:3000/users/7          # {"id":"7"}
curl "http://localhost:3000/search?q=kidlat" # {"q":"kidlat"}
```

Parameters and query values are **strings**. The next step turns them into real
types. More in [Routing](guides/01-routing.md) and [Requests](guides/02-requests.md).

## 4. JSON in, validated

Give a route a JSON Schema and Kidlat checks the request before your handler runs.
Invalid requests get a `400` with the reason; your handler only sees good data.

```javascript
const users = new Map();
let nextId = 1;

app.post('/users', {
    schema: {
        body: {
            type: 'object',
            required: ['name', 'email'],
            properties: {
                name:  { type: 'string', minLength: 1, maxLength: 64 },
                email: { type: 'string', format: 'email' },
            },
            additionalProperties: false,
        },
    },
}, (req, res) => {
    const user = { id: nextId++, ...req.body };
    users.set(user.id, user);
    res.code(201);
    return user;
});
```

```bash
curl -X POST http://localhost:3000/users -H "content-type: application/json" \
     -d '{"name":"Ana","email":"ana@example.com"}'      # 201 {"id":1,...}
curl -X POST http://localhost:3000/users -H "content-type: application/json" \
     -d '{"name":""}'                                   # 400 with details
```

A `params` schema converts `:id` to a number for you. Replace the `/users/:id`
route from step 3 with:

```javascript
app.get('/users/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
}, (req) => users.get(req.params.id));
```

Response schemas make JSON output faster and act as an allow-list of fields —
see [Validation & serialization](guides/04-validation.md).

## 5. Errors

Throw anywhere; an error with a status becomes that response. Add `httpError` to
the import and make the route answer `404` for unknown users:

```javascript
import { Kidlat, httpError } from 'kidlat';

app.get('/users/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
}, (req) => {
    const user = users.get(req.params.id);
    if (!user) throw httpError(404, 'No such user');
    return user;
});
```

Errors without a status become a `500`. The message is not sent to the client, and
the error is logged, so crashes are never silent. See [Errors](guides/06-errors.md).

## 6. Add a WebSocket

WebSockets run on the same port as your HTTP routes:

```javascript
app.ws('/chat/:room', {
    open(ws) {
        ws.subscribe(ws.params.room);
    },
    message(ws, msg) {
        ws.publish(ws.params.room, msg);   // to everyone else in the room
    },
});
```

Try it from a browser console on the same origin, or from Node:

```javascript
const ws = new WebSocket('ws://localhost:3000/chat/lobby');
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () => ws.send('hi everyone');
```

Open two clients: what one sends, the other receives. Authentication, limits,
compression and pub/sub across several servers are in
[WebSockets](guides/09-websockets.md).

## 7. Before you go to production

Turn on structured logs, health checks, metrics and graceful shutdown:

```javascript
const app = new Kidlat({
    logger: { level: 'info' },               // JSON logs to stdout
    health: true,                            // /health and /ready
    metrics: true,                           // Prometheus /metrics
    trustProxy: true,                        // if a load balancer is in front
});

// ... routes ...

app.listen(3000);
app.enableGracefulShutdown();                // finish in-flight requests on SIGTERM
```

Then read [Running in production](guides/13-production.md) and the
[Runbook](RUNBOOK.md).

## Next steps

- [All guides](Guides.md) — every topic, one page each
- [Hooks & middleware](guides/05-hooks-and-middleware.md) — authentication, logging, shared logic
- [Plugins & scopes](guides/07-plugins-and-scopes.md) — organise a larger app
- [Testing your app](guides/15-testing.md)
- [Troubleshooting](guides/17-troubleshooting.md)
