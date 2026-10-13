'use strict';
// --module: module-wise site reviews (connector 0.1.1 and later).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SiteModel } = require('./site-model.cjs');
const { setup, writeEntry, slugOf, LATER, ROOT } = require('./site-world.cjs');
const { parseModules, suggestModules } = require('../.claude/scripts/octocheck-tasks.cjs');
const { versionAtLeast } = require('../.claude/scripts/octocheck-fetch.cjs');

const NEW = { connectorVersion: '0.1.1' };

/** A small site: three DPR scripts (one an API called from DPR), two Stock scripts, one with no module. */
function dprSite() {
  return new SiteModel()
    .add('DPR Save', { dt: 'DPR Entry', event: 'Before Save', modules: ['DPR'] })
    .add('DPR Form', { doctype: 'Client Script', dt: 'DPR Entry', modules: ['DPR'] })
    .add('DPR Totals', { type: 'API', api: 'dpr_totals', dt: null, modules: ['DPR'], moduleSource: 'caller' })
    .add('Stock Save', { dt: 'Stock Entry', event: 'Before Save', modules: ['Stock'] })
    .add('Stock Form', { doctype: 'Client Script', dt: 'Stock Entry', modules: ['Stock'] })
    .add('Nightly', { type: 'Scheduler Event', dt: null, modules: [], moduleSource: 'none' });
}

const reviewNames = (t) => t.progress().tasks.filter((x) => x.type === 'review').flatMap((x) => x.scripts.map((s) => s.name)).sort();
const contractRows = (t) => t.progress().tasks.filter((x) => x.type === 'contract').flatMap((x) => x.scripts);

/** Mark every script reviewed at its current hash, as an earlier run would have. */
async function allReviewed(t, model, modulesByName = {}) {
  await t.fetch();
  for (const s of model.manifest({ withModules: true }).scripts) {
    writeEntry(t, s.doctype, s.name, { h: s.hash, en: true, m: modulesByName[s.name] || s.modules });
  }
}

module.exports = [
  ['--module values are split on commas, trimmed, de-duplicated and kept case-sensitive', () => {
    assert.strictEqual(parseModules(undefined), null);
    assert.deepStrictEqual(parseModules('DPR'), ['DPR']);
    assert.deepStrictEqual(parseModules(' DPR , Stock,DPR,, '), ['DPR', 'Stock']);
    assert.deepStrictEqual(parseModules('dpr'), ['dpr']);
    assert.throws(() => parseModules(' , '), /--module needs a module name/);
  }],
  ['close module names are suggested for a typo or a different case', () => {
    const defs = ['Accounts', 'Core', 'DPR', 'Stock', 'Stock Ledger'];
    assert.deepStrictEqual(suggestModules('dpr', defs), ['DPR']);
    assert.ok(suggestModules('DRP', defs).includes('DPR'));
    assert.deepStrictEqual(suggestModules('stock', defs).slice(0, 2), ['Stock', 'Stock Ledger']);
    assert.deepStrictEqual(suggestModules('Manufacturing', defs), []);
  }],
  ['connector versions are compared part by part', () => {
    assert.ok(versionAtLeast('0.1.1', '0.1.1'));
    assert.ok(versionAtLeast('0.2.0', '0.1.1'));
    assert.ok(versionAtLeast('0.1.10', '0.1.1'));
    assert.ok(!versionAtLeast('0.1.0', '0.1.1'));
    assert.ok(!versionAtLeast(undefined, '0.1.1'));
    assert.ok(!versionAtLeast('dev', '0.1.1'));
  }],

  // --- fetch -------------------------------------------------------------------------------------------
  ['an older connector is never asked for modules, and --module then says to update it', async () => {
    const t = await setup(dprSite());
    await t.fetch();
    assert.ok(t.c.callsTo('get_manifest').every((c) => c.withModules === null), 'no with_modules for 0.1.0');
    assert.deepStrictEqual(t.plan().modules, { available: false, defs: [] });
    const r = await t.tasks(['--module', 'DPR']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('--module needs octocheck_connector 0.1.1 or later on octo-test (it has 0.1.0). Update the connector on the site'), r.text);
    const plain = await t.tasks();
    assert.strictEqual(plain.code, 0, 'without --module nothing changes');
    await t.done();
  }],
  ['a 0.1.1 connector is asked for modules; they are kept in manifest.json, outside the hash', async () => {
    const t = await setup(dprSite(), NEW);
    await t.fetch();
    assert.ok(t.c.callsTo('get_manifest').every((c) => c.withModules === '1'));
    assert.deepStrictEqual(t.plan().modules, { available: true, defs: ['Core', 'DPR', 'Stock', 'Accounts'] });
    const m = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(m.scripts['Server Script/DPR Totals'].modules, ['DPR']);
    assert.strictEqual(m.scripts['Server Script/DPR Totals'].module_source, 'caller');
    assert.deepStrictEqual(m.scripts['Server Script/Nightly'].modules, []);
    await t.done();
  }],

  // --- tasks -------------------------------------------------------------------------------------------
  ['--module DPR plans only the DPR scripts and leaves the rest queued, never marked reviewed', async () => {
    const t = await setup(dprSite(), NEW);
    await t.fetch();
    const r = await t.tasks(['--module', 'DPR']);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(reviewNames(t), ['DPR Form', 'DPR Save', 'DPR Totals']);
    assert.ok(r.text.includes('Scope: module DPR: 3 of 6 scripts on the site (2 by DocType, 1 API script called from it).'), r.text);
    assert.ok(r.text.includes('Outside this scope: 3 scripts that need review are not reviewed in this run and stay queued.'), r.text);
    const scope = t.progress().scope;
    assert.deepStrictEqual(scope.modules, ['DPR']);
    assert.strictEqual(scope.deferred, 3);
    assert.strictEqual(scope.no_module, 1);
    // Finish the run; the next plain fetch still sees the Stock scripts and Nightly as never reviewed.
    await t.tasks(['--module', 'DPR', '--approve']);
    for (const task of t.progress().tasks) { t.fill(task.id); assert.strictEqual((await t.record(task.id)).code, 0); }
    await t.fetch(LATER);
    const statuses = Object.fromEntries(t.plan().review.map((i) => [i.name, i.status]));
    assert.deepStrictEqual(statuses, { 'Nightly': 'new', 'Stock Form': 'new', 'Stock Save': 'new' });
    assert.deepStrictEqual(t.entry(slugOf('Server Script', 'DPR Save')).m, ['DPR'], 'the review saves the modules');
    await t.done();
  }],
  ['--module combines with --only and with several modules', async () => {
    const t = await setup(dprSite(), NEW);
    await t.fetch();
    let r = await t.tasks(['--module', 'DPR', '--only', 'server']);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(reviewNames(t), ['DPR Save', 'DPR Totals']);
    assert.ok(r.text.includes('Scope: module DPR, Server Scripts only: 2 of 6 scripts on the site'), r.text);
    r = await t.tasks(['--module', 'DPR,Stock']);
    assert.deepStrictEqual(reviewNames(t), ['DPR Form', 'DPR Save', 'DPR Totals', 'Stock Form', 'Stock Save']);
    assert.ok(r.text.includes('Scope: modules DPR, Stock: 5 of 6 scripts on the site'), r.text);
    await t.done();
  }],
  ['an unknown module stops with suggestions; a module with no scripts says so', async () => {
    const t = await setup(dprSite(), NEW);
    await t.fetch();
    let r = await t.tasks(['--module', 'dpr']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('There is no module named "dpr" on octo-test. Did you mean: DPR? Module names are case-sensitive.'), r.text);
    assert.ok(r.text.includes('Modules that have scripts: DPR, Stock.'), r.text);
    r = await t.tasks(['--module', 'Accounts']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('Module Accounts has no Server or Client Scripts that your account can read on octo-test, so there is nothing to review.'), r.text);
    assert.ok(!fs.existsSync(path.join(t.stateDir, 'progress.json')), 'no plan is written');
    await t.done();
  }],
  ['contract checks: only for changes reviewed in this run; a neighbour in another module is kept, marked', async () => {
    const model = dprSite().link('DPR Save', 'Stock Save', 'saves_doc').link('Stock Form', 'DPR Form', 'calls_api');
    const t = await setup(model, NEW);
    await allReviewed(t, model);
    model.edit('DPR Save', 'doc.qty = 2\n').edit('Stock Form', 'frm.doc.x = 1\n');
    await t.fetch(LATER);
    const r = await t.tasks(['--module', 'DPR']);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(reviewNames(t), ['DPR Save']);
    const rows = contractRows(t);
    assert.deepStrictEqual(rows.map((s) => [s.name, s.outside_scope === true, [...new Set(s.because.map((b) => b.script))]]), [['Stock Save', true, ['DPR Save']]]);
    assert.strictEqual(t.progress().scope.deferred_contract, 1, 'DPR Form waits for Stock Form, which is not reviewed in this run');
    await t.done();
  }],
  ['a script whose DocType moved module is unchanged, and is carried forward in its new module', async () => {
    const model = dprSite();
    const t = await setup(model, NEW);
    await allReviewed(t, model);
    model.setModules('Stock Save', ['DPR']);
    model.edit('DPR Save', 'doc.qty = 3\n');
    await t.fetch(LATER);
    assert.deepStrictEqual(t.plan().review.map((i) => i.name), ['DPR Save'], 'a new module is not a change');
    await t.tasks(['--module', 'DPR']);
    await t.tasks(['--module', 'DPR', '--approve']);
    t.fill(1);
    assert.strictEqual((await t.record(1, [], LATER)).code, 0);
    const text = t.reportText();
    const carried = text.slice(text.indexOf('## Not re-reviewed this run'));
    assert.ok(carried.includes('Stock Save') && carried.includes('DPR Form') && carried.includes('DPR Totals'), carried);
    assert.ok(!carried.includes('Stock Form') && !carried.includes('Nightly'), 'scripts outside the module are not listed');
    assert.ok(text.includes('Scope: module DPR: 4 of 6 scripts on the site'), text);
    assert.ok(text.includes('Not re-reviewed (unchanged since their last review): 3'), text);
    await t.done();
  }],
  ['a removed script is reported in the module it was last reviewed in, not in others', async () => {
    const model = dprSite().add('Old DPR', { dt: 'DPR Entry', event: 'Validate', modules: ['DPR'] });
    const t = await setup(model, NEW);
    await allReviewed(t, model);
    model.remove('Old DPR').edit('DPR Save', 'x = 1\n').edit('Stock Save', 'y = 1\n');
    await t.fetch(LATER);
    await t.tasks(['--module', 'DPR']);
    assert.deepStrictEqual(t.progress().removed.map((r) => r.name), ['Old DPR']);
    await t.tasks(['--module', 'Stock']);
    assert.deepStrictEqual(t.progress().removed, []);
    await t.done();
  }],
  ['the report states the module scope and marks a contract check outside it', async () => {
    const model = dprSite().link('DPR Save', 'Stock Save', 'saves_doc');
    const t = await setup(model, NEW);
    await allReviewed(t, model);
    model.edit('DPR Save', 'doc.qty = 2\n');
    await t.fetch(LATER);
    await t.tasks(['--module', 'DPR']);
    await t.tasks(['--module', 'DPR', '--approve']);
    for (const task of t.progress().tasks) {
      t.fill(task.id, task.type === 'contract'
        ? { 'Stock Save': [{ line: 1, rule: 'UI-C-02', trigger: slugOf('Server Script', 'DPR Save'), note: 'reads qty differently' }] }
        : {});
      const r = await t.record(task.id, [], LATER);
      assert.strictEqual(r.code, 0, r.text);
    }
    const text = t.reportText();
    assert.ok(text.includes('Scope: module DPR: 3 of 6 scripts on the site (2 by DocType, 1 API script called from it). Scripts outside the scope were not reviewed in this run.'), text);
    assert.ok(text.includes('· outside this module scope'), text);
    await t.done();
  }],
  ['/octocheck-init passes --module through unchanged and never guesses one', () => {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'commands', 'octocheck-init.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes('If the user passed `--module <name>`'));
    assert.ok(text.includes('module names are case-sensitive, so never correct, guess or add one'));
  }],
];
