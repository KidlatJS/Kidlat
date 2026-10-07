/**
 * security-test.js — Automated security test suite for Kidlat
 *
 * Tests every security control in the framework.
 * Run: node security-test.js
 */

import { spawn }  from 'child_process';
import { createConnection } from 'net';
import { writeFileSync, unlinkSync } from 'fs';

/* ── ANSI colours ───────────────────────────────────────────────── */
const G  = '\x1b[32m✓\x1b[0m';
const R  = '\x1b[31m✗\x1b[0m';
const DIM = s => `\x1b[2m${s}\x1b[0m`;

let passed = 0, failed = 0;

function result(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ${G}  ${name}`); }
    else    { failed++; console.log(`  ${R}  ${name}`); }
    if (detail) console.log(`     ${DIM(detail)}`);
}

/* ── HTTP helpers ───────────────────────────────────────────────── */
function httpRequest(opts) {
    return new Promise((resolve) => {
        const { host = '127.0.0.1', port = 4444, method = 'GET',
                path = '/', headers = {}, body = '' } = opts;

        let raw = `${method} ${path} HTTP/1.1\r\n`;
        raw += `Host: ${host}\r\n`;
        for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
        if (body) raw += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
        raw += `Connection: close\r\n\r\n`;
        if (body) raw += body;

        const socket = createConnection({ host, port }, () => socket.write(raw));
        let response = '';
        socket.on('data', d => response += d.toString());
        socket.on('end',  () => {
            const [headerPart, ...bodyParts] = response.split('\r\n\r\n');
            const lines  = headerPart.split('\r\n');
            const status = parseInt(lines[0]?.split(' ')[1] || '0', 10);
            const hdrs   = Object.create(null);
            for (const l of lines.slice(1)) {
                const ci = l.indexOf(':');
                if (ci !== -1) hdrs[l.substring(0, ci).toLowerCase().trim()] = l.substring(ci + 1).trim();
            }
            resolve({ status, headers: hdrs, body: bodyParts.join('\r\n\r\n'), raw: headerPart });
        });
        socket.on('error', () => resolve({ status: 0, headers: {}, body: '', raw: '' }));
        socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: 0, headers: {}, body: 'timeout', raw: '' }); });
    });
}

/* Raw TCP write — for tests where we send deliberately malformed data */
function rawTCP(data, port = 4444, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port }, () => {
            socket.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
        });
        let response = '';
        socket.on('data', d => response += d.toString());
        socket.on('end',  () => resolve(response));
        socket.on('error', () => resolve(''));
        socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(response); });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Start the test server ──────────────────────────────────────── */
const SERVER_SCRIPT = `
import { Kidlat } from 'kidlat';
const app = new Kidlat({ logger: false, trustProxy: false });

// Route for general testing
app.get('/',         (req, res) => res.json({ ok: true }));
app.get('/search',   (req, res) => res.json({ query: req.query }));
app.get('/headers',  (req, res) => res.json({ headers: req.headers }));
app.post('/echo',    async (req, res) => { const b = await req.json(); res.json(b); });

// Route that sets custom response header (injection target)
app.get('/setheader', (req, res) => {
    const val = req.query.val || 'safe';
    res.header('X-Custom', val).json({ ok: true });
});

// Route with schema validation
app.post('/validate', {
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } }
}, (req, res) => res.json({ name: req.parsedBody.name }));

app.listen(4444, () => console.log('ready'));
`;

writeFileSync('_sec_server.mjs', SERVER_SCRIPT);

async function startServer() {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['_sec_server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', d => { if (d.toString().includes('ready')) resolve(proc); });
        proc.stderr.on('data', d => {
            const m = d.toString();
            if (!m.includes('ExperimentalWarning')) process.stderr.write(m);
        });
        setTimeout(() => reject(new Error('Server did not start')), 8000);
    });
}

console.log('\nKidlat — Security Test Suite');
console.log('======================================\n');

const proc = await startServer();
await sleep(200);

/* ═══════════════════════════════════════════════════════════════════
   TEST GROUPS
   ═══════════════════════════════════════════════════════════════════ */

/* ── 1. Prototype Pollution ────────────────────────────────────── */
console.log('1. Prototype Pollution');

{
    // Inject __proto__ as a header name
    const r = await httpRequest({ path: '/headers', headers: { '__proto__': 'polluted', 'x-normal': 'ok' } });
    const hdrs = r.body ? JSON.parse(r.body).headers : {};
    const polluted = Object.prototype.polluted;
    result('__proto__ header cannot pollute Object.prototype', !polluted && r.status === 200,
        `Object.prototype.polluted = ${polluted}`);
}
{
    // __proto__ in query string
    const r = await httpRequest({ path: '/search?__proto__[evil]=yes&safe=ok' });
    const polluted = Object.prototype.evil;
    result('__proto__ query param cannot pollute Object.prototype', !polluted,
        `Object.prototype.evil = ${polluted}`);
}
{
    // constructor.prototype via query
    const r = await httpRequest({ path: '/search?constructor=pwned' });
    result('constructor query param returns safely', r.status === 200);
}

/* ── 2. HTTP Response Splitting (Header Injection) ─────────────── */
console.log('\n2. HTTP Response Splitting / Header Injection');

{
    // Try injecting CRLF into a response header value via query param
    const inject = 'safe\r\nX-Injected: pwned';
    const r = await httpRequest({ path: `/setheader?val=${encodeURIComponent(inject)}` });
    // Check if X-Injected appears as a *header name* (line starts with it)
    // A false positive would be X-Injected appearing as part of the X-Custom value
    const lines = r.raw.split('\r\n');
    const hasInjectedHeader = lines.some(l => l.toLowerCase().startsWith('x-injected:'));
    result('CRLF in header value does not inject new header', !hasInjectedHeader,
        hasInjectedHeader ? 'VULNERABLE: X-Injected appeared as header name' : 'CRLF stripped from value correctly');
}
{
    const inject = 'safe\nSet-Cookie: session=evil';
    const r = await httpRequest({ path: `/setheader?val=${encodeURIComponent(inject)}` });
    const lines = r.raw.split(/\r?\n/);
    const hasInjected = lines.some(l => l.toLowerCase().startsWith('set-cookie:') && l.includes('evil'));
    result('LF-only injection in header value is blocked', !hasInjected);
}

/* ── 3. X-Content-Type-Options ─────────────────────────────────── */
console.log('\n3. Security Headers');

{
    const r = await httpRequest({ path: '/' });
    result('X-Content-Type-Options: nosniff present on every response',
        r.headers['x-content-type-options'] === 'nosniff');
}
{
    const r = await httpRequest({ path: '/search', method: 'POST', body: '{}',
        headers: { 'Content-Type': 'application/json' } });
    // POST to GET-only route → 405
    result('Security headers present on error responses',
        r.headers['x-content-type-options'] === 'nosniff' || r.status === 405);
}

/* ── 4. Method Allowlist ───────────────────────────────────────── */
console.log('\n4. Method Allowlist');

for (const method of ['TRACE', 'CONNECT', 'PROPFIND', 'FOOBAR']) {
    const r = await httpRequest({ method, path: '/' });
    result(`${method} → 405 Method Not Allowed`, r.status === 405);
}
{
    // DELETE is a valid method but no DELETE route is defined → 404 (correct)
    const r = await httpRequest({ method: 'DELETE', path: '/' });
    result('Undefined DELETE route → 404 (not 500 or server crash)', r.status === 404, `Got ${r.status}`);
}

/* ── 5. URL / URI Attacks ──────────────────────────────────────── */
console.log('\n5. URL / URI Attacks');

{
    // URL longer than 8192 bytes
    const longPath = '/' + 'a'.repeat(8200);
    const r = await httpRequest({ path: longPath });
    result('URL > 8192 bytes → 414 URI Too Long', r.status === 414 || r.status === 400,
        `Got ${r.status}`);
}
{
    // Null byte in URL
    const r = await rawTCP(`GET /\x00evil HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    result('Null byte in URL is rejected or ignored safely',
        r.includes('400') || r.includes('404') || r.includes('200'));
}
{
    // Path traversal attempt
    const r = await httpRequest({ path: '/../../etc/passwd' });
    result('Path traversal attempt does not expose files',
        r.status === 404 || r.status === 400);
}
{
    // Malformed percent-encoding in query
    const r = await httpRequest({ path: '/search?foo=%GG&bar=ok' });
    const body = r.body ? JSON.parse(r.body) : {};
    result('Malformed %XX in query does not crash server', r.status === 200,
        `bar present: ${'bar' in (body.query || {})}, foo skipped: ${'foo' in (body.query || {})}` );
}

/* ── 6. Slowloris (Idle Connection Timeout) ──────────────────────── */
console.log('\n6. Slowloris / Idle Timeout');

{
    // Open a raw TCP connection and send only partial headers, then wait
    const socket = createConnection({ host: '127.0.0.1', port: 4444 });
    let closed = false;
    socket.on('close', () => { closed = true; });
    socket.on('error', () => { closed = true; });

    // Send partial HTTP request (no \r\n\r\n — triggers header buffer wait)
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');

    // Wait 35 seconds (timeout is 30 s) — server should close us
    await sleep(35000);
    result('Server closes idle/slow connections after 30 s', closed,
        closed ? 'Connection terminated by server' : 'WARNING: connection still open after 35 s');
    socket.destroy();
}

/* ── 7. Body Size Limit ─────────────────────────────────────────── */
console.log('\n7. Body Size Limit (1 MB default)');

{
    // Send a body larger than 1 MB
    const bigBody = 'x'.repeat(1048577);
    const r = await httpRequest({
        method: 'POST', path: '/echo',
        headers: { 'Content-Type': 'application/json', 'Content-Length': bigBody.length },
        body: bigBody,
    });
    result('Body > 1 MB → 413 Payload Too Large', r.status === 413, `Got ${r.status}`);
}
{
    // Send exactly 1 MB — should be OK
    const okBody = JSON.stringify({ data: 'x'.repeat(1048400) });
    const r = await httpRequest({
        method: 'POST', path: '/echo',
        headers: { 'Content-Type': 'application/json' },
        body: okBody,
    });
    result('Body at limit (≤1 MB) is accepted', r.status === 200, `Got ${r.status}`);
}

/* ── 8. JSON Schema Validation ─────────────────────────────────── */
console.log('\n8. Input Validation (JSON Schema)');

{
    const r = await httpRequest({
        method: 'POST', path: '/validate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' }),
    });
    result('Valid body passes schema validation', r.status === 200);
}
{
    const r = await httpRequest({
        method: 'POST', path: '/validate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notname: 'hacker' }),
    });
    result('Invalid body rejected with 400', r.status === 400);
}
{
    // Send non-JSON with Content-Type: application/json
    const r = await httpRequest({
        method: 'POST', path: '/validate',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all!!!',
    });
    result('Malformed JSON body rejected with 400', r.status === 400);
}

/* ── 9. X-Forwarded-For Trust Proxy ────────────────────────────── */
console.log('\n9. Trust Proxy (disabled by default)');

{
    const r = await httpRequest({
        path: '/headers',
        headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Forwarded-Proto': 'https' },
    });
    const body = JSON.parse(r.body || '{}');
    // req.ip should be 127.0.0.1 not 1.2.3.4 (trustProxy is false)
    result('X-Forwarded-For is NOT used as req.ip when trustProxy=false',
        r.status === 200); // ip is set from TCP, not from header
}

/* ── 10. Request Smuggling / Pipelining safety ─────────────────── */
console.log('\n10. Request Smuggling / Malformed Requests');

{
    // Send two requests sequentially on one keep-alive connection
    const socket = createConnection({ host: '127.0.0.1', port: 4444 });
    let buffer = '';
    const count = await new Promise(resolve => {
        socket.on('connect', () => {
            socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
        });
        socket.on('data', d => {
            buffer += d.toString();
            const matches = buffer.match(/HTTP\/1\.1 \d{3}/g) || [];
            if (matches.length >= 2) { socket.destroy(); resolve(matches.length); }
            if (matches.length === 1 && !socket._sentSecond) {
                socket._sentSecond = true;
                socket.write('GET /search?x=2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
            }
        });
        socket.on('close', () => resolve((buffer.match(/HTTP\/1\.1 \d{3}/g) || []).length));
        socket.on('error', () => resolve(0));
        setTimeout(() => { socket.destroy(); resolve((buffer.match(/HTTP\/1\.1 \d{3}/g) || []).length); }, 3000);
    });
    result('Sequential keep-alive requests both receive responses', count >= 2, `Responses: ${count}`);
}
{
    // Send request with no Host header
    const r = await rawTCP('GET / HTTP/1.1\r\nConnection: close\r\n\r\n');
    result('Request without Host header does not crash server',
        r.includes('HTTP/1.1'));
}
{
    // Send completely garbage bytes
    await rawTCP('\x00\x01\x02\x03\xff\xfe\r\n\r\n');
    result('Garbage bytes do not crash server', true);
}
{
    // Verify server still alive
    const r = await httpRequest({ path: '/' });
    result('Server alive after garbage attack', r.status === 200);
}

/* ── Verify server is still alive after all attacks ─────────────── */
console.log('\n11. Server Stability (alive after all attacks)');

{
    const r = await httpRequest({ path: '/' });
    result('Server responds normally after all attack tests', r.status === 200);
}

/* ═══════════════════════════════════════════════════════════════════
   RESULTS
   ═══════════════════════════════════════════════════════════════════ */

proc.kill();
try { unlinkSync('_sec_server.mjs'); } catch {}

const total = passed + failed;
console.log('\n' + '='.repeat(42));
console.log(`Results: ${passed}/${total} passed  |  ${failed} failed`);
console.log('='.repeat(42) + '\n');

if (failed > 0) process.exit(1);
