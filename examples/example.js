import { Kidlat } from 'kidlat';

const app = new Kidlat({
    logger: true,
    bodyLimit: 1048576
});

// Basic GET route
app.get('/', (req, res) => {
    res.send('Hello from Kidlat!');
});

// JSON route
app.get('/api/info', (req, res) => {
    res.json({ framework: 'Kidlat', status: 'running' });
});

// POST route with body
app.post('/api/echo', async (req, res) => {
    try {
        const body = await req.json();
        res.json({ received: body });
    } catch (err) {
        res.json({ error: 'Invalid JSON' }, 400);
    }
});

// Start the server
app.listen(3000, (port) => {
    console.log(`Kidlat server is running on http://localhost:${port}`);
});
