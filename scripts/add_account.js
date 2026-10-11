#!/usr/bin/env node
/**
 * Add a DeepSeek account to the local pool with one command.
 *
 *   npm run auth:add                 # interactive: asks for a name
 *   npm run auth:add -- --name acc2  # non-interactive
 *
 * It opens a DEDICATED Chrome profile per account (so you can log in with a
 * different DeepSeek account) and writes the result to accounts/<name>.json.
 * The server auto-discovers every *.json in accounts/ on startup.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_DIR = process.env.DEEPSEEK_AUTH_DIR || path.join(ROOT, 'accounts');

function argValue(args, ...names) {
    for (let i = 0; i < args.length; i++) {
        if (names.includes(args[i])) return args[i + 1];
        for (const name of names) {
            if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
        }
    }
    return '';
}
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function sanitizeName(name) {
    const base = String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    return base || '';
}
function nextAccountName() {
    let n = 1;
    while (fs.existsSync(path.join(ACCOUNTS_DIR, `account${n}.json`))) n++;
    return `account${n}`;
}

async function main(argv = process.argv.slice(2)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

    let name = sanitizeName(argValue(argv, '--name', '-n'));
    if (!name) {
        const suggested = nextAccountName();
        const answer = await ask(`Account name (Enter = ${suggested}): `);
        name = sanitizeName(answer) || suggested;
    }

    const outPath = path.join(ACCOUNTS_DIR, `${name}.json`);
    const profileDir = path.join(ROOT, `.chrome-profile-${name}`);

    if (fs.existsSync(outPath)) {
        const overwrite = (await ask(`${outPath} already exists. Overwrite? (y/N): `)).trim().toLowerCase();
        if (overwrite !== 'y' && overwrite !== 'yes') {
            console.log('[auth:add] Cancelled.');
            return 0;
        }
    }

    console.log(`[auth:add] Account file : ${outPath}`);
    console.log(`[auth:add] Chrome profile: ${profileDir}`);
    console.log('[auth:add] Opening Chrome — log in with a DIFFERENT DeepSeek account, send a short message, then return here.\n');

    const env = {
        ...process.env,
        DEEPSEEK_AUTH_PATH: outPath,
        DEEPSEEK_CHROME_PROFILE: profileDir,
    };
    const result = spawnSync(process.execPath, [path.join(__dirname, 'deepseek_chrome_auth.js')], {
        stdio: 'inherit',
        env,
    });

    if (result.status !== 0 || !fs.existsSync(outPath)) {
        console.error('\n[auth:add] Login did not complete. Nothing was saved.');
        return result.status || 1;
    }

    console.log(`\n[auth:add] ✅ Saved ${path.basename(outPath)}`);
    console.log('[auth:add] The running server auto-discovers accounts/ on startup.');
    console.log('[auth:add] If the server is already running, open http://127.0.0.1:9655/admin and click "Reload dari disk".');
    return 0;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch(e => { console.error('[auth:add] ERROR:', e.message); process.exit(1); });
}
module.exports = { main, sanitizeName, nextAccountName };
