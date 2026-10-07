import { spawn } from 'node:child_process';
const server = spawn('node', ['examples/app.js']);

server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);

setTimeout(async () => {
    try {
        await fetch('http://localhost:3000/');
    } catch(e) {}
    server.kill();
}, 500);
