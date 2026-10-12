'use strict';
// A project folder with a fake connector, saved credentials and the site rules installed, plus helpers
// for the commands that build and run a review plan. Shared by tests that need a whole run.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const site = require('../.claude/scripts/octocheck-site.cjs');
const fetchMod = require('../.claude/scripts/octocheck-fetch.cjs');
const { loadRules } = require('../.claude/scripts/octocheck-rules.cjs');
const { startConnector, makeWorld, makeIo } = require('./helpers.cjs');

const SITE = 'octo-test';
const NOW = new Date(2026, 9, 9, 8, 0, 5); // local time, so file-name stamps are the same in any time zone
const LATER = new Date(2026, 9, 9, 9, 30, 0);
const ACCOUNTS = { 'goodkey1234:goodsecret99': { user: 'dev@example.com', mode: 'developer' } };
const ROOT = path.join(__dirname, '..');
const RULES_ID = loadRules(ROOT).summary.id;

async function setup(model) {
  const w = makeWorld();
  const c = await startConnector({ site: model, accounts: ACCOUNTS });
  fs.writeFileSync(path.join(w.cwd, 'octocheck.sites.json'), JSON.stringify({ [SITE]: { url: c.url } }));
  fs.mkdirSync(w.credDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.credFile, JSON.stringify({
    version: 1, sites: { [SITE]: { developer: { key: 'goodkey1234', secret: 'goodsecret99', user: 'x', mode: 'developer', saved_at: NOW.toISOString() } } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(w.cwd, 'rules'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'rules', 'rules.ui-scripts.yaml'), path.join(w.cwd, 'rules', 'rules.ui-scripts.yaml'));
  const stateDir = path.join(w.cwd, 'octocheck', 'cache', 'sites', SITE);
  const run = async (command, args = [], now = NOW) => {
    const io = makeIo();
    const code = await site.main([command, '--site', SITE, ...args], { io, cwd: w.cwd, env: w.env, home: w.home, now: () => now, sleep: async () => {} });
    return { code, text: io.text() };
  };
  const t = {
    w, c, stateDir, run, model,
    fetch: (now) => run('fetch', [], now),
    tasks: (args) => run('tasks', args),
    next: () => run('next'),
    record: (id, args = [], now) => run('record', ['--task', String(id), ...args], now),
    report: (now) => run('report', [], now),
    local: (text) => fs.writeFileSync(path.join(w.cwd, 'rules.local.yaml'), text),
    progress: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'progress.json'), 'utf8')),
    plan: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'plan.json'), 'utf8')),
    entry: (slug) => JSON.parse(fs.readFileSync(path.join(stateDir, 'entries', `${slug}.json`), 'utf8')),
    reportText: () => fs.readFileSync(path.join(w.cwd, t.progress().run_report_file), 'utf8').replace(/127\.0\.0\.1:\d+/g, 'HOST'),
    reportFiles: () => (fs.existsSync(path.join(w.cwd, 'octocheck', 'reports')) ? fs.readdirSync(path.join(w.cwd, 'octocheck', 'reports')) : []),
    ready: async (now) => { await t.fetch(now); await t.tasks(); const r = await t.tasks(['--approve']); assert.strictEqual(r.code, 0, r.text); },
    results: (id, value) => {
      const dir = path.join(stateDir, 'results');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `task-${id}.json`), typeof value === 'string' ? value : JSON.stringify(value));
    },
    /** A results file listing every script in the task, with the given flags by script name. */
    fill: (id, byName = {}) => {
      const task = t.progress().tasks.find((x) => x.id === id);
      t.results(id, { task: id, scripts: task.scripts.map((s) => ({ slug: s.slug, flags: byName[s.name] || [] })) });
    },
    done: async () => { await c.close(); w.cleanup(); },
  };
  return t;
}

/** Save a review entry the way the review does, reviewed under the current rules unless told otherwise. */
function writeEntry(t, doctype, name, fields) {
  const dir = path.join(t.stateDir, 'entries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fetchMod.slugOf(doctype, name)}.json`), JSON.stringify({ doctype, name, h: null, rev: '2026-10-01', rv: RULES_ID, flags: [], ...fields }));
}

module.exports = { setup, writeEntry, SITE, NOW, LATER, ROOT, RULES_ID, slugOf: fetchMod.slugOf };
