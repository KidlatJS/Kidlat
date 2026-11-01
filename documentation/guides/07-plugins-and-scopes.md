# Plugins & scopes

`register()` creates a **scope**: routes, hooks, middleware and error handlers
added inside it stay inside it.

```javascript
await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);
    admin.setErrorHandler((err, req, res) => res.code(403).json({ error: err.message }));
    admin.get('/stats', getStats);                  // → GET /admin/stats
}, { prefix: '/admin' });

app.get('/public', publicPage);                     // not affected by requireAdmin
```

A scope inherits everything registered on its parent before it. Plugins can live
in their own files (`export default async function (app, opts) { … }`) — pass the
module or its default export to `register()`.

## Decorators

```javascript
app.decorate('db', db);                             // app.db
app.decorateRequest('user', null);                  // req.user (default value)
app.decorateResponse('ok', function (data) { return this.json({ ok: true, data }); });
```

`decorate` throws if the name already exists, so plugins can't silently overwrite
each other.

---

← [Errors](06-errors.md) · [All guides](../Guides.md) · [Streaming & Server-Sent Events](08-streaming.md) →
