# Requests

Most request fields are parsed **only when you first read them**, so you don't pay
for what you don't use.

| Property | |
|---|---|
| `req.method`, `req.url`, `req.path` | `url` includes the query string, `path` doesn't |
| `req.params` | route parameters |
| `req.query` | parsed query string |
| `req.headers` | lower-cased names; `req.header('X-Api-Key')` for a single header |
| `req.ip`, `req.ips` | client address (see `trustProxy` below) |
| `req.protocol`, `req.hostname` | `'http'`/`'https'`, host without port |
| `req.httpVersion` | `'1.1'` or `'1.0'` |
| `req.id` | request id (`req-1`, `req-2`, … or your `genReqId`) |
| `req.log` | logger bound to this request's id |
| `req.parsedBody` / `req.body` | the body after JSON parsing / schema validation |
| `req.aborted` | `true` if the client disconnected mid-request |
| `req.fingerprint` | SHA-256 of IP + User-Agent + Accept-Language |

## Query strings

```
/search?q=hello+world&tag=a&tag=b&flag
```

```javascript
req.query  // { q: 'hello world', tag: ['a', 'b'], flag: '' }
```

`+` decodes to a space, repeated keys become arrays, values are always strings
(or arrays of strings) — use a `querystring` schema for numbers and booleans.

## Headers

Repeated headers are joined with `, ` (`Cookie` with `; `), except headers that
may only appear once (`Host`, `Content-Type`, `Authorization`, …) where the first
value wins.

## Bodies

```javascript
app.post('/echo', async (req, res) => {
    const data = await req.json();     // parsed JSON (an empty body gives {})
    // or: await req.text()  — UTF-8 string
    // or: await req.buffer() — raw Buffer
    res.json(data);
});
```

- Bodies larger than **`bodyLimit`** (default 1 MB) are answered with
  `413 Payload Too Large` — immediately if `Content-Length` says so, otherwise as
  soon as the limit is crossed. Raise or lower it for one route with the
  `bodyLimit` route option: `app.post('/upload', { bodyLimit: 10 * 1024 * 1024 }, …)`.
- Invalid JSON rejects with an error whose `statusCode` is `400`; if you don't
  catch it, the client gets `400 Invalid JSON`.
- JSON containing `__proto__` (or `constructor.prototype`) is rejected with `400`,
  to protect against prototype pollution.
- Chunked uploads and `Expect: 100-continue` work transparently.

## Forms & file uploads

```javascript
app.post('/profile', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const { fields, files } = await req.formData({
        maxFiles: 1,
        maxFileSize: 2 * 1024 * 1024,
        allowedTypes: ['image/png', 'image/jpeg'],
    });
    // fields: { name: 'Ana', tags: ['a', 'b'] } — repeated names become arrays
    // files:  [{ fieldName: 'photo', filename: 'me.jpg', contentType: 'image/jpeg', size: 48213, data: <Buffer> }]
});
```

- Reads `multipart/form-data` and `application/x-www-form-urlencoded`; any other
  `Content-Type` rejects with `415`, a malformed body with `400`.
- Limits (defaults): `maxFields` (100), `maxFieldSize` (100 KB per field),
  `maxFiles` (10), `maxFileSize` (no cap of its own) — past one, `413`.
  `allowedTypes` turns other file types away with `415`.
- The body is buffered first, so the route's **`bodyLimit` caps the whole
  upload** — raise it on upload routes only. `data` is a view into that buffer,
  not a copy.
- `filename` has its directory part removed (`../../x.png` → `x.png`), but it is
  still client input: generate your own name before writing to disk. The same
  goes for `contentType` — the client chose it; check the file's first bytes if
  the type matters.
- JSON Schema `body` validation is for JSON bodies; validate form fields after
  `formData()`.

## Cookies

```javascript
const app = new Kidlat({ cookies: { secret: process.env.COOKIE_SECRET } });   // only needed for signed cookies

app.get('/', (req, res) => {
    req.cookies.theme;                                // reading needs no setup
    res.cookie('theme', 'dark', { maxAge: 30 * 86400 });
    res.cookie('session', id, { signed: true, sameSite: 'strict' });
    res.clearCookie('old', { path: '/legacy' });      // same path/domain it was set with
    return req.signedCookies.session;                 // undefined if missing or tampered with
});
```

- Defaults: `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came
  over HTTPS (directly or via a trusted proxy's `X-Forwarded-Proto`).
- **`maxAge` is in seconds**, as in the cookie spec (Express uses milliseconds).
  Other options: `expires` (a `Date`), `domain`, `path`, `secure`, `httpOnly`,
  `sameSite` (`'strict'`, `'lax'`, `'none'` or `false`), `partitioned`.
- Mistakes throw instead of producing a cookie the browser would drop or
  mis-scope: an invalid name, `;` or control characters in `path`/`domain`,
  `sameSite: 'none'` without `secure`, and `__Secure-` / `__Host-` names without
  the attributes those prefixes require. Values are percent-encoded.
- Signed cookies carry an HMAC-SHA256 of their name and value. The secret must
  be 32+ characters; pass an array to rotate keys (the first signs, all verify).
  Signing proves the value came from you — it doesn't hide it. `signedCookies`
  is verified on every access, so read it once per request.

## Behind a proxy

When Kidlat runs behind a load balancer or reverse proxy, the socket address is
the proxy's. `trustProxy` says which proxies to believe about `X-Forwarded-*`:

```javascript
new Kidlat({ trustProxy: true });                        // one proxy in front (the socket peer)
new Kidlat({ trustProxy: 2 });                           // two, e.g. CDN → load balancer → Kidlat
new Kidlat({ trustProxy: ['loopback', '10.0.0.0/8'] });  // proxies by address or CIDR range
new Kidlat({ trustProxy: (addr, hop) => hop === 0 });    // your own test (hop 0 = socket peer)

req.ip        // the client: the first X-Forwarded-For hop that isn't a trusted proxy
req.ips       // client, then each trusted proxy, ending with the socket peer
req.protocol  // X-Forwarded-Proto ('http' or 'https') from the nearest proxy
req.hostname  // X-Forwarded-Host from the nearest proxy, if it's a valid host
```

Proxies **append** to `X-Forwarded-For`, so its leftmost entries are whatever the
client sent. Kidlat walks the list from the right and stops at the first address
your `trustProxy` doesn't cover — trust exactly the proxies you run, no more.
`X-Forwarded-Proto` and `-Host` are only read when the socket peer is trusted, and
a `Host` / `X-Forwarded-Host` that isn't a well-formed `host[:port]` is ignored
(`req.hostname` is then `''`).

---

← [Routing](01-routing.md) · [All guides](../Guides.md) · [Responses](03-responses.md) →
