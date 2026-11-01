# Responses

## Sending

```javascript
res.send('text');                // text/plain; charset=utf-8
res.send(Buffer.from([1, 2]));   // application/octet-stream
res.send({ ok: true });          // JSON
res.send(readableStream);        // chunked (see the Streaming guide)
res.send();                      // empty body

res.json({ ok: true });          // JSON, through the response schema if there is one
res.code(201).json(created);     // status() is an alias of code()
res.json(created, 201);          // same — but an explicit status()/code() call wins
res.redirect('/login');          // 302; res.redirect('/new', 301) or res.redirect(301, '/new')
```

Or just **return** a value from the handler — strings, objects, Buffers and
streams are sent the same way:

```javascript
app.get('/user/:id', async (req) => {
    const user = await db.users.find(req.params.id);
    return user;                          // sent as JSON
});
```

A handler that neither sends nor returns anything leaves the request hanging until
a timeout — make sure every path responds.

## Headers

```javascript
res.header('Cache-Control', 'no-store');
res.header('Set-Cookie', ['a=1; HttpOnly', 'b=2; Secure']);   // arrays → one header line each
res.headers({ 'X-One': '1', 'X-Two': '2' });
res.type('text/html; charset=utf-8');
res.getHeader('cache-control');  res.hasHeader('x-one');  res.removeHeader('x-one');
```

- Header values containing CR/LF have them stripped (no header injection).
- `Content-Length`, `Transfer-Encoding` and `Connection` are always computed by
  Kidlat. Setting `Connection: close` closes the connection after the response.
- Every response gets `Date`, `Connection` and `X-Content-Type-Options: nosniff`.
  Change the defaults with `new Kidlat({ defaultHeaders: { … } })` (or `null`).

## Automatic behaviour

- `HEAD` requests get the headers (including the correct `Content-Length`) without a body.
- `204`, `304` and `1xx` responses never have a body or `Content-Length`.
- `res.sent` tells you whether a response has gone out; sending twice is ignored.

---

← [Requests](02-requests.md) · [All guides](../Guides.md) · [Validation & serialization](04-validation.md) →
