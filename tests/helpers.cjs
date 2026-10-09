'use strict';
// Shared test helpers: a fake connector, temp folders, a scripted terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const HOOK = 'block-credentials-read.cjs';

/** A fake octocheck_connector. accounts: { "KEY:SECRET": { user, mode } } */
function startConnector(options = {}) {
  const accounts = options.accounts || { 'goodkey1234:goodsecret99': { user: 'dev@example.com', mode: 'developer' } };
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization || null });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (options.redirectTo) return send(302, {}, { Location: options.redirectTo });
    if (req.url !== '/api/method/octocheck_connector.api.get_info') return send(404, { exc_type: 'NotFound' });
    if (options.status) return send(options.status, options.body || {});
    const token = (req.headers.authorization || '').replace(/^token /, '');
    const account = accounts[token];
    if (!account) return send(401, { exc_type: 'AuthenticationError' });
    if (options.disabled) {
      return send(403, {
        exc_type: 'PermissionError',
        _server_messages: JSON.stringify([JSON.stringify({ message: 'The OctoCheck connector is disabled. Enable it in OctoCheck Settings.' })]),
      });
    }
    return send(200, {
      message: {
        bundle_version: options.bundleVersion || 1, connector_version: '0.1.0', site: 'test.localhost',
        frappe_version: '15.0.0', user: account.user, access_mode: account.mode,
        counts: { 'Server Script': 7, 'Client Script': 1 },
      },
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** A throwaway project folder plus a throwaway home with the credentials folder inside it. */
function makeWorld({ withHook = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocheck-test-'));
  const cwd = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (withHook) fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node .claude/hooks/${HOOK}` }] }] } }));
  const credDir = path.join(home, '.config', 'octocheck');
  return {
    root, cwd, home, credDir, env: { HOME: home },
    credFile: path.join(credDir, 'octocheck-credentials.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A scripted terminal. Records everything printed so tests can prove no secret was shown. */
function makeIo({ tty = true, visible = [], hidden = [] } = {}) {
  const lines = [];
  const asked = [];
  return {
    isTTY: tty,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    askVisible: async (label) => { asked.push(label); return visible.shift(); },
    askHidden: async (label) => { asked.push(label); return hidden.shift(); },
    text: () => lines.join('\n'),
    asked,
  };
}

class FakeStdin extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.raw = false; this.paused = true; }
  setRawMode(v) { this.raw = v; return this; }
  resume() { this.paused = false; }
  pause() { this.paused = true; }
  setEncoding() {}
}

module.exports = { startConnector, makeWorld, makeIo, FakeStdin, HOOK };
