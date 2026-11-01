# WebSockets

`app.ws(path, options)` adds a WebSocket route on the same port as your HTTP
routes, over plain HTTP or Kidlat's own HTTPS. The protocol runs in C++:
framing, UTF-8 checks, ping/pong, the close handshake, limits, backpressure and
pub/sub. Your handlers only see whole messages.

```javascript
app.ws('/chat/:room', {
    // runs after the onRequest / preValidation / preHandler hooks and rate limits
    upgrade(req, res) {
        if (!req.user) return res.code(401).send('Unauthorized');   // refuse
        return { user: req.user };                                   // → ws.data
    },
    open(ws) {
        ws.subscribe(ws.params.room);
    },
    message(ws, msg, isBinary) {       // text → string, binary → Buffer
        ws.publish(ws.params.room, msg, isBinary);
    },
    close(ws, code, reason) {},
});
```

- `upgrade(req, res)` is optional. It can be `async` (look up a session, check a
  token). Whatever it returns becomes `ws.data`. If it sends a response or throws,
  the upgrade is refused with that response (errors go through
  `setErrorHandler`) and the connection closes.
- `message` gets its own copy of each message, so you can keep it.
- Handlers aren't awaited: messages arrive in order, and an `async` handler
  doesn't hold up the next one. If you need one-at-a-time processing, queue the
  messages yourself.
- An error thrown in `open`, `message` or `drain` (or a rejected promise) is
  logged and the socket is closed with `1011`. The process keeps running.
- A path can have both `app.get()` and `app.ws()`: upgrade requests go to the
  WebSocket route, everything else to the GET route. A plain GET to a path that
  only has a WebSocket route gets `426 Upgrade Required`.
- `app.ws()` works inside `register()` scopes: prefixes, hooks and scope rate
  limits apply to the upgrade request.

## The socket

| Member | |
|---|---|
| `send(data, isBinary?)` | `1` sent, `0` buffered (the client is behind; `drain` fires when it catches up), `-1` refused (closed, or over the backpressure limit). `data`: string, Buffer, TypedArray, DataView or ArrayBuffer. `isBinary` defaults to `typeof data !== 'string'` |
| `bufferedAmount` | bytes the client hasn't taken yet |
| `subscribe(topic)` / `unsubscribe(topic)` / `isSubscribed(topic)` / `topics` | topic membership |
| `publish(topic, data, isBinary?)` | to every subscriber except this socket; returns how many were reached |
| `close(code = 1000, reason = '')` | close handshake. Codes 1000–1003, 1007–1014, 3000–4999; reason up to 123 bytes |
| `terminate()` | drop the connection now (`close` reports `1006`) |
| `data`, `params`, `query`, `ip`, `protocol`, `isOpen` | treat as read-only |

After a socket closes, `send` and `publish` return `-1` and the other methods do
nothing, so a handler that finishes late doesn't need to check `isOpen` first.

## Options

| Option | Default | |
|---|---|---|
| `maxPayload` | 64 KiB | largest message (fragments added up); bigger closes with `1009` |
| `maxBackpressure` | 1 MiB | once this many bytes are waiting for a client, further sends hit the limit. A single message larger than this still goes out to a client that is keeping up |
| `onBackpressureLimit` | `'close'` | `'close'`: close the socket with `1008`. `'drop'`: refuse that message (`send` returns `-1`) and keep the socket |
| `idleTimeout` | 120 (s) | a ping goes out halfway; a client that sends nothing by the deadline is dropped. `0` turns it off |
| `origins` | same origin | when a browser sends `Origin`, it must match the request's own scheme, host and port (behind a trusted proxy, `X-Forwarded-Host`/`-Proto`). An array is an allow-list (`['https://app.example.com']`); `'*'` turns the check off. Clients that send no `Origin` (non-browsers) are allowed |
| `protocols` | none | supported subprotocols; the first one the client offers that's on the list is chosen (`ws.protocol`) |
| `compression` | `false` | `true` negotiates permessage-deflate, without context takeover (no compression state kept between messages). Decompressed size counts against `maxPayload` |
| `messageRate` | off | `{ max, windowMs }` per socket; over it closes with `1008` |
| `maxTopicsPerSocket` | 1024 | `subscribe` throws `RangeError` past it. Topics are strings of up to 256 bytes |

Also accepted: `rateLimit`, `onRequest`, `preValidation`, `preHandler`,
`onResponse`, `config` and `schema` (for `querystring`, `params`, `headers`), the
same as on HTTP routes. Unknown or invalid options throw when the route is added.

Always enforced, whatever the options: client frames must be masked, reserved
bits and opcodes must be valid (`1002`), text and close reasons must be valid
UTF-8 (`1007`), control frames are at most 125 bytes and never fragmented, and a
client may send at most 100 pings a second (`1008`).

## Pub/sub and more than one process

`publish` builds the frame once and copies it to each subscriber in C++, and
output to each socket is written once per event-loop turn, however many
messages it got.

- `app.publish(topic, data, isBinary?)` sends to every subscriber.
- `ws.publish(...)` does the same but skips the sender.
- Both return the number of sockets reached.

Topics are per process (and per worker thread). To reach subscribers in other
`cluster()` workers or on other machines, forward publishes through a broker:

```javascript
import { createClient } from 'redis';
const pub = createClient(); const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);

app.ws.onPublish((topic, data) => pub.publish(`ws:${topic}`, data));    // local → broker
await sub.pSubscribe('ws:*', (data, channel) => {
    app.publishLocal(channel.slice(3), data);                           // broker → local
});
```

`onPublish` runs after every `app.publish` and `ws.publish`. `publishLocal`
doesn't trigger it, so messages can't loop. If `onPublish` throws, the error is
logged and local delivery still happens. Each instance also receives its own
messages back from the broker, so either skip your own (tag messages with an
instance id) or call `publishLocal` only for messages from other instances.

## Backpressure

```javascript
message(ws, msg) {
    if (ws.send(bigReply) === 0) ws.data.paused = true;   // stop producing for this client
},
drain(ws) {
    ws.data.paused = false;                                // it caught up
},
```

A client that stops reading can't make the server buffer without limit. Once
`maxBackpressure` bytes are waiting, it is closed (or its messages dropped,
with `onBackpressureLimit: 'drop'`).

## Shutting down

`app.close()` and graceful shutdown send `1001` (going away) to every socket,
then wait for the clients' replies. A client that doesn't reply is
disconnected after 5 seconds.

## Behind a proxy

nginx needs the upgrade headers passed through, and a read timeout longer than
`idleTimeout`:

```nginx
location /ws/ {
    proxy_pass http://kidlat;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

## Metrics

With `metrics: true`, `/metrics` adds `kidlat_ws_sockets`,
`kidlat_ws_messages_total{direction}`, `kidlat_ws_bytes_total{direction}`,
`kidlat_ws_closes_total{code}` and `kidlat_ws_backpressure_total{action}`. The
upgrade request is logged like any request, with status `101`.

---

← [Streaming & Server-Sent Events](08-streaming.md) · [All guides](../Guides.md) · [Logging](10-logging.md) →
