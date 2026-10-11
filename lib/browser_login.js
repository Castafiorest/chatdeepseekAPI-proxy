/**
 * Browser login session — drives the DeepSeek Web login flow from the running
 * server (so the Web UI can add accounts without `npm run auth`).
 *
 * Flow:
 *   1. start()   -> launches a dedicated Chrome for Testing profile on a CDP port
 *   2. (user logs in to chat.deepseek.com and sends one short message)
 *   3. finalize() -> reads token/cookies/hif headers, returns the auth object
 *
 * The heavy lifting (CDP screenshot-free extraction) mirrors
 * scripts/deepseek_chrome_auth.js but is reusable and non-blocking.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const LOGIN_URL = 'https://chat.deepseek.com/';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shellPatternSafe(s) { return String(s).replace(/[\\"']/g, '.'); }

function killExistingTestingChrome(port, profileDir) {
    if (process.platform !== 'darwin') return;
    const patterns = [`--remote-debugging-port=${port}`, profileDir].map(shellPatternSafe);
    for (const pattern of patterns) {
        try { execFileSync('/usr/bin/pkill', ['-f', pattern], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                try { fs.renameSync(dir, `${dir}.stale-${Date.now()}`); } catch { /* ignore */ }
                return;
            }
        }
    }
}

function resolveChromePath(repoRoot) {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

    // Puppeteer-bundled "Chrome for Testing" if the project has it.
    try {
        const puppeteerPath = require.resolve('puppeteer', { paths: [repoRoot] });
        const puppeteer = require(puppeteerPath);
        if (typeof puppeteer.executablePath === 'function') {
            const p = puppeteer.executablePath();
            if (p && fs.existsSync(p)) return p;
        }
    } catch { /* not installed */ }

    const candidates = [];
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
        try {
            for (const dir of fs.readdirSync(cacheRoot)) {
                const win = path.join(cacheRoot, dir, 'chrome-win64', 'chrome.exe');
                const mac = path.join(cacheRoot, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
                const linux = path.join(cacheRoot, dir, 'chrome-linux64', 'chrome');
                candidates.push(win, mac, linux);
            }
        } catch { /* no cache */ }
    }

    if (process.platform === 'win32') {
        candidates.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        );
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    }

    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return '';
}

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 1000) this.events.shift();
            }
        };
    }
    ready() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = () => reject(new Error('CDP WebSocket failed to open'));
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function normalizeToken(raw) {
    if (!raw) return '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not json */ }
    if (parsed && typeof parsed === 'object') {
        return String(parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '').trim();
    }
    return String(raw).trim();
}

async function readPageAuth(cdp) {
    const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
            const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
            for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
            for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
            out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
            return out;
        })()`,
        returnByValue: true,
    });
    const pageState = evalRes?.result?.value || {};
    const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}];

    let token = '';
    for (const store of stores) {
        for (const key of ['userToken', 'token', 'auth_token', 'access_token', 'accessToken']) {
            token = normalizeToken(store[key]);
            if (token) break;
        }
        if (token) break;
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k)) { token = normalizeToken(v); if (token) break; }
            }
            if (token) break;
        }
    }

    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter(c => /deepseek\.com$/.test(c.domain));
    const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    let hif_dliq = '', hif_leim = '';
    for (const ev of cdp.events) {
        const headers = ev.params?.headers || ev.params?.request?.headers;
        if (!headers) continue;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'x-hif-dliq') hif_dliq = String(v);
            if (lk === 'x-hif-leim') hif_leim = String(v);
            if (lk === 'authorization' && !token && /^Bearer\s+/i.test(String(v))) {
                token = String(v).replace(/^Bearer\s+/i, '');
            }
        }
    }

    const wasmUrl = (pageState.resources || []).find(u => /sha3.*\.wasm/.test(u)) || DEFAULT_WASM;
    return { token, cookie, hif_dliq, hif_leim, wasmUrl, href: pageState.href, cookiesCount: cookies.length };
}

class BrowserLoginSession {
    constructor({ repoRoot, port, profileDir }) {
        this.repoRoot = repoRoot;
        this.port = Number(port || process.env.DEEPSEEK_CHROME_PORT || 9334);
        this.profileDir = profileDir;
        this.chromePath = resolveChromePath(repoRoot);
        this.cdp = null;
        this.state = 'idle';          // idle | starting | awaiting | capturing | done | error | cancelled
        this.error = null;
        this.auth = null;
        this.startedAt = null;
    }

    status() {
        return {
            state: this.state,
            error: this.error,
            started_at: this.startedAt,
            chrome_found: Boolean(this.chromePath),
            port: this.port,
            profile: this.profileDir,
        };
    }

    async devtoolsReady() {
        try {
            const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    }

    async waitDevtools() {
        for (let i = 0; i < 80; i++) {
            const v = await this.devtoolsReady();
            if (v) return v;
            await sleep(250);
        }
        throw new Error('Chrome DevTools endpoint did not start (is another Chrome using this port?)');
    }

    async getPageTarget() {
        for (let i = 0; i < 40; i++) {
            let targets = [];
            try {
                const r = await fetch(`http://127.0.0.1:${this.port}/json`);
                targets = await r.json();
            } catch { /* retry */ }
            const page = targets.find(t => t.type === 'page' && /chat\.deepseek\.com/.test(t.url))
                || targets.find(t => t.type === 'page');
            if (page?.webSocketDebuggerUrl) return page;
            await sleep(250);
        }
        throw new Error('No Chrome page target found');
    }

    async start() {
        if (!this.chromePath) {
            this.state = 'error';
            this.error = 'Chrome/Chrome for Testing not found. Set CHROME_PATH to your chrome.exe and restart the server.';
            return this.status();
        }
        if (this.state === 'awaiting' || this.state === 'starting') return this.status();

        this.state = 'starting';
        this.error = null;
        this.startedAt = Date.now();

        try {
            killExistingTestingChrome(this.port, this.profileDir);
            if (fs.existsSync(this.profileDir)) removeProfileSafely(this.profileDir);
            fs.mkdirSync(this.profileDir, { recursive: true });

            const args = [
                `--user-data-dir=${this.profileDir}`,
                `--remote-debugging-port=${this.port}`,
                '--use-mock-keychain',
                '--password-store=basic',
                '--disable-sync',
                '--disable-extensions',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-infobars',
                LOGIN_URL,
            ];
            const chrome = spawn(this.chromePath, args, { stdio: 'ignore', detached: true });
            chrome.unref();

            await this.waitDevtools();
            const target = await this.getPageTarget();
            this.cdp = new CDP(target.webSocketDebuggerUrl);
            await this.cdp.ready();
            await this.cdp.send('Runtime.enable');
            await this.cdp.send('Network.enable');

            this.state = 'awaiting';
            return this.status();
        } catch (e) {
            this.state = 'error';
            this.error = e.message;
            this.close();
            return this.status();
        }
    }

    async finalize() {
        if (!this.cdp || (this.state !== 'awaiting' && this.state !== 'done')) {
            const err = new Error('No active browser login session. Click "Buka Chrome & Login" first.');
            err.status = 409; err.type = 'no_login_session';
            throw err;
        }
        this.state = 'capturing';
        try {
            let auth = null;
            for (let i = 0; i < 20; i++) {
                auth = await readPageAuth(this.cdp);
                if (auth.token && auth.cookie) break;
                await sleep(500);
            }
            if (!auth || !auth.token || !auth.cookie) {
                this.state = 'error';
                this.error = 'Could not read a DeepSeek token/cookie. Make sure you are logged in and sent one short message in the opened Chrome window.';
                const err = new Error(this.error);
                err.status = 422; err.type = 'capture_failed';
                throw err;
            }
            const { href, cookiesCount, ...persisted } = auth;
            this.auth = persisted;
            this.state = 'done';
            return { auth: persisted, href, cookiesCount };
        } catch (e) {
            if (this.state !== 'error') {
                this.state = 'error';
                this.error = e.message;
            }
            throw e;
        } finally {
            this.close();
        }
    }

    cancel() {
        if (this.state === 'error' || this.state === 'done') { this.close(); return; }
        this.state = 'cancelled';
        this.close();
    }

    close() {
        try { this.cdp?.close(); } catch { /* ignore */ }
        this.cdp = null;
        // The Chrome window is left open on purpose so the user keeps their login
        // (and so a follow-up account can reuse the profile if desired).
    }
}

module.exports = { BrowserLoginSession, resolveChromePath, readPageAuth, CDP };
