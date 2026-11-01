# Routing

```javascript
app.get('/users', listUsers);
app.post('/users', createUser);
app.put('/users/:id', replaceUser);
app.patch('/users/:id', updateUser);
app.delete('/users/:id', deleteUser);
app.head('/users', headUsers);             // rarely needed: HEAD falls back to GET
app.options('/users', optionsUsers);
app.all('/ping', ping);                    // every method above
app.route({ method: ['GET', 'POST'], url: '/multi', handler });
```

Every method also accepts an options object (for schemas, route-level hooks or
`config`) before the handler, or with the handler inside it:

```javascript
app.post('/users', { schema: { body: userSchema } }, createUser);
app.post('/users', { schema: { body: userSchema }, handler: createUser });
```

## Parameters and wildcards

```javascript
app.get('/users/:id', (req) => req.params.id);              // '/users/42' → '42'
app.get('/users/:id/posts/:post', (req) => req.params);     // { id, post }
app.get('/files/:id(^\\d+$)', byNumber);                    // only digits
app.get('/files/:name', byName);                            // everything else
app.get('/assets/*', (req) => req.params['*']);             // '/assets/css/a.css' → 'css/a.css'
```

- Parameters match **one path segment**. Values are percent-decoded
  (`/users/a%20b` → `'a b'`); a malformed escape gets `400`.
- Parameters are **strings**. Use a `params` schema to get numbers (see [Validation & serialization](04-validation.md)).
- The wildcard must be the last segment.

## Which route wins

At every segment: a **static** segment beats a **parameter**, which beats a
**wildcard**. Constrained parameters (`:id(…)`) are tried before plain ones.
Kidlat backtracks, so `/users/new/edit` and `/users/:id/profile` both work.

```javascript
app.get('/users/me', me);          // GET /users/me      → me
app.get('/users/:id', byId);       // GET /users/42      → byId
```

## Trailing slashes

By default `/about` and `/about/` are different routes. To treat them the same:

```javascript
const app = new Kidlat({ ignoreTrailingSlash: true });
```

## Not found

Unmatched requests get `404 Not Found` (and `405 Method Not Allowed` for methods
Kidlat doesn't know). To customise:

```javascript
app.setNotFoundHandler((req, res) => res.code(404).json({ error: `No route for ${req.method} ${req.path}` }));
```

---

← [Getting started](../GETTING_STARTED.md) · [All guides](../Guides.md) · [Requests](02-requests.md) →
