/*!
 * kidlat - which proxies to believe about X-Forwarded-*
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import net from 'net';

const PRESETS = {
    loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
    linklocal: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']],
    uniquelocal: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']],
};

export function unmapIPv4(addr) {
    return addr.length > 7 && addr.charCodeAt(0) === 58 && /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(addr)
        ? addr.slice(7) : addr;
}

export function cleanAddress(s) {
    s = s.trim();
    if (s.charCodeAt(0) === 91) {
        const end = s.indexOf(']');
        if (end === -1) return null;
        s = s.slice(1, end);
    } else {
        const colon = s.indexOf(':');
        if (colon !== -1 && colon === s.lastIndexOf(':')) s = s.slice(0, colon);   // v4:port
    }
    return net.isIP(s) !== 0 ? unmapIPv4(s) : null;
}

export function compileTrust(option) {
    if (option === undefined || option === null || option === false) return null;
    if (option === true) return (addr, hop) => hop === 0;
    if (typeof option === 'number') {
        if (!Number.isInteger(option) || option < 0) {
            throw new TypeError('trustProxy: a hop count must be a non-negative integer');
        }
        return option === 0 ? null : (addr, hop) => hop < option;
    }
    if (typeof option === 'function') return option;

    const list = typeof option === 'string' ? option.split(',') : option;
    if (!Array.isArray(list)) throw new TypeError('trustProxy: expected a boolean, number, string, array or function');
    const block = new net.BlockList();
    for (const raw of list) {
        const entry = String(raw).trim();
        if (entry === '') continue;
        if (PRESETS[entry]) {
            for (const [a, p, t] of PRESETS[entry]) block.addSubnet(a, p, t);
            continue;
        }
        const slash = entry.indexOf('/');
        const addr = unmapIPv4(slash === -1 ? entry : entry.slice(0, slash));
        const type = net.isIP(addr);
        if (type === 0) throw new TypeError(`trustProxy: "${entry}" is not an IP address or CIDR range`);
        const family = type === 4 ? 'ipv4' : 'ipv6';
        if (slash === -1) {
            block.addAddress(addr, family);
        } else {
            const bits = Number(entry.slice(slash + 1));
            if (!Number.isInteger(bits) || bits < 0 || bits > (type === 4 ? 32 : 128)) {
                throw new TypeError(`trustProxy: "${entry}" has an invalid prefix length`);
            }
            block.addSubnet(addr, bits, family);
        }
    }
    return (addr) => block.check(addr, net.isIPv4(addr) ? 'ipv4' : 'ipv6');
}

export function proxyChain(trust, socketIp, forwardedFor) {
    const peer = unmapIPv4(socketIp);
    if (trust === null || !forwardedFor || !trust(peer, 0)) return [socketIp];
    const parts = forwardedFor.split(',');
    const chain = [socketIp];
    for (let i = parts.length - 1, hop = 1; i >= 0; i--, hop++) {
        const addr = cleanAddress(parts[i]);
        if (addr === null) break; // garbage: stop at the last real address
        chain.push(addr);
        if (!trust(addr, hop)) break; // first untrusted hop is the client
    }
    return chain.reverse();
}

export function peerTrusted(trust, socketIp) {
    return trust !== null && trust(unmapIPv4(socketIp), 0);
}

const HOST_RE = /^(?:[\w](?:[\w-]{0,61}[\w])?(?:\.[\w](?:[\w-]{0,61}[\w])?)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export function validHost(h) {
    if (typeof h !== 'string' || h.length === 0 || h.length > 260 || !HOST_RE.test(h)) return null;
    if (h.charCodeAt(0) === 91 && net.isIPv6(h.slice(1, h.indexOf(']'))) === false) return null;
    return h;
}

export function lastValue(v) {
    const comma = v.lastIndexOf(',');
    return (comma === -1 ? v : v.slice(comma + 1)).trim();
}
