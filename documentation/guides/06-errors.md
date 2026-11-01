# Errors

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

← [The request lifecycle: hooks & middleware](05-hooks-and-middleware.md) · [All guides](../Guides.md) · [Plugins & scopes](07-plugins-and-scopes.md) →
