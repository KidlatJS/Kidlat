/*!
 * kidlat - native addon loader
 * Copyright(c) 2026 JoshLei
 * MIT Licensed
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

// KIDLAT_ABI_VERSION
export const ABI_VERSION = 6;

const SUPPORTED = [
    'win32-x64', 'darwin-arm64', 'darwin-x64',
    'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl',
];

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function isMusl() {
    if (process.platform !== 'linux') return false;
    const report = process.report;
    const excluded = report.excludeNetwork;
    try {
        report.excludeNetwork = true;
        return !report.getReport().header.glibcVersionRuntime;
    } catch {
        return false;
    } finally {
        report.excludeNetwork = excluded;
    }
}
const PLATFORM = `${process.platform}-${process.arch}${isMusl() ? '-musl' : ''}`;

function candidates() {
    const list = [];
    if (process.env.KIDLAT_NATIVE_PATH) list.push(process.env.KIDLAT_NATIVE_PATH);
    list.push(path.join(root, 'build', 'Release', 'kidlat.node'));
    list.push(path.join(root, 'build', 'Debug', 'kidlat.node'));
    const dir = path.join(root, 'prebuilds', PLATFORM);
    try {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.node')) list.push(path.join(dir, f));
    } catch { /* no prebuilds for this platform */ }
    return list;
}

function load() {
    const problems = [];
    for (const file of candidates()) {
        if (!fs.existsSync(file)) continue;
        let mod;
        try {
            mod = require(file);
        } catch (err) {
            problems.push(`  ${file}: ${err.message}`);
            continue;
        }
        if (mod.abiVersion !== ABI_VERSION) {
            problems.push(`  ${file}: built for native ABI ${mod.abiVersion ?? 1}, ` +
                `but this version of kidlat needs ${ABI_VERSION} (mismatched install)`);
            continue;
        }
        return mod;
    }
    throw new Error(
        `kidlat: no usable native binary for ${PLATFORM}.\n` +
        (problems.length ? problems.join('\n') + '\n' : '') +
        `  Kidlat ships binaries for ${SUPPORTED.join(', ')}.\n` +
        (SUPPORTED.includes(PLATFORM)
            ? '  Reinstall it (delete node_modules/kidlat and run npm install) — the install looks incomplete or mixed.'
            : '  This platform is not supported yet.') +
        '\n  (Working from a source checkout? Build the addon with "npm run build".)'
    );
}

export const native = load();
