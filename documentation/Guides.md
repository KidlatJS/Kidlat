# Kidlat Guides

A practical guide to building with Kidlat 2.x — from a first route to running it in
production. Each guide stands on its own; pick a topic and jump in.

Kidlat is a web framework for Node.js whose network layer — sockets, TLS, HTTP
parsing — is native C++, with routing, validation, serialization and logging built
in. It has **no runtime dependencies**.

**New to Kidlat?** Start with [Getting started](GETTING_STARTED.md): install, a
first server, validation, errors and a WebSocket in about ten minutes.

## Building an app

1. [Routing](guides/01-routing.md) — paths, parameters, wildcards, which route wins
2. [Requests](guides/02-requests.md) — query strings, headers, bodies, forms, uploads, cookies, proxies
3. [Responses](guides/03-responses.md) — sending data, headers, status codes
4. [Validation & serialization](guides/04-validation.md) — JSON Schema in and out
5. [The request lifecycle: hooks & middleware](guides/05-hooks-and-middleware.md)
6. [Errors](guides/06-errors.md) — `httpError` and custom error handlers
7. [Plugins & scopes](guides/07-plugins-and-scopes.md) — `register()`, prefixes, decorators
8. [Streaming & Server-Sent Events](guides/08-streaming.md)
9. [WebSockets](guides/09-websockets.md) — sockets, pub/sub, backpressure, proxies

## Running it

10. [Logging](guides/10-logging.md)
11. [Security](guides/11-security.md) — headers, CORS, rate limiting, a production checklist
12. [HTTPS](guides/12-https.md)
13. [Running in production](guides/13-production.md) — health checks, metrics, graceful shutdown, Docker
14. [Scaling: clustering & worker threads](guides/14-scaling.md)
15. [Testing your app](guides/15-testing.md)

## Reference

16. [What Kidlat doesn't do (and what to use instead)](guides/16-limitations.md)
17. [Troubleshooting](guides/17-troubleshooting.md)

Operating a Kidlat service — load balancers, alerts, rollbacks, diagnostics — is
covered in the [Runbook](RUNBOOK.md).
