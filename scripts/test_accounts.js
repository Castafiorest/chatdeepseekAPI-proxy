#!/usr/bin/env node
/**
 * Test every DeepSeek account in the pool and report whether each is really
 * connected (DeepSeek accepted the token/cookie), not just present on disk.
 *
 *   npm run accounts:test
 *   npm run accounts:test -- --no-session      # skip chat_session creation
 *   npm run accounts:test -- --json            # machine-readable output
 *
 * Each account is probed one at a time (serialized) so DeepSeek does not see a
 * burst from one IP and start throttling the pool.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch { return []; }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    const autoDir = path.join(ROOT, 'accounts');
    try {
        const files = fs.readdirSync(autoDir).filter(f => f.endsWith('.json')).sort().map(f => path.join(autoDir, f));
        if (files.length > 0) return files;
    } catch { /* no accounts dir */ }
    return [path.join(ROOT, 'deepseek-auth.json')];
}

function buildHeaders(config) {
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'x-client-platform': 'web',
        'x-client-version': '2.0.0',
        'x-client-locale': 'ru',
        'x-client-timezone-offset': '14400',
        'x-app-version': '2.0.0',
        'Authorization': `Bearer ${config.token || ''}`,
        'x-hif-dliq': config.hif_dliq || '',
        'x-hif-leim': config.hif_leim || '',
        'Origin': 'https://chat.deepseek.com',
        'Referer': 'https://chat.deepseek.com/',
        'Cookie': config.cookie || '',
        'Content-Type': 'application/json',
    };
}

function argFlag(args, name) { return args.includes(name); }

async function probe(account, { createSession, timeoutMs }) {
    const result = { file: account.file, label: account.label, auth_ok: false, live: false, session_id: null, http: null, error: null };
    const fetchOpts = (body) => ({
        method: 'POST',
        headers: account.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });

    try {
        const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', fetchOpts({ target_path: '/api/v0/chat/completion' }));
        result.http = cr.status;
        const text = await cr.text();
        if (!cr.ok) { result.error = `PoW HTTP ${cr.status}: ${text.substring(0, 80)}`; return result; }
        let json; try { json = JSON.parse(text); } catch { result.error = 'non-JSON PoW response'; return result; }
        const challenge = json?.data?.biz_data?.challenge;
        if (!challenge) { result.error = 'no PoW challenge (auth expired or captcha)'; return result; }
        result.auth_ok = true;

        if (createSession) {
            const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', fetchOpts({}));
            result.http = sr.status;
            const stext = await sr.text();
            let sjson = null; try { sjson = JSON.parse(stext); } catch { /* ignore */ }
            const sessionId = sjson?.data?.biz_data?.chat_session?.id || sjson?.data?.biz_data?.id;
            result.session_id = sessionId || null;
            result.live = Boolean(sr.ok && sessionId);
            if (!result.live) result.error = `session HTTP ${sr.status}`;
        } else {
            result.live = true;
        }
        return result;
    } catch (e) {
        result.error = e.message;
        return result;
    }
}

async function main(argv = process.argv.slice(2)) {
    const createSession = !argFlag(argv, '--no-session');
    const asJson = argFlag(argv, '--json');
    const timeoutMs = Number(process.env.DEEPSEEK_FETCH_TIMEOUT_MS || 30000);

    const files = discoverAuthPaths();
    if (files.length === 0) {
        console.error('[accounts:test] No auth files found. Add accounts via the Web UI or npm run auth:add.');
        return 1;
    }

    const accountList = [];
    files.forEach((file, i) => {
        try {
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            accountList.push({ label: `account_${i + 1}`, file: path.basename(file), config, headers: buildHeaders(config) });
        } catch (e) {
            accountList.push({ label: `account_${i + 1}`, file: path.basename(file), config: {}, headers: {}, _error: e.message });
        }
    });

    if (!asJson) {
        console.log(`\n[accounts:test] Testing ${accountList.length} account(s)${createSession ? ' (with chat-session create)' : ''}...\n`);
    }

    const results = [];
    for (const account of accountList) {
        if (account._error) {
            results.push({ file: account.file, label: account.label, auth_ok: false, live: false, error: `unreadable: ${account._error}` });
            continue;
        }
        process.stdout.write(asJson ? '' : `  ${account.label.padEnd(11)} ${account.file.padEnd(34)} `);
        const r = await probe(account, { createSession, timeoutMs });
        results.push(r);
        if (!asJson) {
            if (r.live && r.auth_ok) console.log(`✅ CONNECTED${r.session_id ? ' (session ' + String(r.session_id).substring(0, 8) + '…)' : ''}`);
            else if (r.auth_ok) console.log('⚠️  auth OK, session failed: ' + (r.error || ''));
            else console.log('❌ NOT connected: ' + (r.error || 'unknown'));
        }
        await new Promise(r => setTimeout(r, 400));
    }

    const live = results.filter(r => r.live).length;
    if (asJson) {
        console.log(JSON.stringify({ total: results.length, live, results }, null, 2));
    } else {
        console.log(`\n[accounts:test] ${live}/${results.length} account(s) connected.`);
        if (live === 0) console.log('[accounts:test] No live account — re-login an account from the Web UI (/admin).');
        else if (live === 1) console.log('[accounts:test] Only one live account: no failover headroom. Add another via /admin.');
    }
    return live > 0 ? 0 : 2;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch(e => { console.error('[accounts:test] ERROR:', e.message); process.exit(1); });
}
module.exports = { discoverAuthPaths, buildHeaders, probe };
