/*!
 * kidlat - route schema compilation (request validation & response serialization)
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { compileValidator } from './schema/validator.js';
import { compileSerializer } from './schema/serializer.js';

export { compileValidator, compileSerializer };

function lowercaseHeaders(schema) {
    if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
    const properties = {};
    for (const k of Object.keys(schema.properties)) properties[k.toLowerCase()] = schema.properties[k];
    const out = { ...schema, properties };
    if (Array.isArray(schema.required)) out.required = schema.required.map((k) => k.toLowerCase());
    return out;
}

export function compileRouteSchema(schema, schemas) {
    if (!schema) return { validators: null, serializers: null };

    const validators = {};
    let any = false;
    if (schema.body) {
        validators.body = compileValidator(schema.body, { schemas });
        any = true;
    }
    const qs = schema.querystring || schema.query;
    if (qs) {
        validators.querystring = compileValidator(qs, { schemas, coerceTypes: true });
        any = true;
    }
    if (schema.params) {
        validators.params = compileValidator(schema.params, { schemas, coerceTypes: true });
        any = true;
    }
    if (schema.headers) {
        validators.headers = compileValidator(lowercaseHeaders(schema.headers), { schemas, coerceTypes: true });
        any = true;
    }

    let serializers = null;
    if (schema.response) {
        serializers = Object.create(null);
        for (const code of Object.keys(schema.response)) {
            serializers[code] = compileSerializer(schema.response[code], { schemas });
        }
    }
    return { validators: any ? validators : null, serializers };
}

export function pickSerializer(serializers, status) {
    return serializers[status]
        || serializers[((status / 100) | 0) + 'xx']
        || serializers.default
        || null;
}
