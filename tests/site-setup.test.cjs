'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const site = require('../.claude/scripts/octocheck-site.cjs');
const { startConnector, makeWorld, makeIo, FakeStdin } = require('./helpers.cjs');

const KEY = 'goodkey1234';
const SECRET = 'goodsecret99';
const BOT = { key: 'botkey5678', secret: 'botsecret77' };

const setupArgs = (url, extra = []) => ['setup', '--site', 'test-site', '--url', url, ...extra];
const noSecretShown = (r, ...secrets) => secrets.forEach((s) => assert.ok(!r.io.text().includes(s), `a secret was printed: ${s}`));

module.exports = [
  ['setup saves the key, creates sites.json and shows no secret', async () => {
    const c = await startConnector();
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 0, io.text());
    const store = JSON.parse(fs.readFileSync(w.credFile, 'utf8'));
    assert.strictEqual(store.sites['test-site'].developer.key, KEY);
    assert.strictEqual(store.sites['test-site'].developer.secret, SECRET);
    assert.strictEqual(store.sites['test-site'].developer.user, 'dev@example.com');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(w.cwd, 'octocheck.sites.json'), 'utf8')), { 'test-site': { url: c.url } });
    assert.ok(!fs.readFileSync(path.join(w.cwd, 'octocheck.sites.json'), 'utf8').includes(SECRET));
    assert.ok(io.text().includes('Connected as dev@example.com (developer mode)'));
    assert.ok(io.text().includes('8 scripts visible'));
    assert.ok(!io.text().includes(SECRET) && !io.text().includes(KEY));
    assert.strictEqual(c.calls.length, 1);
    assert.strictEqual(c.calls[0].auth, `token ${KEY}:${SECRET}`);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(w.credFile).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(w.credDir).mode & 0o777, 0o700);
    }
    await c.close();
    w.cleanup();
  }],

  ['a wrong secret saves nothing', async () => {
    const c = await startConnector();
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, 'wrongsecret1'] });
    const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('rejected this key and secret (401)'));
    assert.ok(!fs.existsSync(w.credFile), 'credentials were written');
    assert.ok(!fs.existsSync(path.join(w.cwd, 'octocheck.sites.json')), 'sites.json was written');
    assert.ok(!io.text().includes('wrongsecret1'));
    await c.close();
    w.cleanup();
  }],

  ['a switched-off connector is explained and saves nothing', async () => {
    const c = await startConnector({ disabled: true });
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('switched off'));
    assert.ok(!fs.existsSync(w.credFile));
    await c.close();
    w.cleanup();
  }],

  ['connector errors map to clear messages', async () => {
    const cases = [
      [{ status: 404 }, 'not found'],
      [{ status: 429 }, 'rate limiting'],
      [{ status: 500, body: { exception: 'frappe.exceptions.ValidationError: boom happened' } }, 'boom happened'],
      [{ bundleVersion: 2 }, 'bundle version 2'],
      [{ status: 200, body: { message: 'hello' } }, 'did not look like the OctoCheck connector'],
    ];
    for (const [options, expected] of cases) {
      const c = await startConnector({ accounts: { [`${KEY}:${SECRET}`]: { user: 'a@b.c', mode: 'developer' } }, ...options });
      const w = makeWorld();
      const io = makeIo({ hidden: [KEY, SECRET] });
      const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
      assert.strictEqual(code, 1, expected);
      assert.ok(io.text().includes(expected), `expected "${expected}" in: ${io.text()}`);
      assert.ok(!fs.existsSync(w.credFile));
      await c.close();
      w.cleanup();
    }
  }],

  ['a redirect is refused, never followed', async () => {
    const target = await startConnector();
    const c = await startConnector({ redirectTo: `${target.url}/api/method/octocheck_connector.api.get_info` });
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('redirected'));
    assert.strictEqual(target.calls.length, 0, 'the redirect was followed and the secret sent on');
    await c.close();
    await target.close();
    w.cleanup();
  }],

  ['nothing listening gives a helpful message', async () => {
    const c = await startConnector();
    const url = c.url;
    await c.close();
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    const code = await site.main(setupArgs(url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('Nothing is listening'));
    w.cleanup();
  }],

  ['the bot profile must get reviewer mode', async () => {
    const c = await startConnector({ accounts: { [`${BOT.key}:${BOT.secret}`]: { user: 'admin@example.com', mode: 'developer' } } });
    const w = makeWorld();
    const io = makeIo({ hidden: [BOT.key, BOT.secret] });
    const code = await site.main(setupArgs(c.url, ['--profile', 'bot']), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('ONLY the OctoCheck Reviewer role'));
    assert.ok(!fs.existsSync(w.credFile));
    await c.close();
    w.cleanup();
  }],

  ['a bot key with reviewer mode is saved under the bot profile', async () => {
    const c = await startConnector({ accounts: { [`${BOT.key}:${BOT.secret}`]: { user: 'bot@example.com', mode: 'reviewer' } } });
    const w = makeWorld();
    const io = makeIo({ hidden: [BOT.key, BOT.secret] });
    const code = await site.main(setupArgs(c.url, ['--profile', 'bot']), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 0, io.text());
    const store = JSON.parse(fs.readFileSync(w.credFile, 'utf8'));
    assert.strictEqual(store.sites['test-site'].bot.mode, 'reviewer');
    assert.strictEqual(store.sites['test-site'].developer, undefined);
    await c.close();
    w.cleanup();
  }],

  ['a second profile keeps the first one', async () => {
    const c = await startConnector({
      accounts: {
        [`${KEY}:${SECRET}`]: { user: 'dev@example.com', mode: 'developer' },
        [`${BOT.key}:${BOT.secret}`]: { user: 'bot@example.com', mode: 'reviewer' },
      },
    });
    const w = makeWorld();
    let io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home }), 0);
    io = makeIo({ hidden: [BOT.key, BOT.secret] });
    assert.strictEqual(await site.main(['setup', '--site', 'test-site', '--profile', 'bot'], { io, cwd: w.cwd, env: w.env, home: w.home }), 0, io.text());
    const store = JSON.parse(fs.readFileSync(w.credFile, 'utf8'));
    assert.ok(store.sites['test-site'].developer && store.sites['test-site'].bot);
    assert.ok(!io.asked.some((q) => /address/i.test(q)), 'it asked for the address again');
    await c.close();
    w.cleanup();
  }],

  ['setup refuses to run without a terminal', async () => {
    const c = await startConnector();
    const w = makeWorld();
    const io = makeIo({ tty: false, hidden: [KEY, SECRET] });
    const code = await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('Run this in a terminal'));
    assert.strictEqual(io.asked.length, 0);
    assert.strictEqual(c.calls.length, 0);
    await c.close();
    w.cleanup();
  }],

  ['setup refuses when the credentials guard hook is not registered', async () => {
    const c = await startConnector();
    const w = makeWorld({ withHook: false });
    let io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('credentials guard is not registered'));
    assert.ok(!fs.existsSync(w.credFile));
    io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(setupArgs(c.url, ['--skip-hook-check']), { io, cwd: w.cwd, env: w.env, home: w.home }), 0, io.text());
    await c.close();
    w.cleanup();
  }],

  ['a secret is never sent over plain http to a public host', async () => {
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    let sent = 0;
    const spy = async () => { sent += 1; throw new Error('should not be called'); };
    const code = await site.main(setupArgs('http://erp.example.com'), { io, cwd: w.cwd, env: w.env, home: w.home, httpGet: spy });
    assert.strictEqual(code, 1);
    assert.ok(io.text().includes('Refusing to send an API secret over plain http'));
    assert.strictEqual(sent, 0);
    assert.strictEqual(io.asked.length, 0, 'it asked for the secret before checking the address');
    w.cleanup();
  }],

  ['address checks', async () => {
    assert.strictEqual(site.checkUrl('https://erp.example.com/some/path?x=1').origin, 'https://erp.example.com');
    assert.strictEqual(site.checkUrl('http://localhost:88').origin, 'http://localhost:88');
    for (const ok of ['http://172.18.130.194:88', 'http://10.1.2.3', 'http://192.168.0.5', 'http://foo.localhost:8000', 'http://127.0.0.1']) {
      assert.ok(site.checkUrl(ok).note, ok);
    }
    for (const bad of ['http://172.32.0.1', 'http://8.8.8.8', 'http://erp.example.com']) {
      assert.throws(() => site.checkUrl(bad), /Refusing/, bad);
    }
    assert.ok(site.checkUrl('http://erp.example.com', true).note.includes('unencrypted'));
    assert.throws(() => site.checkUrl('ftp://x.y'), /http/);
    assert.throws(() => site.checkUrl('localhost:88'), /http/);
    assert.throws(() => site.checkUrl('https://user:pw@erp.example.com'), /user name or password/);
    assert.throws(() => site.checkUrl('not a url'), /not a valid address/);
  }],

  ['bad input is rejected before anything is asked', async () => {
    const w = makeWorld();
    for (const args of [['setup'], ['setup', '--site', '../evil'], ['setup', '--site', 'a b'], ['setup', '--site', 'ok', '--profile', 'root'], ['setup', '--bogus'], ['nope']]) {
      const io = makeIo({ hidden: [KEY, SECRET] });
      assert.strictEqual(await site.main(args, { io, cwd: w.cwd, env: w.env, home: w.home }), 1, args.join(' '));
      assert.strictEqual(io.asked.length, 0, args.join(' '));
    }
    w.cleanup();
  }],

  ['a pasted value with spaces or a colon is rejected without a network call', async () => {
    const w = makeWorld();
    for (const hidden of [['a b', 'secret1234'], ['key:with:colon', 'secret1234'], ['', 'secret1234'], [KEY, '']]) {
      const io = makeIo({ hidden });
      let sent = 0;
      const code = await site.main(setupArgs('http://localhost:88'), { io, cwd: w.cwd, env: w.env, home: w.home, httpGet: async () => { sent += 1; } });
      assert.strictEqual(code, 1);
      assert.strictEqual(sent, 0);
    }
    w.cleanup();
  }],

  ['setup on an existing profile points to rotate', async () => {
    const c = await startConnector();
    const w = makeWorld();
    assert.strictEqual(await site.main(setupArgs(c.url), { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home }), 0);
    const io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('rotate --site test-site'));
    assert.strictEqual(io.asked.length, 0);
    await c.close();
    w.cleanup();
  }],

  ['rotate replaces the key only after the new one works', async () => {
    const c = await startConnector({
      accounts: {
        [`${KEY}:${SECRET}`]: { user: 'dev@example.com', mode: 'developer' },
        [`${KEY}:newsecret55`]: { user: 'dev@example.com', mode: 'developer' },
      },
    });
    const w = makeWorld();
    assert.strictEqual(await site.main(setupArgs(c.url), { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home }), 0);

    // 1. a bad new secret leaves the old one in place
    let io = makeIo({ hidden: [KEY, 'typo-secret'] });
    assert.strictEqual(await site.main(['rotate', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(w.credFile, 'utf8')).sites['test-site'].developer.secret, SECRET);

    // 2. the same secret is "nothing to rotate", with no network call
    const before = c.calls.length;
    io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(['rotate', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('nothing to rotate'));
    assert.strictEqual(c.calls.length, before);

    // 3. a new secret on the same key (what Desk's Generate Keys does) is accepted
    io = makeIo({ hidden: [KEY, 'newsecret55'] });
    assert.strictEqual(await site.main(['rotate', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home }), 0, io.text());
    assert.strictEqual(JSON.parse(fs.readFileSync(w.credFile, 'utf8')).sites['test-site'].developer.secret, 'newsecret55');
    assert.ok(io.text().includes('Replaced'));
    assert.ok(!io.text().includes('newsecret55'));
    await c.close();
    w.cleanup();
  }],

  ['rotate without a saved key explains itself', async () => {
    const w = makeWorld();
    const io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(['rotate', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('Run setup first'));
    w.cleanup();
  }],

  ['check uses the saved key and warns when it is old', async () => {
    const c = await startConnector();
    const w = makeWorld();
    const base = new Date('2026-01-01T00:00:00Z');
    assert.strictEqual(await site.main(setupArgs(c.url), { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home, now: () => base }), 0);
    let io = makeIo();
    assert.strictEqual(await site.main(['check', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home, now: () => new Date('2026-01-10T00:00:00Z') }), 0, io.text());
    assert.ok(io.text().includes('Connected as dev@example.com'));
    assert.ok(!io.text().includes('Consider rotating'));
    io = makeIo();
    assert.strictEqual(await site.main(['check', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home, now: () => new Date('2026-06-01T00:00:00Z') }), 0);
    assert.ok(io.text().includes('Consider rotating'));
    assert.ok(!io.text().includes(SECRET));
    await c.close();
    w.cleanup();
  }],

  ['check without credentials says how to set up, and never echoes a secret on failure', async () => {
    const c = await startConnector();
    const w = makeWorld();
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ 'test-site': { url: c.url } }));
    let io = makeIo();
    assert.strictEqual(await site.main(['check', '--site', 'test-site'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('setup --site test-site'));
    // saved key later revoked on the site
    assert.strictEqual(await site.main(['setup', '--site', 'other', '--url', c.url], { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home }), 0);
    const store = JSON.parse(fs.readFileSync(w.credFile, 'utf8'));
    store.sites.other.developer.secret = 'revokedsecret1';
    fs.writeFileSync(w.credFile, JSON.stringify(store));
    io = makeIo();
    assert.strictEqual(await site.main(['check', '--site', 'other'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('rejected'));
    noSecretShown({ io }, 'revokedsecret1', KEY);
    await c.close();
    w.cleanup();
  }],

  ['list shows sites and profiles but never a key or secret', async () => {
    const c = await startConnector();
    const w = makeWorld();
    assert.strictEqual(await site.main(setupArgs(c.url), { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home }), 0);
    const io = makeIo();
    assert.strictEqual(await site.main(['list'], { io, cwd: w.cwd, env: w.env, home: w.home }), 0);
    assert.ok(io.text().includes('test-site'));
    assert.ok(io.text().includes('developer: saved'));
    assert.ok(io.text().includes('bot: no key saved'));
    noSecretShown({ io }, SECRET, KEY);
    await c.close();
    w.cleanup();
  }],

  ['a conflicting address in sites.json is not silently overwritten', async () => {
    const c = await startConnector();
    const w = makeWorld();
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ 'test-site': { url: 'http://localhost:9999' } }));
    const io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(setupArgs(c.url), { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('different address'));
    await c.close();
    w.cleanup();
  }],

  ['damaged sites.json and credentials files give clear errors', async () => {
    const w = makeWorld();
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), '{not json');
    let io = makeIo({ hidden: [KEY, SECRET] });
    assert.strictEqual(await site.main(['list'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('not valid JSON'));
    fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ x: { nourl: 1 } }));
    io = makeIo();
    assert.strictEqual(await site.main(['list'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('needs a "url"'));
    fs.unlinkSync(path.join(w.cwd, 'octocheck.sites.json'));
    fs.mkdirSync(w.credDir, { recursive: true });
    fs.writeFileSync(w.credFile, 'garbage');
    io = makeIo();
    assert.strictEqual(await site.main(['list'], { io, cwd: w.cwd, env: w.env, home: w.home }), 1);
    assert.ok(io.text().includes('damaged'));
    w.cleanup();
  }],

  ['saved credentials load for the fetch step, with a helpful error when missing', async () => {
    const c = await startConnector();
    const w = makeWorld();
    assert.throws(() => site.loadCredentials('test-site', 'developer', w.env, w.home), /setup --site test-site/);
    assert.throws(() => site.loadCredentials('test-site', 'bot', w.env, w.home), /--profile bot/);
    assert.strictEqual(await site.main(setupArgs(c.url), { io: makeIo({ hidden: [KEY, SECRET] }), cwd: w.cwd, env: w.env, home: w.home }), 0);
    const creds = site.loadCredentials('test-site', 'developer', w.env, w.home);
    assert.deepStrictEqual([creds.key, creds.secret], [KEY, SECRET]);
    await c.close();
    w.cleanup();
  }],

  ['credentials are refused on a Windows drive under WSL, warned about on Windows', async () => {
    assert.throws(() => site.checkStoragePlace('/mnt/d/octocheck', 'linux'), /Windows drive/);
    assert.throws(() => site.checkStoragePlace('/mnt/c/Users/x', 'linux'), /Windows drive/);
    assert.deepStrictEqual(site.checkStoragePlace('/home/sanket/.config/octocheck', 'linux'), []);
    assert.deepStrictEqual(site.checkStoragePlace('/mnt/data/x', 'linux'), []);
    assert.strictEqual(site.checkStoragePlace('C:\\x', 'win32').length, 1);
  }],

  ['mask hides secrets and token headers', async () => {
    assert.strictEqual(site.mask('failed with abcd1234secret in it', ['abcd1234secret']), 'failed with •••• in it');
    assert.strictEqual(site.mask('Authorization: token k:s failed'), 'Authorization: token •••• failed');
    assert.strictEqual(site.mask('short', ['ab']), 'short');
  }],

  ['serverMessage reads Frappe error bodies', async () => {
    assert.strictEqual(site.serverMessage(JSON.stringify({ _server_messages: JSON.stringify([JSON.stringify({ message: 'Hello <b>there</b>' })]) })), 'Hello there');
    assert.strictEqual(site.serverMessage(JSON.stringify({ exception: 'frappe.exceptions.PermissionError: nope' })), 'nope');
    assert.strictEqual(site.serverMessage('<html>oops</html>'), '');
  }],

  ['the hidden prompt never echoes, handles backspace, paste, arrows and Ctrl+C', async () => {
    const out = [];
    const stdout = { write: (s) => out.push(s) };

    let stdin = new FakeStdin();
    let p = site.promptHidden('Secret: ', stdin, stdout);
    assert.ok(stdin.raw && !stdin.paused);
    stdin.emit('data', 'abc');
    stdin.emit('data', '\u007f');
    stdin.emit('data', 'd\r');
    assert.strictEqual(await p, 'abd');
    assert.ok(!stdin.raw && stdin.paused, 'terminal was not restored');
    assert.strictEqual(out.join(''), 'Secret: \n', 'typed characters were echoed');
    assert.strictEqual(stdin.listenerCount('data'), 0);

    out.length = 0;
    stdin = new FakeStdin();
    p = site.promptHidden('S: ', stdin, stdout);
    stdin.emit('data', 'pasted-value-123\n');
    assert.strictEqual(await p, 'pasted-value-123');

    stdin = new FakeStdin();
    p = site.promptHidden('S: ', stdin, stdout);
    stdin.emit('data', 'ab\u001b[Acd\r');
    assert.strictEqual(await p, 'abcd', 'an arrow key leaked into the value');

    stdin = new FakeStdin();
    p = site.promptHidden('S: ', stdin, stdout);
    stdin.emit('data', 'abc\u0003');
    await assert.rejects(p, /Cancelled/);
    assert.ok(!stdin.raw, 'terminal was not restored after Ctrl+C');

    stdin = new FakeStdin();
    stdin.isTTY = false;
    await assert.rejects(site.promptHidden('S: ', stdin, stdout), /real terminal/);
  }],

  ['no command prints usage', async () => {
    const io = makeIo();
    assert.strictEqual(await site.main([], { io }), 2);
    assert.ok(io.text().includes('setup  --site'));
    const io2 = makeIo();
    assert.strictEqual(await site.main(['--help'], { io: io2 }), 0);
  }],
];
