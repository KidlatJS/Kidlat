import net from 'net';

async function flood() {
    for (let i = 0; i < 1000; i++) {
        const client = net.createConnection(3000, 'localhost', () => {
            client.write('GET /async HTTP/1.1\r\nHost: localhost\r\n\r\n');
            client.destroy();
        });
        client.on('error', () => {});
    }
}
flood();
