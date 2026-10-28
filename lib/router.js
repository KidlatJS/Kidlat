/*!
 * kidlat - router
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

class Node {
    constructor() {
        this.children = null;
        this.params = null;
        this.wildcard = null;
        this.route = null;
    }
}

const NON_ASCII = /[^\x00-\x7f]/;

function parseParam(seg, path) {
    const open = seg.indexOf('(');
    if (open === -1) return { name: seg.slice(1), re: null, src: '' };
    if (!seg.endsWith(')')) throw new Error(`Invalid parameter "${seg}" in route ${path}`);
    const src = seg.slice(open + 1, -1);
    return { name: seg.slice(1, open), re: new RegExp(src), src };
}

export class Router {
    constructor({ ignoreTrailingSlash = false } = {}) {
        this.ignoreTrailingSlash = ignoreTrailingSlash;
        this.statics = Object.create(null); // method -> Map<path, route>
        this.trees = Object.create(null); // method -> Node
        this.routes = [];
        this.values = null;
    }

    on(method, path, route) {
        if (typeof path !== 'string' || path[0] !== '/') {
            throw new Error(`Route path must be a string starting with "/" (got ${JSON.stringify(path)})`);
        }
        if (this.ignoreTrailingSlash && path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        if (NON_ASCII.test(path)) path = encodeURI(path);

        const segs = path.split('/').slice(1);
        const dynamic = segs.some((s) => s[0] === ':' || s[0] === '*');
        this.routes.push({ method, path });

        if (!dynamic) {
            const map = this.statics[method] || (this.statics[method] = new Map());
            if (map.has(path)) throw new Error(`Route ${method} ${path} is already registered`);
            map.set(path, route);
            return path;
        }

        const names = [];
        let node = this.trees[method] || (this.trees[method] = new Node());
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (seg[0] === '*') {
                if (i !== segs.length - 1) throw new Error(`Wildcard must be the last segment in ${path}`);
                if (node.wildcard) throw new Error(`Route ${method} ${path} is already registered`);
                names.push('*');
                route.paramNames = names;
                node.wildcard = route;
                return path;
            }
            if (seg[0] === ':') {
                const { name, re, src } = parseParam(seg, path);
                if (!name) throw new Error(`Unnamed parameter in route ${path}`);
                names.push(name);
                node.params = node.params || [];
                let entry = node.params.find((p) => p.src === src);
                if (!entry) {
                    entry = { re, src, node: new Node() };
                    if (re) node.params.unshift(entry); else node.params.push(entry);
                }
                node = entry.node;
                continue;
            }
            node.children = node.children || new Map();
            let next = node.children.get(seg);
            if (!next) node.children.set(seg, next = new Node());
            node = next;
        }
        if (node.route) throw new Error(`Route ${method} ${path} is already registered`);
        route.paramNames = names;
        node.route = route;
        return path;
    }

    find(method, path) {
        if (this.ignoreTrailingSlash && path.length > 1 && path.charCodeAt(path.length - 1) === 47) {
            path = path.slice(0, -1);
        }
        const map = this.statics[method];
        if (map !== undefined) {
            const route = map.get(path);
            if (route !== undefined) { this.values = null; return route; }
        }
        const tree = this.trees[method];
        if (tree === undefined) return null;
        const values = [];
        const route = match(tree, path, 1, values);
        this.values = values;
        return route;
    }

    hasPath(path) {
        for (const method in this.statics) if (this.statics[method].has(path)) return true;
        for (const method in this.trees) if (match(this.trees[method], path, 1, []) !== null) return true;
        return false;
    }
}

function match(node, path, start, values) {
    const slash = path.indexOf('/', start);
    const end = slash === -1 ? path.length : slash;
    const seg = path.slice(start, end);

    if (node.children !== null) {
        const child = node.children.get(seg);
        if (child !== undefined) {
            if (slash === -1) {
                if (child.route !== null) return child.route;
            } else {
                const r = match(child, path, slash + 1, values);
                if (r !== null) return r;
            }
        }
    }
    if (node.params !== null && seg.length > 0) {
        for (let i = 0; i < node.params.length; i++) {
            const p = node.params[i];
            if (p.re !== null && !p.re.test(seg)) continue;
            values.push(seg);
            if (slash === -1) {
                if (p.node.route !== null) return p.node.route;
            } else {
                const r = match(p.node, path, slash + 1, values);
                if (r !== null) return r;
            }
            values.pop();
        }
    }
    if (node.wildcard !== null) {
        values.push(path.slice(start));
        return node.wildcard;
    }
    return null;
}

const decodeParam = (v) => (v.indexOf('%') === -1 ? v : decodeURIComponent(v));

export function compileParams(names) {
    if (names.includes('__proto__')) return (values) => buildParams(names, values);
    const fields = names.map((n, i) => `${JSON.stringify(n)}: d(v[${i}])`).join(', ');
    return new Function('d', `return function params(v) { return { ${fields} }; };`)(decodeParam);
}

export function buildParams(names, values) {
    const params = {};
    for (let i = 0; i < names.length; i++) {
        const v = values[i];
        params[names[i]] = v.indexOf('%') === -1 ? v : decodeURIComponent(v);
    }
    return params;
}
