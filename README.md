# Kidlat

**Kidlat** is a fast, natively-compiled web framework for Node.js.

Kidlat bypasses the standard Node.js `http` module. It handles TCP sockets, TLS termination, and HTTP parsing directly in C++ using `libuv` and `N-API`. This design gives it high throughput and low latency.

## Features

- **Fast:** Written in C++ to reduce overhead.
- **Cross-Platform:** Works on Windows, macOS, and Linux without requiring a C++ compiler to install.
- **Secure:** Protects against Slowloris, request smuggling, and buffer overflows. 
- **Native HTTPS:** Handles SSL directly in C++.
- **Router:** Uses `find-my-way` for fast routing.
- **JSON Schema:** Validates requests using `ajv` before they reach your handler.
- **Lightweight:** Request and Response objects have minimal overhead.
- **Rate Limiting & CORS:** Built into the framework without extra packages.
- **Clustering:** Includes a helper to scale across multiple CPU cores.

## Installation

```bash
npm install kidlat
```

## Quick Start

```javascript
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: true,
    bodyLimit: 1048576,
    trustProxy: false
});

app.get('/', (req, res) => {
    res.send('Hello from Kidlat!');
});

app.get('/api/info', (req, res) => {
    res.json({ framework: 'Kidlat', status: 'running' });
});

app.post('/api/echo', async (req, res) => {
    try {
        const body = await req.json();
        res.json({ success: true, received: body });
    } catch (err) {
        res.json({ error: 'Invalid JSON' }, 400);
    }
});

app.listen(3000, (port) => {
    console.log(`Server running on http://localhost:${port}`);
});
```

## Advanced Usage

### Rate Limiting & CORS
You can protect your API directly through the config.

```javascript
const app = new Kidlat({
    cors: {
        origin: 'https://example.com',
        methods: 'GET,POST',
        credentials: true
    },
    rateLimit: {
        max: 100,
        window: 60000
    }
});
```

### JSON Schema Validation
Kidlat can validate request bodies using `ajv`. If the payload is invalid, it returns a `400 Bad Request`.

```javascript
app.post('/api/users', {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'age'],
            properties: {
                username: { type: 'string', minLength: 3 },
                age: { type: 'number', minimum: 18 }
            }
        }
    }
}, (req, res) => {
    const { username } = req.parsedBody;
    res.json({ message: `Welcome ${username}!` });
});
```

### Clustering
Run Kidlat on multiple CPU cores using the `cluster` helper:

```javascript
import { Kidlat, cluster } from 'kidlat';

cluster(() => {
    const app = new Kidlat();
    
    app.get('/', (req, res) => res.send('Worker is ready.'));
    
    app.listen(3000);
});
```

### Native HTTPS (TLS)
Pass your SSL certificates to the framework to handle HTTPS in C++.

```javascript
import fs from 'fs';
import { Kidlat } from 'kidlat';

const app = new Kidlat({
    https: {
        cert: fs.readFileSync('./cert.pem'),
        key: fs.readFileSync('./key.pem')
    }
});

app.get('/', (req, res) => res.send('Secure connection.'));
app.listen(443);
```

## How it works
Most Node.js frameworks run on top of the built-in `http` module. Kidlat replaces this network layer by connecting directly to `libuv` through a native C++ addon. This reduces memory usage and improves speed by minimizing the data passed between C++ and JavaScript.

## License
MIT