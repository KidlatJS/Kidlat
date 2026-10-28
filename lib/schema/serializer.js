/*!
 * kidlat - schema-driven JSON serializer compiler
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

const ESCAPE = /[\u0000-\u001f"\\\ud800-\udfff]/;

export const S = {
    str(v) {
        if (typeof v !== 'string') {
            if (v === null || v === undefined) return '""';
            if (v instanceof Date) return '"' + v.toISOString() + '"';
            v = String(v);
        }
        const len = v.length;
        if (len < 42) {
            let out = '';
            let last = -1;
            for (let i = 0; i < len; i++) {
                const c = v.charCodeAt(i);
                if (c === 34 || c === 92) {
                    if (last === -1) last = 0;
                    out += v.slice(last, i) + '\\';
                    last = i;
                } else if (c < 32 || (c >= 0xd800 && c <= 0xdfff)) {
                    return JSON.stringify(v);
                }
            }
            return last === -1 ? '"' + v + '"' : '"' + out + v.slice(last) + '"';
        }
        return len < 5000 && !ESCAPE.test(v) ? '"' + v + '"' : JSON.stringify(v);
    },
    num(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? '' + v : 'null';
        v = Number(v);
        return Number.isFinite(v) ? '' + v : 'null';
    },
    int(v) {
        if (Number.isInteger(v)) return '' + v;
        if (typeof v === 'bigint') return v.toString();
        if (typeof v !== 'number') v = Number(v);
        return Number.isFinite(v) ? '' + Math.trunc(v) : 'null';
    },
    any(v) {
        const s = JSON.stringify(v);
        return s === undefined ? 'null' : s;
    },
};

const q = (v) => JSON.stringify(v);

function inferType(schema) {
    if (schema.type !== undefined) return schema.type;
    if (schema.properties || schema.additionalProperties || schema.patternProperties) return 'object';
    if (schema.items || schema.prefixItems) return 'array';
    if (schema.const !== undefined) return null;
    if (schema.enum !== undefined) {
        const t = new Set(schema.enum.map((v) => (v === null ? 'null' : typeof v)));
        if (t.size === 1 && t.has('string')) return 'string';
    }
    return null;
}

class Compiler {
    constructor(opts) {
        this.schemas = opts.schemas || new Map();
        this.scope = [];
        this.refCache = new Map();
        this.n = 0;
    }
    id(prefix) { return prefix + (this.n++); }
    lit(v) { this.scope.push(v); return `s[${this.scope.length - 1}]`; }

    fn(schema, root, cacheKey) {
        const idx = this.scope.length;
        this.scope.push(null);
        if (cacheKey !== undefined) this.refCache.set(cacheKey, idx);
        const prevRoot = this.root;
        this.root = root;
        const body = this.value(schema, 'input');
        this.root = prevRoot;
        const src = '"use strict";\nreturn function serialize(input) {\nlet json = "";\n' + body + '\nreturn json;\n};';
        this.scope[idx] = new Function('s', 'h', src)(this.scope, S);
        return idx;
    }

    resolveRef(ref) {
        const hash = ref.indexOf('#');
        const id = hash === -1 ? ref : ref.slice(0, hash);
        const pointer = hash === -1 ? '' : ref.slice(hash + 1);
        const base = id === '' ? this.root
            : this.schemas.get(id) || (this.root && this.root.$id === id ? this.root : null);
        if (!base) throw new Error(`Cannot resolve $ref "${ref}" in response schema`);
        const key = (id || '\0root') + '#' + pointer;
        if (this.refCache.has(key)) return this.refCache.get(key);
        let target = base;
        for (const part of pointer.split('/').slice(1)) {
            const k = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
            if (target === null || typeof target !== 'object' || !(k in target)) {
                throw new Error(`Cannot resolve $ref "${ref}" in response schema`);
            }
            target = target[k];
        }
        return this.fn(target, base, key);
    }

    value(schema, v) {
        if (schema === true || schema === undefined || schema === null || typeof schema !== 'object') {
            return `json += h.any(${v});\n`;
        }
        if (schema.$ref !== undefined) return `json += s[${this.resolveRef(schema.$ref)}](${v});\n`;
        if (Array.isArray(schema.allOf) && schema.allOf.length) {
            const merged = { type: 'object', properties: {}, required: [] };
            let objectLike = true;
            for (const sub of [schema, ...schema.allOf]) {
                const t = inferType(sub);
                if (t !== 'object' && t !== null) objectLike = false;
                Object.assign(merged.properties, sub.properties || {});
                if (Array.isArray(sub.required)) merged.required.push(...sub.required);
                if (sub.additionalProperties !== undefined) merged.additionalProperties = sub.additionalProperties;
            }
            if (objectLike) return this.value(merged, v);
            return `json += h.any(${v});\n`;
        }

        let type = inferType(schema);
        let nullable = schema.nullable === true;
        if (Array.isArray(type)) {
            const nonNull = type.filter((t) => t !== 'null');
            if (nonNull.length !== type.length) nullable = true;
            type = nonNull.length === 1 ? nonNull[0] : null;
        }
        if (type === null || type === undefined || schema.anyOf || schema.oneOf) return `json += h.any(${v});\n`;

        let body;
        switch (type) {
        case 'string':  body = `json += h.str(${v});\n`; break;
        case 'number':  body = `json += h.num(${v});\n`; break;
        case 'integer': body = `json += h.int(${v});\n`; break;
        case 'boolean': body = `json += ${v} ? "true" : "false";\n`; break;
        case 'null':    return 'json += "null";\n';
        case 'object':  body = this.object(schema, v); break;
        case 'array':   body = this.array(schema, v); break;
        default:        body = `json += h.any(${v});\n`;
        }
        if (nullable || type === 'object' || type === 'array') {
            return `if (${v} === null || ${v} === undefined) json += "null"; else {\n${body}}\n`;
        }
        return body;
    }

    object(schema, v) {
        const props = schema.properties || {};
        const keys = Object.keys(props);
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const obj = this.id('o');
        const sep = this.id('c');
        let c = `const ${obj} = typeof ${v}.toJSON === "function" ? ${v}.toJSON() : ${v};\njson += "{";\nlet ${sep} = false;\n`;

        let written = 'none';
        for (const k of keys) {
            const pv = this.id('p');
            const sub = props[k];
            const prefix = written === 'none' ? q(q(k) + ':')
                : written === 'always' ? q(',' + q(k) + ':')
                : `(${sep} ? ${q(',' + q(k) + ':')} : ${q(q(k) + ':')})`;
            const read = k === '__proto__'
                ? `(Object.prototype.hasOwnProperty.call(${obj}, "__proto__") ? Object.getOwnPropertyDescriptor(${obj}, "__proto__").value : undefined)`
                : `${obj}[${q(k)}]`;
            c += `{ let ${pv} = ${read};\nif (typeof ${pv} === "function") ${pv} = undefined;\n`;
            if (sub && typeof sub === 'object' && sub.default !== undefined) {
                c += `if (${pv} === undefined) ${pv} = ${this.lit(sub.default)};\n`;
            }
            c += `if (${pv} !== undefined) {\njson += ${prefix};\n${sep} = true;\n${this.value(sub, pv)}}`;
            if (required.has(k)) c += ` else throw new Error(${q(`"${k}" is required!`)});`;
            c += ' }\n';
            if (required.has(k)) written = 'always';
            else if (written === 'none') written = 'maybe';
        }

        const extra = schema.additionalProperties;
        const pattern = schema.patternProperties ? Object.entries(schema.patternProperties) : [];
        if ((extra !== undefined && extra !== false) || pattern.length) {
            const key = this.id('k');
            const known = keys.length ? `${this.lit(new Set(keys))}.has(${key})` : 'false';
            c += `for (const ${key} in ${obj}) {\nif (${known} || !Object.prototype.hasOwnProperty.call(${obj}, ${key})) continue;\n` +
                `const ${key}v = ${obj}[${key}];\nif (${key}v === undefined || typeof ${key}v === "function") continue;\n`;
            let handled = '';
            for (const [src, sub] of pattern) {
                const re = this.lit(new RegExp(src, 'u'));
                c += `${handled}if (${re}.test(${key})) {\njson += (${sep} ? "," : "") + h.str(${key}) + ":";\n${sep} = true;\n${this.value(sub, key + 'v')}}\n`;
                handled = 'else ';
            }
            if (extra !== undefined && extra !== false) {
                c += `${handled}{\njson += (${sep} ? "," : "") + h.str(${key}) + ":";\n${sep} = true;\n` +
                    this.value(extra === true ? undefined : extra, key + 'v') + '}\n';
            }
            c += '}\n';
        }
        return c + 'json += "}";\n';
    }

    array(schema, v) {
        const i = this.id('i');
        const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems
            : Array.isArray(schema.items) ? schema.items : null;
        const rest = tuple ? (Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems) : schema.items;
        let c = `json += "[";\nfor (let ${i} = 0; ${i} < ${v}.length; ${i}++) {\nif (${i} !== 0) json += ",";\n`;
        if (tuple) {
            tuple.forEach((sub, idx) => {
                c += `${idx ? 'else ' : ''}if (${i} === ${idx}) {\n${this.value(sub, `${v}[${i}]`)}}\n`;
            });
            c += `else {\n${this.value(rest && rest !== true ? rest : undefined, `${v}[${i}]`)}}\n`;
        } else {
            c += this.value(rest, `${v}[${i}]`);
        }
        return c + '}\njson += "]";\n';
    }
}

export function compileSerializer(schema, opts = {}) {
    const c = new Compiler(opts);
    return c.scope[c.fn(schema, schema)];
}
