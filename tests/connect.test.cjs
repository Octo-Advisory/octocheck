'use strict';
// /octocheck-connect: connecting a computer by approving it in the browser (connector 0.1.1+).
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const site = require('../.claude/scripts/octocheck-site.cjs');
const { startConnector, makeWorld, makeIo } = require('./helpers.cjs');

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abc';
const ACCOUNTS = {
  [`connection:${TOKEN}`]: { user: 'dev@example.com', mode: 'developer' },
  'goodkey1234:goodsecret99': { user: 'dev@example.com', mode: 'developer' },
};

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
});

/** A browser that "clicks" with the given answer once the page link is opened. Records what it saw. */
function browser(answer) {
  const seen = { links: [], pages: [] };
  const open = (link) => {
    seen.links.push(link);
    const u = new URL(link);
    const port = u.searchParams.get('port');
    const state = u.searchParams.get('state');
    setImmediate(async () => {
      for (const params of answer(state)) {
        seen.pages.push(await get(`http://127.0.0.1:${port}/callback?${new URLSearchParams(params)}`));
      }
    });
  };
  return { open, seen };
}

async function connect(w, c, b, args = [], extra = {}) {
  const io = makeIo({ tty: false });
  const code = await site.main(['connect', '--url', c.url, ...args], {
    io, cwd: w.cwd, env: w.env, home: w.home, openBrowser: b.open, platform: 'linux', ...extra,
  });
  return { code, text: io.text() };
}

const approve = (state) => [{ state, token: TOKEN, user: 'dev@example.com', expires_on: '2027-01-11 10:00:00' }];

module.exports = [
  ['approving in the browser saves the connection and the site, and never prints the token', async () => {
    const c = await startConnector({ accounts: ACCOUNTS, connectorVersion: '0.1.1' });
    const w = makeWorld();
    const b = browser(approve);
    const r = await connect(w, c, b, ['--site', 'heeru-dev']);
    assert.strictEqual(r.code, 0, r.text);
    const link = new URL(b.seen.links[0]);
    assert.strictEqual(link.origin + link.pathname, `${c.url}/octocheck-connect`);
    assert.ok(/^[A-Za-z0-9_-]{30,}$/.test(link.searchParams.get('state')), 'a long random state');
    assert.ok(link.searchParams.get('device'));
    assert.ok(b.seen.pages[0].body.includes('OctoCheck is connected'));
    const store = JSON.parse(fs.readFileSync(w.credFile, 'utf8'));
    assert.deepStrictEqual(store.sites['heeru-dev'].developer, {
      kind: 'connection', token: TOKEN, user: 'dev@example.com', mode: 'developer',
      saved_at: store.sites['heeru-dev'].developer.saved_at, expires_on: '2027-01-11 10:00:00',
    });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(w.cwd, 'octocheck.sites.json'), 'utf8')), { 'heeru-dev': { url: c.url } });
    assert.strictEqual(c.callsTo('get_info')[0].auth, `OctoCheck ${TOKEN}`, 'checked with the new connection before saving');
    assert.ok(r.text.includes('Connected as dev@example.com (developer mode)'), r.text);
    assert.ok(r.text.includes('Next: /octocheck-init --site heeru-dev'), r.text);
    assert.ok(!r.text.includes(TOKEN), 'the token is never printed');
    await c.close();
    w.cleanup();
  }],
  ['the saved connection is used by check, list and fetch like a key', async () => {
    const c = await startConnector({ accounts: ACCOUNTS, connectorVersion: '0.1.1' });
    const w = makeWorld();
    assert.strictEqual((await connect(w, c, browser(approve), ['--site', 's1'])).code, 0);
    const io = makeIo({ tty: false });
    const ctx = { io, cwd: w.cwd, env: w.env, home: w.home };
    assert.strictEqual(await site.main(['check', '--site', 's1'], ctx), 0, io.text());
    assert.ok(io.text().includes('Connected in the browser on'), io.text());
    assert.ok(io.text().includes('expires on 2027-01-11'), io.text());
    assert.strictEqual(await site.main(['list'], ctx), 0);
    assert.ok(io.text().includes('developer: connected in the browser'), io.text());
    assert.ok(!io.text().includes(TOKEN));
    assert.ok(c.callsTo('get_info').every((x) => x.auth === `OctoCheck ${TOKEN}`));
    await c.close();
    w.cleanup();
  }],
  ['without --site, a name comes from the address, or the existing name for the same address', async () => {
    assert.strictEqual(site.suggestSiteName('https://deverp.heerugroup.in'), 'deverp-heerugroup');
    assert.strictEqual(site.suggestSiteName('https://erp.example.com'), 'erp-example');
    assert.strictEqual(site.suggestSiteName('http://octocheck-test.localhost:88'), 'octocheck-test-localhost-88');
    assert.strictEqual(site.suggestSiteName('http://127.0.0.1:8000'), '127-0-0-1-8000');
    const c = await startConnector({ accounts: ACCOUNTS, connectorVersion: '0.1.1' });
    const w = makeWorld();
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ 'my-erp': { url: c.url } }));
    const r = await connect(w, c, browser(approve));
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.text.includes('as site "my-erp"'), r.text);
    await c.close();
    w.cleanup();
  }],
  ['Deny saves nothing; an answer with the wrong state is ignored and the real one still counts', async () => {
    const c = await startConnector({ accounts: ACCOUNTS });
    const w = makeWorld();
    let r = await connect(w, c, browser((state) => [{ state, error: 'denied' }]));
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('You chose Deny in the browser, so nothing was saved.'), r.text);
    assert.ok(!fs.existsSync(w.credFile));
    const b = browser((state) => [{ state: `${state.slice(0, -1)}x`, token: 'evil-token-aaaaaaaaaaaaaaaaaaaa' }, ...approve(state)]);
    r = await connect(w, c, b, ['--site', 's2']);
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(b.seen.pages[0].status, 400);
    assert.strictEqual(JSON.parse(fs.readFileSync(w.credFile, 'utf8')).sites.s2.developer.token, TOKEN);
    await c.close();
    w.cleanup();
  }],
  ['a connection the site does not accept is never saved, and the token stays hidden', async () => {
    const c = await startConnector({ accounts: { 'goodkey1234:goodsecret99': { user: 'x', mode: 'developer' } } });
    const w = makeWorld();
    const r = await connect(w, c, browser(approve));
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes("The site no longer accepts this computer's connection (401)"), r.text);
    assert.ok(r.text.includes('Nothing was saved.'), r.text);
    assert.ok(!r.text.includes(TOKEN));
    assert.ok(!fs.existsSync(w.credFile));
    await c.close();
    w.cleanup();
  }],
  ['no click within the time limit: nothing saved, and the link was printed for a browser that did not open', async () => {
    const c = await startConnector({ accounts: ACCOUNTS });
    const w = makeWorld();
    const r = await connect(w, c, { open: () => {} }, [], { connectTimeoutMs: 200 });
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('If the browser does not open, open this link yourself:'), r.text);
    assert.ok(r.text.includes('No answer from the browser within'), r.text);
    assert.ok(!fs.existsSync(w.credFile));
    await c.close();
    w.cleanup();
  }],
  ['connect refuses without the credentials guard, registers it, and asks for a restart', async () => {
    const c = await startConnector({ accounts: ACCOUNTS });
    const w = makeWorld({ withHook: false });
    fs.copyFileSync(path.join(__dirname, '..', '.claude', 'settings.hooks.json'), path.join(w.cwd, '.claude', 'settings.hooks.json'));
    const b = browser(approve);
    const r = await connect(w, c, b);
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('it has now been added to .claude/settings.json'), r.text);
    assert.ok(r.text.includes('exit Claude Code, start it again'), r.text);
    assert.strictEqual(b.seen.links.length, 0, 'the browser is not opened');
    assert.ok(fs.readFileSync(path.join(w.cwd, '.claude', 'settings.json'), 'utf8').includes('block-credentials-read.cjs'));
    await c.close();
    w.cleanup();
  }],
  ['a different address for an existing site name is refused', async () => {
    const c = await startConnector({ accounts: ACCOUNTS });
    const w = makeWorld();
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ prod: { url: 'https://erp.example.com' } }));
    const r = await connect(w, c, browser(approve), ['--site', 'prod']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('already has a different address for "prod"'), r.text);
    await c.close();
    w.cleanup();
  }],
  ['the header and the masking for connections', () => {
    assert.strictEqual(site.authHeader(site.CONNECTION_KEY, 'abc'), 'OctoCheck abc');
    assert.strictEqual(site.authHeader('k', 's'), 'token k:s');
    assert.ok(!site.mask(`sent OctoCheck ${TOKEN} to the site`).includes(TOKEN));
  }],
  ['/octocheck-connect never reads credentials and waits long enough for the click', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '.claude', 'commands', 'octocheck-connect.md'), 'utf8');
    assert.ok(/allowed-tools: Bash\(node \.claude\/scripts\/octocheck-site\.cjs connect:\*\)/.test(text));
    assert.ok(!/allowed-tools:.*\bRead\b/.test(text), 'no Read tool');
    assert.ok(text.includes('Bash timeout of 600000 ms'));
    assert.ok(text.includes('never try to read, print'));
  }],
];
