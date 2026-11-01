# Testing your app

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

← [Scaling: clustering & worker threads](14-scaling.md) · [All guides](../Guides.md) · [What Kidlat doesn't do (and what to use instead)](16-limitations.md) →
