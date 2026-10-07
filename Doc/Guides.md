# Kidlat Framework Guides

Welcome to the Kidlat documentation! Kidlat is designed to be as simple as Express but faster due to its native C++ and libuv core.

## Table of Contents
1. [Routing](#routing)
2. [JSON Parsing and Validation](#json-parsing-and-validation)
3. [Middleware](#middleware)
4. [Clustering](#clustering)

---

### Routing
Creating routes is straightforward. Kidlat supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`.

```javascript
import { Kidlat } from 'kidlat';
const app = new Kidlat();

app.get('/users', (req, res) => {
    res.json([{ id: 1, name: 'Alice' }]);
});

// Dynamic parameters
app.get('/users/:id', (req, res) => {
    res.json({ userId: req.params.id });
});

app.listen(3000);
```

---

### JSON Parsing and Validation
Instead of bulky body-parser middlewares, Kidlat natively reads JSON payloads. You can validate these payloads before your handler runs using JSON Schema.

```javascript
app.post('/login', {
    schema: {
        body: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
                email: { type: 'string' },
                password: { type: 'string', minLength: 6 }
            }
        }
    }
}, async (req, res) => {
    // The body is guaranteed to match the schema here
    const { email } = req.parsedBody;
    res.json({ success: true, email });
});
```

---

### Middleware
You can run global middleware on every request. This is useful for authentication, logging, or setting custom headers.

```javascript
app.use(async (req, res, next) => {
    console.log(`[${req.method}] ${req.url}`);
    
    // Attach custom data to the request
    req.user = "admin";
    
    // Call next() to continue to the route handler
    await next();
});
```

---

### Clustering
Node.js runs on a single thread. Kidlat provides a `cluster` helper that spawns a worker process for every CPU core on your machine, increasing your throughput.

```javascript
import { Kidlat, cluster } from 'kidlat';

cluster(() => {
    const app = new Kidlat();
    
    app.get('/', (req, res) => {
        res.send('Hello from a clustered worker!');
    });
    
    app.listen(3000);
});
```