# The request lifecycle: hooks & middleware

Every request goes through these stages, in order. Any stage can send a response,
which ends the request there.

```
onRequest hooks → route matching → preValidation hooks → schema validation
  → preHandler hooks → middleware (app.use) → handler
  → onSend hooks → response written → onResponse hooks
```

## Hooks

```javascript
app.addHook('onRequest', (req, res) => {
    if (!req.headers.authorization) res.code(401).send('Unauthorized');   // stops here
});

app.addHook('preHandler', async (req) => {
    req.user = await auth.verify(req.headers.authorization);
});

app.addHook('onSend', (req, res, payload) => {
    return payload;                         // return a new payload to replace it
});

app.addHook('onResponse', (req, res) => {
    metrics.observe(req.path, res.statusCode);   // after the response went out
});
```

Hooks can be **sync**, **async**, or **callback style** `(req, res, done) => done()`.
Synchronous hooks and handlers never allocate a promise, so they're the fastest.

Hooks can also be attached to a single route:

```javascript
app.get('/admin', { preHandler: requireAdmin }, handler);
```

## Middleware

```javascript
app.use(async (req, res, next) => {
    const started = Date.now();
    await next();                                          // run the rest of the chain
    req.log.info({ ms: Date.now() - started }, 'timed');   // runs after the handler
});

app.use((req, res, next) => {
    loadSession(req, (err) => next(err));                  // callback style works too
});
```

`next(err)` sends the error to the error handler.

> **Order matters.** A route captures the hooks and middleware registered
> **before** it. Register global hooks and `app.use()` first, routes after.

---

← [Validation & serialization](04-validation.md) · [All guides](../Guides.md) · [Errors](06-errors.md) →
