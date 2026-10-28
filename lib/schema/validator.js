/*!
 * kidlat - JSON Schema validator compiler
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import net from 'net';

/* Formats */

const DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > DAYS[m]) return false;
    if (m === 2 && d === 29) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return true;
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;
const DT_RE   = /^(\d{4})-(\d{2})-(\d{2})[tT ]((?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):?[0-5]\d))$/;

export const FORMATS = {
    date(s) {
        const m = DATE_RE.exec(s);
        return m !== null && validDate(+m[1], +m[2], +m[3]);
    },
    time: (s) => TIME_RE.test(s),
    'date-time'(s) {
        const m = DT_RE.exec(s);
        return m !== null && validDate(+m[1], +m[2], +m[3]);
    },
    email: (s) => /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(s),
    hostname: (s) => s.length <= 253 && /^(?=[a-z0-9])[a-z0-9-]{1,63}(?<!-)(?:\.(?=[a-z0-9])[a-z0-9-]{1,63}(?<!-))*\.?$/i.test(s),
    ipv4: (s) => net.isIPv4(s),
    ipv6: (s) => net.isIPv6(s),
    uuid: (s) => /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s),
    uri(s) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
        try { new URL(s); return true; } catch { return false; }
    },
    'uri-reference'(s) {
        try { new URL(s, 'http://x/'); return !/\s/.test(s); } catch { return false; }
    },
    regex(s) {
        try { new RegExp(s, 'u'); return true; } catch { return false; }
    },
    'json-pointer': (s) => /^(?:\/(?:[^~/]|~0|~1)*)*$/.test(s),
    byte: (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s),
    int32: () => true,
    int64: () => true,
    float: () => true,
    double: () => true,
    password: () => true,
    binary: () => true,
};

/* Runtime helpers */

const hasOwn = Object.prototype.hasOwnProperty;

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return typeof a === 'number' && typeof b === 'number' && a !== a && b !== b;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!hasOwn.call(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
}

export const H = {
    has: (o, k) => hasOwn.call(o, k),
    len(s) {
        let n = s.length;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) { n--; i++; }
        }
        return n;
    },
    esc: (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1'),
    equal: deepEqual,
    inList(list, v) {
        for (let i = 0; i < list.length; i++) if (deepEqual(list[i], v)) return true;
        return false;
    },
    dup(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            for (let j = i - 1; j >= 0; j--) if (deepEqual(arr[i], arr[j])) return [j, i];
        }
        return null;
    },
    multipleOf(v, m) {
        const q = v / m;
        return Math.abs(Math.round(q) - q) < 1e-9 * Math.max(1, Math.abs(q));
    },
    clone: (v) => (v === null || typeof v !== 'object' ? v : structuredClone(v)),
};

/* Compiler */

const ptr = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const q = (v) => JSON.stringify(v);
const PRIMITIVE = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');
const needsOwnCheck = (k) => k in Object.prototype;

const TYPE_CHECK = {
    string:  (d) => `typeof ${d} === "string"`,
    number:  (d) => `(typeof ${d} === "number" && isFinite(${d}))`,
    integer: (d) => `Number.isInteger(${d})`,
    boolean: (d) => `typeof ${d} === "boolean"`,
    null:    (d) => `${d} === null`,
    object:  (d) => `(${d} !== null && typeof ${d} === "object" && !Array.isArray(${d}))`,
    array:   (d) => `Array.isArray(${d})`,
};

const STRING_KW = ['minLength', 'maxLength', 'pattern', 'format'];
const NUMBER_KW = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const OBJECT_KW = ['required', 'properties', 'additionalProperties', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired', 'dependencies'];
const ARRAY_KW  = ['items', 'prefixItems', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems', 'contains'];
const has = (schema, kws) => kws.some((k) => schema[k] !== undefined);

class Compiler {
    constructor(opts) {
        this.coerce = !!opts.coerceTypes;
        this.defaults = opts.useDefaults !== false;
        this.schemas = opts.schemas || new Map();
        this.scope = [];
        this.refCache = new Map();
        this.n = 0;
    }

    lit(value) {
        this.scope.push(value);
        return `s[${this.scope.length - 1}]`;
    }

    id(prefix) { return prefix + (this.n++); }

    fn(schema, schemaPath, root, cacheKey) {
        const idx = this.scope.length;
        this.scope.push(null);
        if (cacheKey !== undefined) this.refCache.set(cacheKey, idx);

        const prevRoot = this.root;
        this.root = root;
        const body = this.gen(schema, 'data', 'path', schemaPath, null, null);
        this.root = prevRoot;

        const src = '"use strict";\nreturn function validate(data, path) {\n' +
            'if (path === undefined) path = "";\n' + body +
            '\nvalidate.errors = null;\nreturn true;\n};';
        this.scope[idx] = new Function('s', 'h', src)(this.scope, H);
        return idx;
    }

    err(keyword, p, sp, params, message) {
        return `{ validate.errors = [{ instancePath: ${p}, schemaPath: ${q(sp + '/' + keyword)}, ` +
            `keyword: ${q(keyword)}, params: ${params}, message: ${message} }]; return false; }`;
    }

    call(idx, d, p) {
        return `if (!s[${idx}](${d}, ${p})) { validate.errors = s[${idx}].errors; return false; }`;
    }

    resolveRef(ref) {
        const hash = ref.indexOf('#');
        const id = hash === -1 ? ref : ref.slice(0, hash);
        const pointer = hash === -1 ? '' : ref.slice(hash + 1);
        let base;
        if (id === '') base = this.root;
        else if (this.schemas.has(id)) base = this.schemas.get(id);
        else if (this.root && this.root.$id === id) base = this.root;
        else throw new Error(`Cannot resolve $ref "${ref}" (register the schema with app.addSchema())`);

        const key = (id || '\0root') + '#' + pointer;
        if (this.refCache.has(key)) return this.refCache.get(key);

        let target = base;
        if (pointer) {
            for (const part of pointer.split('/').slice(1)) {
                const k = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
                if (target === null || typeof target !== 'object' || !(k in target)) {
                    throw new Error(`Cannot resolve $ref "${ref}"`);
                }
                target = target[k];
            }
        }
        return this.fn(target, '#' + pointer, base, key);
    }

    gen(schema, d, p, sp, parent, key) {
        if (schema === true || schema === undefined) return '';
        if (schema === false) return this.err('false schema', p, sp, '{}', '"boolean schema is false"');
        if (schema === null || typeof schema !== 'object') throw new Error(`Invalid schema at ${sp}`);

        let code = '';

        if (schema.$ref !== undefined) code += this.call(this.resolveRef(schema.$ref), d, p);

        let types = schema.type === undefined ? null
            : Array.isArray(schema.type) ? schema.type.slice() : [schema.type];
        if (types) {
            for (const t of types) if (!TYPE_CHECK[t]) throw new Error(`Unknown type "${t}" at ${sp}`);
            if (schema.nullable === true && !types.includes('null')) types.push('null');
            const cond = types.map((t) => TYPE_CHECK[t](d)).join(' || ');
            if (this.coerce && parent !== null) code += this.genCoerce(types, cond, d, parent, key);
            const tn = types.join(',');
            code += `if (!(${cond})) ${this.err('type', p, sp, `{ type: ${q(tn)} }`, q('must be ' + tn))}\n`;
        }

        if (schema.const !== undefined) {
            const c = schema.const;
            const cond = PRIMITIVE(c) ? `${d} !== ${q(c)}` : `!h.equal(${d}, ${this.lit(c)})`;
            code += `if (${cond}) ${this.err('const', p, sp, `{ allowedValue: ${this.lit(c)} }`, '"must be equal to constant"')}\n`;
        }
        if (schema.enum !== undefined) {
            const list = schema.enum;
            const cond = list.every(PRIMITIVE)
                ? `!${this.lit(new Set(list))}.has(${d})`
                : `!h.inList(${this.lit(list)}, ${d})`;
            code += `if (${cond}) ${this.err('enum', p, sp, `{ allowedValues: ${this.lit(list)} }`, '"must be equal to one of the allowed values"')}\n`;
        }

        if (has(schema, STRING_KW)) code += `if (typeof ${d} === "string") {\n${this.genString(schema, d, p, sp)}}\n`;
        if (has(schema, NUMBER_KW)) code += `if (typeof ${d} === "number") {\n${this.genNumber(schema, d, p, sp)}}\n`;
        if (has(schema, OBJECT_KW)) code += `if (${TYPE_CHECK.object(d)}) {\n${this.genObject(schema, d, p, sp)}}\n`;
        if (has(schema, ARRAY_KW))  code += `if (Array.isArray(${d})) {\n${this.genArray(schema, d, p, sp)}}\n`;

        /* combinators */
        if (Array.isArray(schema.allOf)) {
            schema.allOf.forEach((sub, i) => { code += this.gen(sub, d, p, `${sp}/allOf/${i}`, parent, key); });
        }
        if (Array.isArray(schema.anyOf)) {
            const fns = schema.anyOf.map((sub, i) => this.fn(sub, `${sp}/anyOf/${i}`, this.root));
            const cond = fns.map((i) => `s[${i}](${d}, ${p})`).join(' || ');
            code += `if (!(${cond})) ${this.err('anyOf', p, sp, '{}', '"must match a schema in anyOf"')}\n`;
        }
        if (Array.isArray(schema.oneOf)) {
            const fns = schema.oneOf.map((sub, i) => this.fn(sub, `${sp}/oneOf/${i}`, this.root));
            const cnt = this.id('n');
            code += `{ let ${cnt} = 0; ${fns.map((i) => `if (s[${i}](${d}, ${p})) ${cnt}++;`).join(' ')}\n` +
                `if (${cnt} !== 1) ${this.err('oneOf', p, sp, `{ passingSchemas: ${cnt} }`, '"must match exactly one schema in oneOf"')} }\n`;
        }
        if (schema.not !== undefined) {
            const i = this.fn(schema.not, `${sp}/not`, this.root);
            code += `if (s[${i}](${d}, ${p})) ${this.err('not', p, sp, '{}', '"must NOT be valid"')}\n`;
        }
        if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
            const ci = this.fn(schema.if, `${sp}/if`, this.root);
            code += `if (s[${ci}](${d}, ${p})) {\n`;
            if (schema.then !== undefined) code += this.call(this.fn(schema.then, `${sp}/then`, this.root), d, p);
            code += '\n} else {\n';
            if (schema.else !== undefined) code += this.call(this.fn(schema.else, `${sp}/else`, this.root), d, p);
            code += '\n}\n';
        }
        return code;
    }

    genCoerce(types, cond, d, parent, key) {
        let c = `if (!(${cond})) { let cv; const t = typeof ${d};\n`;
        for (const t of types) {
            switch (t) {
            case 'number':
                c += `if (cv === undefined) { if (t === "string" && ${d} !== "" && isFinite(+${d})) cv = +${d}; else if (t === "boolean") cv = +${d}; else if (${d} === null) cv = 0; }\n`;
                break;
            case 'integer':
                c += `if (cv === undefined) { if (t === "string" && ${d} !== "" && Number.isInteger(+${d})) cv = +${d}; else if (t === "boolean") cv = +${d}; else if (${d} === null) cv = 0; }\n`;
                break;
            case 'boolean':
                c += `if (cv === undefined) { if (${d} === "true" || ${d} === 1 || ${d} === "1") cv = true; else if (${d} === "false" || ${d} === 0 || ${d} === "0" || ${d} === null) cv = false; }\n`;
                break;
            case 'string':
                c += `if (cv === undefined) { if (t === "number" || t === "boolean") cv = String(${d}); else if (${d} === null) cv = ""; }\n`;
                break;
            case 'null':
                c += `if (cv === undefined && (${d} === "" || ${d} === 0 || ${d} === false)) cv = null;\n`;
                break;
            case 'array':
                c += `if (cv === undefined && !Array.isArray(${d})) cv = [${d}];\n`;
                break;
            }
        }
        return c + `if (cv !== undefined) { ${d} = cv; ${parent}[${key}] = cv; } }\n`;
    }

    genString(schema, d, p, sp) {
        let c = '';
        if (schema.minLength !== undefined) {
            const n = schema.minLength;
            c += `if (${d}.length < ${n} || (${d}.length < ${2 * n} && h.len(${d}) < ${n})) ` +
                this.err('minLength', p, sp, `{ limit: ${n} }`, q(`must NOT have fewer than ${n} characters`)) + '\n';
        }
        if (schema.maxLength !== undefined) {
            const n = schema.maxLength;
            c += `if (${d}.length > ${n} && h.len(${d}) > ${n}) ` +
                this.err('maxLength', p, sp, `{ limit: ${n} }`, q(`must NOT have more than ${n} characters`)) + '\n';
        }
        if (schema.pattern !== undefined) {
            const re = this.lit(new RegExp(schema.pattern, 'u'));
            c += `if (!${re}.test(${d})) ` +
                this.err('pattern', p, sp, `{ pattern: ${q(schema.pattern)} }`, q(`must match pattern "${schema.pattern}"`)) + '\n';
        }
        if (schema.format !== undefined && FORMATS[schema.format]) {
            const f = this.lit(FORMATS[schema.format]);
            c += `if (!${f}(${d})) ` +
                this.err('format', p, sp, `{ format: ${q(schema.format)} }`, q(`must match format "${schema.format}"`)) + '\n';
        }
        return c;
    }

    genNumber(schema, d, p, sp) {
        let c = '';
        const cmp = (kw, op, limit, comparison) => {
            c += `if (!(${d} ${op} ${limit})) ` +
                this.err(kw, p, sp, `{ comparison: ${q(comparison)}, limit: ${limit} }`, q(`must be ${comparison} ${limit}`)) + '\n';
        };
        if (schema.minimum !== undefined) {
            if (schema.exclusiveMinimum === true) cmp('exclusiveMinimum', '>', schema.minimum, '>');
            else cmp('minimum', '>=', schema.minimum, '>=');
        }
        if (schema.maximum !== undefined) {
            if (schema.exclusiveMaximum === true) cmp('exclusiveMaximum', '<', schema.maximum, '<');
            else cmp('maximum', '<=', schema.maximum, '<=');
        }
        if (typeof schema.exclusiveMinimum === 'number') cmp('exclusiveMinimum', '>', schema.exclusiveMinimum, '>');
        if (typeof schema.exclusiveMaximum === 'number') cmp('exclusiveMaximum', '<', schema.exclusiveMaximum, '<');
        if (schema.multipleOf !== undefined) {
            const m = schema.multipleOf;
            c += `if (!h.multipleOf(${d}, ${m})) ` +
                this.err('multipleOf', p, sp, `{ multipleOf: ${m} }`, q(`must be multiple of ${m}`)) + '\n';
        }
        return c;
    }

    genObject(schema, d, p, sp) {
        let c = '';
        const props = schema.properties || {};
        const propKeys = Object.keys(props);
        const get = (k) => (needsOwnCheck(k) ? `(h.has(${d}, ${q(k)}) ? ${d}[${q(k)}] : undefined)` : `${d}[${q(k)}]`);

        if (this.defaults) {
            for (const k of propKeys) {
                const sub = props[k];
                if (sub && typeof sub === 'object' && sub.default !== undefined) {
                    const dv = PRIMITIVE(sub.default) ? q(sub.default) : `h.clone(${this.lit(sub.default)})`;
                    c += `if (${get(k)} === undefined) ${d}[${q(k)}] = ${dv};\n`;
                }
            }
        }

        if (Array.isArray(schema.required)) {
            for (const k of schema.required) {
                c += `if (${get(k)} === undefined) ` +
                    this.err('required', p, sp, `{ missingProperty: ${q(k)} }`, q(`must have required property '${k}'`)) + '\n';
            }
        }

        if (schema.minProperties !== undefined || schema.maxProperties !== undefined) {
            const cnt = this.id('n');
            c += `{ const ${cnt} = Object.keys(${d}).length;\n`;
            if (schema.minProperties !== undefined) {
                const n = schema.minProperties;
                c += `if (${cnt} < ${n}) ` + this.err('minProperties', p, sp, `{ limit: ${n} }`, q(`must NOT have fewer than ${n} properties`)) + '\n';
            }
            if (schema.maxProperties !== undefined) {
                const n = schema.maxProperties;
                c += `if (${cnt} > ${n}) ` + this.err('maxProperties', p, sp, `{ limit: ${n} }`, q(`must NOT have more than ${n} properties`)) + '\n';
            }
            c += '}\n';
        }

        const depReq = schema.dependentRequired || {};
        const deps = schema.dependencies || {};
        for (const [k, v] of Object.entries({ ...deps, ...depReq })) {
            if (Array.isArray(v)) {
                for (const r of v) {
                    c += `if (${get(k)} !== undefined && ${get(r)} === undefined) ` +
                        this.err('dependencies', p, sp, `{ property: ${q(k)}, missingProperty: ${q(r)} }`,
                            q(`must have property ${r} when property ${k} is present`)) + '\n';
                }
            } else if (v && typeof v === 'object') {
                c += `if (${get(k)} !== undefined) {\n${this.gen(v, d, p, `${sp}/dependencies/${ptr(k)}`, null, null)}}\n`;
            }
        }

        for (const k of propKeys) {
            const sub = props[k];
            if (sub === true || (sub && typeof sub === 'object' && Object.keys(sub).length === 0)) continue;
            const v = this.id('v');
            const inner = this.gen(sub, v, `${p} + ${q('/' + ptr(k))}`, `${sp}/properties/${ptr(k)}`, d, q(k));
            if (inner) c += `{ let ${v} = ${get(k)};\nif (${v} !== undefined) {\n${inner}} }\n`;
        }

        const pattern = schema.patternProperties ? Object.entries(schema.patternProperties) : [];
        const extra = schema.additionalProperties;
        const names = schema.propertyNames;
        if (pattern.length || (extra !== undefined && extra !== true) || names !== undefined) {
            const key = this.id('k');
            const val = this.id('v');
            const keyPath = `${p} + "/" + h.esc(${key})`;
            c += `for (const ${key} in ${d}) {\nif (!h.has(${d}, ${key})) continue;\nlet ${val} = ${d}[${key}];\n`;
            if (names !== undefined) {
                const ni = this.fn(names, `${sp}/propertyNames`, this.root);
                c += `if (!s[${ni}](${key}, ${keyPath})) ` +
                    this.err('propertyNames', keyPath, sp, `{ propertyName: ${key} }`, '"property name must be valid"') + '\n';
            }
            let matched = 'false';
            if (pattern.length) {
                const m = this.id('m');
                c += `let ${m} = false;\n`;
                pattern.forEach(([src, sub]) => {
                    const re = this.lit(new RegExp(src, 'u'));
                    c += `if (${re}.test(${key})) { ${m} = true;\n` +
                        this.gen(sub, val, keyPath, `${sp}/patternProperties/${ptr(src)}`, d, key) + '}\n';
                });
                matched = m;
            }
            if (extra !== undefined && extra !== true) {
                const known = propKeys.length > 8
                    ? `${this.lit(new Set(propKeys))}.has(${key})`
                    : (propKeys.map((k) => `${key} === ${q(k)}`).join(' || ') || 'false');
                c += `if (!(${known}) && !${matched}) {\n`;
                if (extra === false) {
                    c += this.err('additionalProperties', p, sp, `{ additionalProperty: ${key} }`, '"must NOT have additional properties"');
                } else {
                    c += this.gen(extra, val, keyPath, `${sp}/additionalProperties`, d, key);
                }
                c += '}\n';
            }
            c += '}\n';
        }
        return c;
    }

    genArray(schema, d, p, sp) {
        let c = '';
        if (schema.minItems !== undefined) {
            const n = schema.minItems;
            c += `if (${d}.length < ${n}) ` + this.err('minItems', p, sp, `{ limit: ${n} }`, q(`must NOT have fewer than ${n} items`)) + '\n';
        }
        if (schema.maxItems !== undefined) {
            const n = schema.maxItems;
            c += `if (${d}.length > ${n}) ` + this.err('maxItems', p, sp, `{ limit: ${n} }`, q(`must NOT have more than ${n} items`)) + '\n';
        }
        if (schema.uniqueItems === true) {
            const dup = this.id('u');
            c += `{ const ${dup} = h.dup(${d}); if (${dup} !== null) ` +
                this.err('uniqueItems', p, sp, `{ i: ${dup}[1], j: ${dup}[0] }`,
                    `"must NOT have duplicate items (items ## " + ${dup}[0] + " and " + ${dup}[1] + " are identical)"`) + ' }\n';
        }

        const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems
            : Array.isArray(schema.items) ? schema.items : null;
        const rest = Array.isArray(schema.prefixItems) ? schema.items
            : Array.isArray(schema.items) ? schema.additionalItems : schema.items;
        const start = tuple ? tuple.length : 0;

        if (tuple) {
            tuple.forEach((sub, i) => {
                const v = this.id('v');
                const inner = this.gen(sub, v, `${p} + "/${i}"`, `${sp}/items/${i}`, d, String(i));
                if (inner) c += `if (${d}.length > ${i}) { let ${v} = ${d}[${i}];\n${inner}}\n`;
            });
        }
        if (rest === false) {
            c += `if (${d}.length > ${start}) ` +
                this.err(tuple && !Array.isArray(schema.prefixItems) ? 'additionalItems' : 'items', p, sp, `{ limit: ${start} }`, q(`must NOT have more than ${start} items`)) + '\n';
        } else if (rest !== undefined && rest !== true) {
            const i = this.id('i');
            const v = this.id('v');
            const inner = this.gen(rest, v, `${p} + "/" + ${i}`, `${sp}/items`, d, i);
            if (inner) c += `for (let ${i} = ${start}; ${i} < ${d}.length; ${i}++) { let ${v} = ${d}[${i}];\n${inner}}\n`;
        }

        if (schema.contains !== undefined) {
            const ci = this.fn(schema.contains, `${sp}/contains`, this.root);
            const i = this.id('i');
            const found = this.id('f');
            c += `{ let ${found} = false; for (let ${i} = 0; ${i} < ${d}.length; ${i}++) if (s[${ci}](${d}[${i}], ${p} + "/" + ${i})) { ${found} = true; break; }\n` +
                `if (!${found}) ` + this.err('contains', p, sp, '{}', '"must contain at least 1 valid item"') + ' }\n';
        }
        return c;
    }
}

export function compileValidator(schema, opts = {}) {
    const c = new Compiler(opts);
    const idx = c.fn(schema, '#', schema);
    return c.scope[idx];
}
