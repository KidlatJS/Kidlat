# Security

Most protections are on by default. Here's what Kidlat does for you, and what you
should configure.

## Built in

- **Strict HTTP parsing** — requests with ambiguous framing (both
  `Content-Length` and `Transfer-Encoding`, duplicate `Content-Length`, unknown
  transfer codings, whitespace before a colon, line folding, bare LF, control
  characters) are rejected. This is what prevents **request smuggling** behind a
  proxy.
- **Size limits** — URL 8 KB (`414`), headers 64 KB / 200 fields (`431`),
  body `bodyLimit` (`413`).
- **Slow-client limits** — `headersTimeout` (30 s) and `requestTimeout` (120 s)
  count from a request's **first byte**, so a client trickling bytes can't hold a
  connection open (`408`).
- **Connection cap** — `maxConnections` (16384); extra connections get `503`.
- **Header injection** — CR/LF are stripped from response header values.
- **Prototype pollution** — JSON bodies with `__proto__` are rejected.
- **`X-Content-Type-Options: nosniff`** on every response.

## Security headers

```javascript
const app = new Kidlat({ securityHeaders: true });
```

| Option | Header | Default |
|---|---|---|
| `contentSecurityPolicy` | `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `strictTransportSecurity` | `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `frameOptions` | `X-Frame-Options` | `DENY` |
| `referrerPolicy` | `Referrer-Policy` | `no-referrer` |
| `crossOriginOpenerPolicy` | `Cross-Origin-Opener-Policy` | `same-origin` |
| `crossOriginResourcePolicy` | `Cross-Origin-Resource-Policy` | `same-origin` |
| `permittedCrossDomainPolicies` | `X-Permitted-Cross-Domain-Policies` | `none` |

The defaults suit a JSON API (OWASP REST Security Cheat Sheet). Pass an object
to change one (`{ frameOptions: 'SAMEORIGIN' }`), turn it off (`false`), or set
HSTS as `{ maxAge, includeSubDomains, preload }`. They join the default header
block built at startup, so they cost nothing per request; `defaultHeaders` and
`res.header()` still override them. Browsers ignore HSTS over plain HTTP, so it
is safe to send always. Serving HTML pages? Loosen `contentSecurityPolicy` for them.

## CORS

```javascript
const app = new Kidlat({
    cors: {
        origin: ['https://app.example.com', /\.example\.com$/],   // or '*', a string, a RegExp, or (origin, req) => boolean
        methods: 'GET,POST,PUT,DELETE',
        headers: 'Content-Type,Authorization',
        exposedHeaders: 'X-Request-Id',
        credentials: true,
        maxAge: 86400,
    },
});
```

With a list, RegExp or function, the request's `Origin` is reflected when allowed
(with `Vary: Origin`). `origin: '*'` together with `credentials: true` throws at
startup: it would let any website read responses for the signed-in user, so list
the allowed origins instead. `OPTIONS` requests are
answered `204` with the preflight headers.

## Rate limiting

```javascript
const app = new Kidlat({
    rateLimit: {
        max: 100,                                  // requests…
        window: 60_000,                            // …per minute
        keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
        allowList: ['10.0.0.5'],
        maxKeys: 100_000,                          // clients tracked at once (oldest dropped first)
        ipv6Subnet: 64,                            // IPv6 clients share a limit per /64 (128 = per address)
    },
});
```

Per route and per scope, on top of the app-wide limit:

```javascript
// logins: 5 failed attempts per 15 minutes; successful ones don't count
app.post('/login', { rateLimit: { max: 5, window: 15 * 60_000, skipSuccessfulRequests: true } }, login);

// after validation, so the key can use the body; several limiters on one route
app.post('/reset', {
    schema: { body: resetSchema },
    rateLimit: [
        { max: 3, window: 3_600_000, hook: 'preHandler', keyGenerator: (req) => req.body.email },
        { max: 10, window: 3_600_000 },                       // per IP
    ],
}, reset);

app.post('/webhook', { rateLimit: false }, hook);               // drops the inherited limits
await app.register(admin, { prefix: '/admin', rateLimit: { max: 30 } });   // one counter for the scope
```

Each route limiter has its own counter; a scope's limiter is shared by its
routes. `rateLimit: false` removes the limiters a route or scope inherited.

Over the limit: `429` with `Retry-After`; every response carries
`X-RateLimit-Limit/Remaining/Reset` (from the last limiter that ran). Counters are per process — with `cluster()`
or several instances, each counts separately. For a shared limit, rate-limit at
your load balancer or edge.

## Checklist for production

- Set `trustProxy` to match your proxies exactly: `true` for one, a hop count or their address ranges for more ([Requests](02-requests.md#behind-a-proxy)).
- Lower `bodyLimit` on routes that don't need big bodies — or raise it only where needed (route option `bodyLimit`).
- Turn on `securityHeaders`, and add a strict per-route `rateLimit` to logins and password resets.
- Use response schemas on anything that returns database rows, so internal fields can't leak.
- Never send `err.message` of 5xx errors to clients (the default handler doesn't).

---

← [Logging](10-logging.md) · [All guides](../Guides.md) · [HTTPS](12-https.md) →
