import { Kidlat } from 'kidlat';
import { createConnection } from 'net';

const app = new Kidlat({ logger: false });
app.get('/',       (req, res) => res.json({ route: 'root' }));
app.get('/second', (req, res) => res.json({ route: 'second' }));
app.get('/third',  (req, res) => res.json({ route: 'third' }));
app.post('/echo',  async (req, res) => { const b = await req.json(); res.json({ echo: b }); });

function rawRequest(port, data, timeout = 2000) {
    return new Promise(resolve => {
        const s = createConnection({ port });
        let buf = '';
        s.on('connect', () => s.write(data));
        s.on('data',  d => { buf += d.toString(); });
        s.on('end',   () => resolve(buf));
        s.on('close', () => resolve(buf));
        s.on('error', () => resolve(buf));
        setTimeout(() => { s.destroy(); resolve(buf); }, timeout);
    });
}

function countOk(raw)   { return (raw.match(/HTTP\/1\.1 200/g) || []).length; }
function pass(ok, desc) { console.log((ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + '  ' + desc); return ok; }

app.listen(4500, async () => {
    await new Promise(r => setTimeout(r, 100));
    let allPass = true;

    /* ── Test 1: Two GETs in one TCP write ──────────────────────── */
    {
        const raw = await rawRequest(4500,
            'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n' +
            'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        const c = countOk(raw);
        const hasRoot   = raw.includes('"root"');
        const hasSecond = raw.includes('"second"');
        allPass &= pass(c === 2 && hasRoot && hasSecond,
            `GET pipeline (2 in 1 write): ${c}/2 responses, root=${hasRoot}, second=${hasSecond}`);
    }

    /* ── Test 2: Three GETs pipelined ───────────────────────────── */
    {
        const raw = await rawRequest(4500,
            'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n' +
            'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n' +
            'GET /third HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        const c = countOk(raw);
        allPass &= pass(c === 3, `GET pipeline (3 in 1 write): ${c}/3 responses`);
    }

    /* ── Test 3: POST with body then GET pipelined ─────────────── */
    {
        const body = JSON.stringify({ hello: 'world' });
        const raw = await rawRequest(4500,
            'POST /echo HTTP/1.1\r\nHost: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${body.length}\r\n` +
            'Connection: keep-alive\r\n\r\n' + body +
            'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        const c       = countOk(raw);
        const hasEcho = raw.includes('hello');
        const hasNext = raw.includes('"second"');
        allPass &= pass(c === 2 && hasEcho && hasNext,
            `POST+body then GET: ${c}/2 responses, body echoed=${hasEcho}, GET served=${hasNext}`);
    }

    /* ── Test 4: POST body split across two TCP writes ─────────── */
    {
        const part1 = '{"split":';
        const part2 = '"yes"}';
        const fullBody = part1 + part2;
        const raw = await new Promise(resolve => {
            const s = createConnection({ port: 4500 });
            let buf = '';
            s.on('connect', () => {
                s.write(
                    'POST /echo HTTP/1.1\r\nHost: localhost\r\n' +
                    'Content-Type: application/json\r\n' +
                    `Content-Length: ${fullBody.length}\r\n` +
                    'Connection: close\r\n\r\n' + part1
                );
                setTimeout(() => s.write(part2), 50);
            });
            s.on('data',  d => { buf += d.toString(); });
            s.on('end',   () => resolve(buf));
            s.on('close', () => resolve(buf));
            setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
        });
        const hasBody = raw.includes('split') && raw.includes('yes');
        allPass &= pass(countOk(raw) === 1 && hasBody,
            `POST body split across 2 TCP writes: received=${countOk(raw)}/1, body intact=${hasBody}`);
    }

    /* ── Test 5: Normal single GET (regression) ─────────────────── */
    {
        const raw = await rawRequest(4500,
            'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        allPass &= pass(countOk(raw) === 1 && raw.includes('"root"'),
            'Single GET (regression check)');
    }

    /* ── Test 6: Two sequential requests on keep-alive ──────────── */
    {
        const raw = await new Promise(resolve => {
            const s = createConnection({ port: 4500 });
            let buf = '';
            let sent2 = false;
            s.on('connect', () =>
                s.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
            );
            s.on('data', d => {
                buf += d.toString();
                if (!sent2 && (buf.match(/HTTP\/1\.1 200/g) || []).length >= 1) {
                    sent2 = true;
                    s.write('GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
                }
            });
            s.on('end',   () => resolve(buf));
            s.on('close', () => resolve(buf));
            setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
        });
        const c = countOk(raw);
        allPass &= pass(c === 2, `Sequential keep-alive: ${c}/2 responses`);
    }

    console.log('\n' + (allPass ? '\x1b[32mAll tests passed\x1b[0m' : '\x1b[31mSome tests FAILED\x1b[0m'));
    process.exit(allPass ? 0 : 1);
});
