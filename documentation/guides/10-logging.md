# Logging

```javascript
const app = new Kidlat({ logger: true });                       // info level, stdout
const app = new Kidlat({ logger: { level: 'debug' } });
const app = new Kidlat({ logger: { level: 'info', stream: myWritable } });
const app = new Kidlat({ logger: myLogger });                   // any object with info()/child()…
```

Logs are **newline-delimited JSON**:

```json
{"level":30,"time":1760410000000,"pid":4242,"hostname":"web-1","reqId":"req-3f","msg":"incoming request","req":{"method":"GET","url":"/users/7","remoteAddress":"10.0.0.9"}}
```

Levels: `trace` 10, `debug` 20, `info` 30, `warn` 40, `error` 50, `fatal` 60, `silent`.

```javascript
app.get('/orders', (req) => {
    req.log.info({ count: 3 }, 'loaded orders');        // carries this request's reqId
    req.log.error(new Error('boom'));                    // errors are serialised with stack
});
```

- With logging on, every request logs `incoming request` and `request completed`
  (with `responseTime` in ms). Turn that off with `disableRequestLogging: true`.
- Logs are buffered and written asynchronously, and flushed on exit. If the
  destination can't keep up (a terminal, a slow pipe or log driver), at most
  4 MB of log text waits in memory; lines past that are dropped and a `warn`
  line reports how many once output catches up.
- Request logging costs CPU and memory on every request. Under heavy traffic,
  prefer `disableRequestLogging: true` and log only what you need, or keep
  `level: 'warn'` in production.
- Custom request ids: `new Kidlat({ genReqId: (req) => req.headers['x-request-id'] ?? crypto.randomUUID() })`.
- `import { Logger } from 'kidlat'` gives you the same logger for the rest of your app.

---

← [WebSockets](09-websockets.md) · [All guides](../Guides.md) · [Security](11-security.md) →
