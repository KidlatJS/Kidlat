import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

test('Body Limit Test', async (t) => {
    const server = spawn('node', ['examples/app.js']);
    
    server.stderr.on('data', (data) => {
        console.error(`Server stderr: ${data}`);
    });
    server.stdout.on('data', (data) => {
        console.log(`Server stdout: ${data}`);
    });

    await setTimeout(500);

    await t.test('POST /echo with 500KB JSON (valid)', async () => {
        const payload = { data: 'a'.repeat(500000) };
        const response = await fetch('http://localhost:3000/echo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        assert.strictEqual(response.status, 200);
        const data = await response.json();
        assert.strictEqual(data.received.data.length, 500000);
    });

    await t.test('POST /echo with 2MB JSON (Payload Too Large)', async () => {
        const payload = { data: 'a'.repeat(2000000) };
        const response = await fetch('http://localhost:3000/echo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        assert.strictEqual(response.status, 413);
        const text = await response.text();
        assert.strictEqual(text, 'Payload Too Large');
    });

    server.kill();
});
