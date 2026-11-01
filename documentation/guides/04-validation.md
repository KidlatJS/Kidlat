# Validation & serialization

Schemas are standard **JSON Schema**. Kidlat compiles each one into a specialised
function when the route is registered, so validating costs very little per request.

## Validating input

```javascript
app.post('/users', {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'email'],
            properties: {
                username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-z0-9_]+$' },
                email:    { type: 'string', format: 'email' },
                age:      { type: 'integer', minimum: 13 },
                role:     { type: 'string', enum: ['user', 'admin'], default: 'user' },
            },
            additionalProperties: false,
        },
        querystring: {
            type: 'object',
            properties: { dryRun: { type: 'boolean', default: false } },
        },
        params:  { type: 'object', properties: { id: { type: 'integer' } } },
        headers: { type: 'object', required: ['x-api-key'], properties: { 'x-api-key': { type: 'string' } } },
    },
}, (req) => {
    req.parsedBody;      // validated body, with role defaulted to 'user'
    req.query.dryRun;    // a real boolean
});
```

- **Defaults** are filled in for missing properties.
- **Query strings, params and headers are strings on the wire**, so their
  validators **coerce** to the declared type: `"42"` → `42`, `"true"` → `true`,
  a single value → a one-element array for `type: 'array'`.
- Header names in schemas can be written in any case.

When validation fails, the handler doesn't run and the client gets `400`:

```json
{
  "error": "Bad Request",
  "details": [{
    "instancePath": "/username",
    "schemaPath": "#/properties/username/minLength",
    "keyword": "minLength",
    "params": { "limit": 3 },
    "message": "must NOT have fewer than 3 characters"
  }]
}
```

Validation stops at the first error. Invalid JSON gets `{ "error": "Invalid JSON body" }`.

## Serializing output

A response schema makes JSON output faster **and** acts as an allow-list — only
declared properties are sent:

```javascript
app.get('/me', {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: { id: { type: 'integer' }, name: { type: 'string' } },
            },
            '4xx': { type: 'object', properties: { error: { type: 'string' } } },
        },
    },
}, async (req) => {
    return db.users.find(req.userId);   // passwordHash, tokens… are never sent
});
```

Keys can be an exact status (`200`), a class (`'2xx'`, `'4xx'`) or `default`.
`additionalProperties: true` lets undeclared fields through.

## Shared schemas

```javascript
app.addSchema({
    $id: 'user',
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
});

app.post('/users', { schema: { body: { $ref: 'user#' } } }, create);
app.get('/users', { schema: { response: { 200: { type: 'array', items: { $ref: 'user#' } } } } }, list);
```

`$ref` also works with local pointers (`#/$defs/node`), including recursive schemas.

## Supported keywords

`type` (incl. arrays of types and `nullable`), `enum`, `const`, `required`,
`properties`, `additionalProperties`, `patternProperties`, `propertyNames`,
`minProperties`, `maxProperties`, `dependentRequired`, `dependencies`, `minLength`,
`maxLength`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `items`, `prefixItems`, `additionalItems`,
`minItems`, `maxItems`, `uniqueItems`, `contains`, `allOf`, `anyOf`, `oneOf`, `not`,
`if`/`then`/`else`, `default`, `$ref`.

Formats: `email`, `uri`, `uri-reference`, `uuid`, `date`, `date-time`, `time`,
`ipv4`, `ipv6`, `hostname`, `regex`, `json-pointer`, `byte`.

## Using the compilers directly

```javascript
import { compileValidator, compileSerializer } from 'kidlat';

const validate = compileValidator(schema, { coerceTypes: false, useDefaults: true });
if (!validate(data)) console.log(validate.errors);

const stringify = compileSerializer(schema);
stringify(data);   // JSON string
```

---

← [Responses](03-responses.md) · [All guides](../Guides.md) · [The request lifecycle: hooks & middleware](05-hooks-and-middleware.md) →
