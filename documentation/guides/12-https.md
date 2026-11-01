# HTTPS

```javascript
import fs from 'fs';

const app = new Kidlat({
    https: {
        cert: fs.readFileSync('/etc/ssl/fullchain.pem'),   // leaf certificate + intermediates
        key: fs.readFileSync('/etc/ssl/privkey.pem'),      // unencrypted PEM key
    },
});
app.listen(443);
```

- Use the **full chain** file (e.g. `fullchain.pem` from Let's Encrypt), not just
  the leaf certificate — clients need the intermediates.
- **TLS 1.2 and 1.3** only. TLS 1.2 is limited to forward-secret, authenticated
  cipher suites (ECDHE with AES-GCM or ChaCha20); client-initiated renegotiation is
  refused. Every current browser and HTTP client connects; very old ones (IE on
  Windows 7, Java 7) don't.
- A wrong key or an unreadable certificate makes `listen()` throw with a clear
  message, instead of failing on the first connection.
- With `cluster()`, workers share a session-ticket key automatically so TLS
  sessions resume on any worker. Running several machines? Set the same
  `KIDLAT_TLS_TICKET_KEY` (96 hex characters) on each.

Often simpler: terminate TLS at your load balancer or reverse proxy and run Kidlat
on plain HTTP behind it (with `trustProxy: true`).

---

← [Security](11-security.md) · [All guides](../Guides.md) · [Running in production](13-production.md) →
