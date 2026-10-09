#!/usr/bin/env node
'use strict';
// OctoCheck site script: the only thing that talks to a Frappe site's octocheck_connector.
//
// Why a plain script and not Claude running curl: the API secret is read from a file by
// this process and never appears in the conversation, in a prompt, or in a report. Claude
// only ever sees the short summaries this script prints.
//
//   node .claude/scripts/octocheck-site.cjs setup  --site <name> [--profile developer|bot]
//   node .claude/scripts/octocheck-site.cjs rotate --site <name> [--profile developer|bot]
//   node .claude/scripts/octocheck-site.cjs check  --site <name> [--profile developer|bot]
//   node .claude/scripts/octocheck-site.cjs list
//   node .claude/scripts/octocheck-site.cjs fetch  --site <name> [--profile developer|bot] [--blast-radius <n|off>]
//
// `setup` and `rotate` ask for the key and secret with a hidden prompt, so run them in a
// normal terminal, NOT inside Claude Code. No dependencies; works on Node 16 and later.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const SUPPORTED_BUNDLE_VERSION = 1;
const API_PREFIX = '/api/method/octocheck_connector.api.';
const CRED_FILE = 'octocheck-credentials.json';
const SITES_FILE = 'octocheck.sites.json';
const CREDENTIAL_GUARD_HOOK = 'block-credentials-read.cjs';
const PROFILES = ['developer', 'bot'];
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const KEY_MAX_AGE_DAYS = 90;
const USER_AGENT = 'octocheck-site/0.1';

class UserError extends Error {}

// --- small helpers ---------------------------------------------------------

/** Replace every secret value, and any "token a:b" header text, with dots. */
function mask(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('••••');
  }
  return out.replace(/token\s+\S+/gi, 'token ••••');
}

function credentialsDir(env, home) {
  return path.resolve(env.OCTOCHECK_CREDENTIALS_DIR || path.join(home, '.config', 'octocheck'));
}

function isLocalHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Validate an address and return {origin, note}. Refuses to send a secret over plain http
 *  to a public host. */
function checkUrl(input, allowInsecureHttp) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch (e) {
    throw new UserError('That is not a valid address. Write it like http://localhost:88 or https://erp.example.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UserError('The address must start with http:// or https://');
  }
  if (u.username || u.password) {
    throw new UserError('Do not put a user name or password in the address. They are asked for separately.');
  }
  let note = null;
  if (u.protocol === 'http:') {
    if (!isLocalHost(u.hostname)) {
      if (!allowInsecureHttp) {
        throw new UserError(
          `Refusing to send an API secret over plain http to ${u.hostname}. Use https, or pass ` +
          '--allow-insecure-http if you really must.'
        );
      }
      note = `Warning: ${u.hostname} is reached over plain http, so the secret travels unencrypted.`;
    } else {
      note = 'Note: this address uses plain http on a local or private network.';
    }
  }
  return { origin: u.origin, note };
}

function validSiteName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

// --- talking to the connector ---------------------------------------------

function httpGet(urlString, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('The response was too large.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Best readable message from a Frappe error body. */
function serverMessage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return '';
  }
  let text = '';
  if (typeof parsed._server_messages === 'string') {
    try {
      const list = JSON.parse(parsed._server_messages);
      text = list.map((m) => { try { return JSON.parse(m).message; } catch (e) { return String(m); } }).join(' ');
    } catch (e) { /* fall through */ }
  }
  if (!text && typeof parsed.exception === 'string') text = parsed.exception.replace(/^[\w.]+:\s*/, '');
  if (!text && typeof parsed.message === 'string') text = parsed.message;
  return text.replace(/<[^>]*>/g, '').trim().slice(0, 300);
}

function networkMessage(e, origin) {
  const code = e && e.code;
  if (code === 'ECONNREFUSED') return `Nothing is listening at ${origin}. Is the bench running, and is the port right?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find the host in ${origin}. Check the spelling and your network.`;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return `No answer from ${origin} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`;
  if (/CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE/i.test(String(code))) {
    return `The certificate of ${origin} could not be verified (${code}). Certificate checking is never switched off.`;
  }
  return `Could not reach ${origin}: ${e && e.message ? e.message : 'unknown error'}`;
}

/** Call one connector endpoint and return the `message` part of the answer, or throw a
 *  UserError that says what to do. `query` becomes URL parameters. With opts.retries, a 429
 *  waits and tries again (used by fetch, which makes many calls; setup never waits). */
async function callEndpoint(origin, endpoint, query, key, secret, opts = {}) {
  const doGet = opts.httpGet || httpGet;
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let url = `${origin}${API_PREFIX}${endpoint}`;
  const params = new URLSearchParams(query || {}).toString();
  if (params) url += `?${params}`;
  const headers = { Authorization: `token ${key}:${secret}`, Accept: 'application/json', 'User-Agent': USER_AGENT };

  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await doGet(url, headers, timeoutMs);
    } catch (e) {
      throw new UserError(networkMessage(e, origin));
    }
    if (res.status === 429 && attempt < (opts.retries || 0)) {
      const header = Number(res.headers && res.headers['retry-after']);
      const seconds = Number.isFinite(header) && header > 0 && header <= 120 ? header : 61;
      if (opts.onWait) opts.onWait(seconds);
      await sleep(seconds * 1000);
      continue;
    }
    return interpret(res, origin);
  }
}

function interpret(res, origin) {
  const detail = serverMessage(res.body);
  if (res.status >= 300 && res.status < 400) {
    // Never follow a redirect: it could carry the secret to another host.
    throw new UserError(
      `${origin} redirected the request (${res.status}) to ${(res.headers && res.headers.location) || 'another address'}. ` +
      'Use the final address instead, for example https:// instead of http://.'
    );
  }
  if (res.status === 401) throw new UserError('The site rejected this key and secret (401). Nothing was saved.');
  if (res.status === 403) {
    if (/disabled/i.test(detail)) {
      throw new UserError('The connector is switched off on that site. Tick "Enable connector" in OctoCheck Settings.');
    }
    throw new UserError(
      'This user is not allowed to use the connector (403). It needs System Manager, or only the ' +
      `OctoCheck Reviewer role for the bot.${detail ? ` Site said: ${detail}` : ''}`
    );
  }
  if (res.status === 404) {
    throw new UserError('The connector endpoint was not found. Is octocheck_connector installed on that site, and is the address right?');
  }
  if (res.status === 429) throw new UserError('The site is rate limiting this key (429). Wait a minute and try again.');
  if (res.status !== 200) {
    throw new UserError(`The site answered with an error (${res.status}).${detail ? ` ${detail}` : ''}`);
  }
  let message;
  try {
    message = JSON.parse(res.body).message;
  } catch (e) {
    message = undefined;
  }
  if (!message || typeof message !== 'object') {
    throw new UserError('The answer did not look like the OctoCheck connector. Is this the right site?');
  }
  return message;
}

/** Call get_info and return its payload, or throw a UserError that says what to do. */
async function getInfo(origin, key, secret, httpGetFn = httpGet, opts = {}) {
  const info = await callEndpoint(origin, 'get_info', {}, key, secret, { ...opts, httpGet: httpGetFn });
  if (!('bundle_version' in info) || !('access_mode' in info) || !info.user) {
    throw new UserError('The answer did not look like the OctoCheck connector. Is this the right site?');
  }
  if (info.bundle_version !== SUPPORTED_BUNDLE_VERSION) {
    throw new UserError(
      `The connector speaks bundle version ${info.bundle_version}; this OctoCheck understands version ` +
      `${SUPPORTED_BUNDLE_VERSION}. Update whichever side is older.`
    );
  }
  return info;
}

// --- stores: credentials (outside the repo) and sites (in the repo) --------

function checkStoragePlace(dir, platform = process.platform) {
  const warnings = [];
  if (platform === 'linux' && /^\/mnt\/[a-z](\/|$)/i.test(dir)) {
    throw new UserError(
      `${dir} is on a Windows drive, where file permissions are not enforced, so anyone on this ` +
      'machine could read the secret. Use a folder under your Linux home (the default), not /mnt/.'
    );
  }
  if (platform === 'win32') {
    warnings.push('Warning: on Windows, file permissions are not enforced. Prefer running this inside WSL.');
  }
  return warnings;
}

function readStore(dir) {
  const file = path.join(dir, CRED_FILE);
  if (!fs.existsSync(file)) return { version: 1, sites: {} };
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(`${file} is damaged and could not be read. Fix or delete it, then run setup again.`);
  }
  if (!store || typeof store !== 'object' || typeof store.sites !== 'object' || store.sites === null) {
    throw new UserError(`${file} does not have the expected layout. Fix or delete it, then run setup again.`);
  }
  return store;
}

function writeStore(dir, store) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* not supported here */ }
  const file = path.join(dir, CRED_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  try { fs.chmodSync(file, 0o600); } catch (e) { /* not supported here */ }
  return file;
}

function readSites(cwd) {
  const file = path.join(cwd, SITES_FILE);
  if (!fs.existsSync(file)) return {};
  let sites;
  try {
    sites = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(`${SITES_FILE} is not valid JSON. Fix it, or delete it and run setup again.`);
  }
  if (!sites || typeof sites !== 'object' || Array.isArray(sites)) {
    throw new UserError(`${SITES_FILE} must be an object like {"my-site": {"url": "http://localhost:88"}}.`);
  }
  for (const [name, entry] of Object.entries(sites)) {
    if (!entry || typeof entry.url !== 'string') throw new UserError(`${SITES_FILE}: site "${name}" needs a "url".`);
  }
  return sites;
}

function writeSites(cwd, sites) {
  fs.writeFileSync(path.join(cwd, SITES_FILE), JSON.stringify(sites, null, 2) + '\n');
}

function hookRegistered(cwd, home) {
  const files = [
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  return files.some((f) => {
    try { return fs.readFileSync(f, 'utf8').includes(CREDENTIAL_GUARD_HOOK); } catch (e) { return false; }
  });
}

/** For the fetch step: credentials for one site and profile, or an error that says how to fix it. */
function loadCredentials(site, profile, env = process.env, home = os.homedir()) {
  const entry = (readStore(credentialsDir(env, home)).sites[site] || {})[profile];
  if (!entry || !entry.key || !entry.secret) {
    throw new UserError(
      `No ${profile} credentials saved for "${site}". In a terminal, run: ` +
      `node .claude/scripts/octocheck-site.cjs setup --site ${site}${profile === 'developer' ? '' : ` --profile ${profile}`}`
    );
  }
  return entry;
}

// --- prompts ---------------------------------------------------------------

/** Read a line from a terminal without echoing it (not even stars). */
function promptHidden(label, stdin, stdout) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new UserError('A hidden prompt needs a real terminal.'));
      return;
    }
    let value = '';
    let inEscape = false;
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (fn, arg) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      fn(arg);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (inEscape) {
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        if (ch === '\u001b') { inEscape = true; continue; }
        if (ch === '\r' || ch === '\n') return finish(resolve, value);
        if (ch === '\u0003' || ch === '\u0004') return finish(reject, new UserError('Cancelled. Nothing was saved.'));
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    }
    stdin.on('data', onData);
  });
}

function promptVisible(label, stdin, stdout) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(label, (answer) => { rl.close(); resolve(answer); });
  });
}

function realIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    askVisible: (label) => promptVisible(label, process.stdin, process.stdout),
    askHidden: (label) => promptHidden(label, process.stdin, process.stdout),
  };
}

// --- commands --------------------------------------------------------------

function describe(info) {
  const counts = info.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', ');
  return `Connected as ${info.user} (${info.access_mode} mode). Frappe ${info.frappe_version || '?'}, ` +
    `connector ${info.connector_version || '?'}. ${total} script${total === 1 ? '' : 's'} visible${parts ? ` (${parts})` : ''}.`;
}

function checkProfileName(profile) {
  if (!PROFILES.includes(profile)) throw new UserError(`--profile must be one of: ${PROFILES.join(', ')}`);
}

function checkSiteName(site) {
  if (!site) throw new UserError('Add --site <name>, for example --site octocheck-test');
  if (!validSiteName(site)) {
    throw new UserError('The site name may only use letters, digits, dots, dashes and underscores, and must start with a letter or digit.');
  }
}

async function runSetup(kind, flags, ctx) {
  const { io, cwd, env, home } = ctx;
  const doGet = ctx.httpGet || httpGet;
  const site = flags.site;
  const profile = flags.profile || 'developer';
  checkSiteName(site);
  checkProfileName(profile);

  if (!io.isTTY) {
    throw new UserError('Run this in a terminal, not inside Claude Code or a script: the key and secret are typed at a hidden prompt, so they never appear in a conversation.');
  }
  if (!flags['skip-hook-check'] && !hookRegistered(cwd, home)) {
    throw new UserError(
      `The credentials guard is not registered. Merge .claude/settings.hooks.json into .claude/settings.json ` +
      `(the entry that runs ${CREDENTIAL_GUARD_HOOK}), then run this again. Without it, Claude could read the saved secret.`
    );
  }

  const dir = credentialsDir(env, home);
  for (const w of checkStoragePlace(dir, ctx.platform)) io.err(w);
  const store = readStore(dir);
  const existing = (store.sites[site] || {})[profile];
  if (kind === 'setup' && existing) {
    throw new UserError(`A ${profile} key is already saved for "${site}". To replace it, run: rotate --site ${site}${profile === 'developer' ? '' : ` --profile ${profile}`}`);
  }
  if (kind === 'rotate' && !existing) {
    throw new UserError(`No ${profile} key is saved for "${site}" yet. Run setup first.`);
  }

  // Where is the site? sites.json is the source of truth; ask only if it has no entry yet.
  const sites = readSites(cwd);
  let rawUrl = sites[site] && sites[site].url;
  if (rawUrl && flags.url && checkUrl(flags.url, true).origin !== checkUrl(rawUrl, true).origin) {
    throw new UserError(`${SITES_FILE} already has a different address for "${site}". Edit that file if the address really changed.`);
  }
  if (!rawUrl) {
    if (kind === 'rotate') throw new UserError(`"${site}" is not in ${SITES_FILE}. Add it, or run setup.`);
    rawUrl = flags.url || (await io.askVisible(`Site address for "${site}" (for example http://localhost:88): `));
  }
  const { origin, note } = checkUrl(rawUrl, flags['allow-insecure-http']);
  if (note) io.err(note);

  const key = String(await io.askHidden('API key (input hidden): ')).trim();
  const secret = String(await io.askHidden('API secret (input hidden): ')).trim();
  const secrets = [key, secret];
  if (!key || !secret || /\s/.test(key + secret) || key.includes(':')) {
    throw new UserError('That does not look like a Frappe key and secret (empty, or containing spaces or a colon). Nothing was saved.');
  }
  if (kind === 'rotate' && existing.key === key && existing.secret === secret) {
    throw new UserError('That is the same key and secret as the saved one, so there is nothing to rotate. Generate new keys in Desk first.');
  }

  // Check first, save second: a bad key never replaces a good one.
  let info;
  try {
    info = await getInfo(origin, key, secret, doGet);
  } catch (e) {
    throw new UserError(mask(e.message, secrets));
  }
  if (profile === 'bot' && info.access_mode !== 'reviewer') {
    throw new UserError(
      `This key belongs to ${info.user}, which got ${info.access_mode} mode. The bot profile must be a user that has ` +
      'ONLY the OctoCheck Reviewer role (no System Manager). Nothing was saved.'
    );
  }

  store.sites[site] = store.sites[site] || {};
  store.sites[site][profile] = {
    key, secret, user: info.user, mode: info.access_mode, saved_at: (ctx.now ? ctx.now() : new Date()).toISOString(),
  };
  const file = writeStore(dir, store);
  if (!sites[site]) {
    sites[site] = { url: origin };
    writeSites(cwd, sites);
    io.out(`Added "${site}" to ${SITES_FILE} (it has no secrets, so it is safe to commit).`);
  }
  io.out(describe(info));
  if (profile === 'developer' && info.access_mode === 'reviewer') {
    io.out('Note: this developer key got reviewer mode, so it has no personal permissions on the site.');
  }
  io.out(
    kind === 'rotate'
      ? `Replaced the ${profile} key for "${site}". The old one is no longer saved here.`
      : `Saved the ${profile} key for "${site}" in ${file} (only you can read it).`
  );
  io.out(`Check it any time with: node .claude/scripts/octocheck-site.cjs check --site ${site}${profile === 'developer' ? '' : ` --profile ${profile}`}`);
}

async function runCheck(flags, ctx) {
  const { io, cwd, env, home } = ctx;
  const doGet = ctx.httpGet || httpGet;
  const site = flags.site;
  const profile = flags.profile || 'developer';
  checkSiteName(site);
  checkProfileName(profile);
  const sites = readSites(cwd);
  if (!sites[site]) throw new UserError(`"${site}" is not in ${SITES_FILE}. Run setup first.`);
  const { origin } = checkUrl(sites[site].url, flags['allow-insecure-http']);
  const creds = loadCredentials(site, profile, env, home);
  let info;
  try {
    info = await getInfo(origin, creds.key, creds.secret, doGet);
  } catch (e) {
    throw new UserError(mask(e.message, [creds.key, creds.secret]));
  }
  io.out(describe(info));
  const ageDays = Math.floor(((ctx.now ? ctx.now() : new Date()) - new Date(creds.saved_at)) / 86400000);
  if (Number.isFinite(ageDays) && ageDays > KEY_MAX_AGE_DAYS) {
    io.out(`This ${profile} key was saved ${ageDays} days ago. Consider rotating it: rotate --site ${site}${profile === 'developer' ? '' : ` --profile ${profile}`}`);
  }
}

function runList(ctx) {
  const { io, cwd, env, home } = ctx;
  const sites = readSites(cwd);
  const store = readStore(credentialsDir(env, home));
  const names = [...new Set([...Object.keys(sites), ...Object.keys(store.sites)])].sort();
  if (!names.length) {
    io.out('No sites yet. Run: node .claude/scripts/octocheck-site.cjs setup --site <name>');
    return;
  }
  for (const name of names) {
    io.out(`${name}  ${sites[name] ? sites[name].url : '(not in ' + SITES_FILE + ')'}`);
    const profiles = store.sites[name] || {};
    for (const p of PROFILES) {
      const c = profiles[p];
      io.out(`  ${p}: ${c ? `saved ${String(c.saved_at).slice(0, 10)} for ${c.user} (${c.mode})` : 'no key saved'}`);
    }
  }
}

// --- command line ----------------------------------------------------------

const USAGE = `OctoCheck site script

  setup  --site <name> [--profile developer|bot] [--url <address>]   first-time setup (hidden prompt)
  rotate --site <name> [--profile developer|bot]                     replace a saved key (hidden prompt)
  check  --site <name> [--profile developer|bot]                     test the saved key
  list                                                               show configured sites (no secrets)
  fetch  --site <name> [--profile developer|bot] [--blast-radius <n|off>]
                                                                     get the scripts that need review
                                                                     (see octocheck-fetch.cjs)

Run setup and rotate in a normal terminal, not inside Claude Code.`;

const FLAGS = {
  site: true, profile: true, url: true, 'blast-radius': true, 'skip-hook-check': false, 'allow-insecure-http': false, help: false,
};

function parseArgs(argv) {
  const out = { command: null, flags: {} };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('--')) out.command = rest.shift();
  while (rest.length) {
    const arg = rest.shift();
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m || !(m[1] in FLAGS)) throw new UserError(`Unknown option: ${arg}\n\n${USAGE}`);
    if (FLAGS[m[1]]) {
      const value = m[2] !== undefined ? m[2] : rest.shift();
      if (value === undefined || value.startsWith('--')) throw new UserError(`--${m[1]} needs a value.`);
      out.flags[m[1]] = value;
    } else {
      out.flags[m[1]] = true;
    }
  }
  return out;
}

async function main(argv, ctxOverrides = {}) {
  const ctx = {
    io: realIo(), cwd: process.cwd(), env: process.env, home: process.env.HOME || os.homedir(),
    platform: process.platform, ...ctxOverrides,
  };
  const { io } = ctx;
  try {
    const { command, flags } = parseArgs(argv);
    if (!command || flags.help || command === 'help') {
      io.out(USAGE);
      return command || flags.help ? 0 : 2;
    }
    if (command === 'setup' || command === 'rotate') await runSetup(command, flags, ctx);
    else if (command === 'check') await runCheck(flags, ctx);
    else if (command === 'list') runList(ctx);
    else if (command === 'fetch') await require('./octocheck-fetch.cjs').runFetch(flags, ctx);
    else throw new UserError(`Unknown command: ${command}\n\n${USAGE}`);
    return 0;
  } catch (e) {
    if (e instanceof UserError) {
      io.err(e.message);
    } else {
      io.err(`Unexpected error: ${mask(e && e.message ? e.message : e)}`);
      if (process.env.OCTOCHECK_DEBUG && e && e.stack) io.err(mask(e.stack));
    }
    return 1;
  }
}

module.exports = {
  main, parseArgs, mask, checkUrl, isLocalHost, getInfo, callEndpoint, httpGet, serverMessage, promptHidden, readStore, writeStore,
  readSites, loadCredentials, hookRegistered, checkStoragePlace, credentialsDir, UserError,
  CRED_FILE, SITES_FILE, CREDENTIAL_GUARD_HOOK, PROFILES, SUPPORTED_BUNDLE_VERSION, checkSiteName, checkProfileName,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
