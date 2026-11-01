# What Kidlat doesn't do (and what to use instead)

Kidlat keeps its core small. For these, add a library or a few lines of code:

| Need | Approach |
|---|---|
| **Uploads larger than memory** | `req.formData()` buffers the body; for multi-gigabyte files, upload straight to object storage with a pre-signed URL |
| **Static files** | serve them from a CDN or your reverse proxy; for a few files, `res.stream(fs.createReadStream(file), 200, type)` — validate the path so `..` can't escape your folder |
| **Compression** | let your reverse proxy / CDN compress responses |
| **HTTP/2, HTTP/3** | terminate them at your load balancer or proxy; Kidlat speaks HTTP/1.1 to it |
| **Templates / views** | render to a string with any template engine, then `res.type('text/html').send(html)` |

---

← [Testing your app](15-testing.md) · [All guides](../Guides.md) · [Troubleshooting](17-troubleshooting.md) →
