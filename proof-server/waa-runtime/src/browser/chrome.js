'use strict';

/**
 * Headless Chrome bootstrap for the browser proof provider.
 *
 * We use a throw-away profile so the user's normal Chrome session is never
 * touched.  The page is a harmless same-origin text document
 * (`https://aistudio.google.com/robots.txt`) whose only purpose is to give an
 * iframe a real `https://aistudio.google.com` origin for CORS.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.WAA_CHROME,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

async function waitForFile(file, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${file}`);
    await sleep(100);
  }
}

async function waitForJson(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${url}: ${lastErr && lastErr.message}`);
    await sleep(150);
  }
}

class ChromeProcess {
  constructor(options = {}) {
    this.options = options;
    this.proc = null;
    this.profileDir = null;
    this.port = 0;
    this.userAgent = options.userAgent;
    this.stderr = [];
  }

  async launch() {
    const chrome = findChrome(this.options.chromePath);
    if (!chrome) throw new Error('Chrome/Edge not found. Set WAA_CHROME to the browser executable.');
    const profileDir = this.options.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'waa-chrome-'));
    this.profileDir = profileDir;
    this.chrome = chrome;
    const args = [
      this.options.headless === false ? '--window-size=1280,900' : '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--mute-audio',
      '--lang=en-US',
      '--window-size=1280,900',
    ];
    if (this.userAgent) args.push(`--user-agent=${this.userAgent}`);
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    args.push('about:blank');

    this.proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.on('data', () => {});
    this.proc.stderr.on('data', (d) => {
      const s = String(d);
      this.stderr.push(s);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    this.proc.on('exit', (code, signal) => { this.exit = { code, signal }; });

    const devtoolsFile = path.join(profileDir, 'DevToolsActivePort');
    const text = await waitForFile(devtoolsFile, this.options.launchTimeoutMs || 25000);
    this.port = Number(text.split(/\r?\n/)[0]);
    if (!this.port) throw new Error('invalid DevToolsActivePort: ' + text);
    this.version = await waitForJson(`http://127.0.0.1:${this.port}/json/version`, 15000);
    return this;
  }

  async newPage(url = 'about:blank') {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`cannot create page: HTTP ${res.status}`);
    return await res.json();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.port) {
        await fetch(`http://127.0.0.1:${this.port}/json/close/${this._pageId || ''}`).catch(() => {});
      }
    } catch {}
    try { this.proc && this.proc.kill(); } catch {}
    await sleep(300);
    try { this.proc && this.proc.kill('SIGKILL'); } catch {}
    if (this.profileDir && !this.options.keepProfile) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(this.profileDir, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
    }
  }

  diagnostics() {
    return {
      chrome: this.chrome,
      port: this.port,
      version: this.version && this.version.Browser,
      exit: this.exit,
      stderr: this.stderr.join('').split(/\r?\n/).filter(Boolean).slice(-20),
    };
  }
}

module.exports = { ChromeProcess, findChrome, waitForJson, waitForFile, sleep };
