/*!
 * kidlat - request pipeline
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { httpError } from './errors.js';

export const isThenable = (v) => v !== null && typeof v === 'object' && typeof v.then === 'function';

export function runSteps(app, steps, i, req, res) {
    try {
        for (; i < steps.length; i++) {
            if (res.sent) return;
            const r = steps[i](req, res);
            if (r !== undefined && isThenable(r)) {
                const next = i + 1;
                r.then(
                    () => { if (next < steps.length) runSteps(app, steps, next, req, res); },
                    (err) => app._handleError(err, req, res)
                );
                return;
            }
        }
    } catch (err) {
        app._handleError(err, req, res);
    }
}

export function runDirect(app, handler, req, res) {
    let v;
    try {
        v = handler(req, res, noopNext);
        if (v === undefined || v === null || v === res) return;
        if (typeof v === 'object' && typeof v.then === 'function') {
            v.then(
                (val) => {
                    try {
                        if (val !== undefined && val !== null && val !== res && !res.sent) res.send(val);
                    } catch (err) {
                        app._handleError(err, req, res);
                    }
                },
                (err) => app._handleError(err, req, res)
            );
            return;
        }
        if (!res.sent) res.send(v);
    } catch (err) {
        app._handleError(err, req, res);
    }
}

export function normalizeHook(fn) {
    if (fn.length < 3) return fn;
    return (req, res) => new Promise((resolve, reject) => {
        fn(req, res, (err) => (err ? reject(err) : resolve()));
    });
}

const noopNext = () => {};

export function compose(middlewares, handler) {
    const n = middlewares.length;
    if (n === 0) return handler;
    return function composed(req, res) {
        let index = -1;
        const dispatch = (i) => {
            if (i <= index) throw new Error('next() called multiple times');
            index = i;
            if (res.sent) return undefined;
            if (i === n) return handler(req, res, noopNext);

            let called = false;
            let settle = null;
            const next = (err) => {
                called = true;
                if (err) {
                    if (settle !== null) { settle.reject(err); return undefined; }
                    throw err;
                }
                if (settle === null) return dispatch(i + 1);
                let r;
                try {
                    r = dispatch(i + 1);
                } catch (e) {
                    settle.reject(e);
                    return undefined;
                }
                if (isThenable(r)) r.then(settle.resolve, settle.reject);
                else settle.resolve(r);
                return r;
            };
            const r = middlewares[i](req, res, next);
            if (isThenable(r) || called || res.sent) return r;
            return new Promise((resolve, reject) => { settle = { resolve, reject }; });
        };
        return dispatch(0);
    };
}

export function handlerStep(fn) {
    return function handle(req, res) {
        const v = fn(req, res, noopNext);
        if (v === undefined || v === null || v === res) return undefined;
        if (isThenable(v)) {
            return v.then((val) => {
                if (val !== undefined && val !== null && val !== res && !res.sent) res.send(val);
            });
        }
        if (!res.sent) res.send(v);
        return undefined;
    };
}

export function validationStep(validators) {
    const { params, querystring, headers, body } = validators;

    const validateBody = (req, res) => {
        let data;
        try {
            data = req._parseJson();
        } catch (err) {
            if (err.statusCode === 413) return res.code(413).send('Payload Too Large');
            return res.code(400).json({ error: 'Invalid JSON body' });
        }
        if (!body(data)) return res.code(400).json({ error: 'Bad Request', details: body.errors });
        req.parsedBody = data;
        return undefined;
    };

    return function validate(req, res) {
        if (params && !params(req.params)) {
            return void res.code(400).json({ error: 'Bad Request', details: params.errors });
        }
        if (querystring && !querystring(req.query)) {
            return void res.code(400).json({ error: 'Bad Request', details: querystring.errors });
        }
        if (headers && !headers(req.headers)) {
            return void res.code(400).json({ error: 'Bad Request', details: headers.errors });
        }
        if (!body) return undefined;
        if (req.bodyComplete) {
            validateBody(req, res);
            return undefined;
        }
        return req._whenDone().then(
            () => { validateBody(req, res); },
            (err) => {
                if (res.sent) return;
                if (err.statusCode === 413) res.code(413).send('Payload Too Large');
                else throw err.statusCode ? err : httpError(400, 'Bad Request');
            }
        );
    };
}
