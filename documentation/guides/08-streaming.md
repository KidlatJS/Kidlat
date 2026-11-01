# Streaming & Server-Sent Events

`res.stream(source, status?, contentType?)` — or `res.send(source)` / returning it —
sends a **chunked** response from:

- a Node `Readable` (files, `stream.Readable.from(...)`, …)
- a web `ReadableStream`
- any **async iterable** (async generators)

```javascript
import fs from 'fs';

app.get('/download', (req, res) =>
    res.stream(fs.createReadStream('report.pdf'), 200, 'application/pdf'));
```

## Server-Sent Events

```javascript
app.get('/events', (req, res) => res.stream((async function* () {
    try {
        for (let i = 0; ; i++) {
            yield `data: ${JSON.stringify({ tick: i })}\n\n`;
            await new Promise((r) => setTimeout(r, 1000));
        }
    } finally {
        console.log('client went away');      // runs when the client disconnects
    }
})(), 200, 'text/event-stream'));
```

- **Backpressure:** if the client reads slowly, the source is paused instead of
  buffering in memory.
- **Disconnects:** when the client leaves, the source is stopped (the generator's
  `finally` runs; Node streams are destroyed) straight away.
- **Errors:** if the source fails halfway, the connection is aborted, so the
  client can't mistake a truncated body for a complete one.
- **Timeouts:** a stream that keeps writing is never cut off by `requestTimeout`.
  Send something (even a `: ping\n\n` comment) at least every couple of minutes.

---

← [Plugins & scopes](07-plugins-and-scopes.md) · [All guides](../Guides.md) · [WebSockets](09-websockets.md) →
