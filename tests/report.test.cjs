'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SiteModel, FixtureSite } = require('./site-model.cjs');
const { setup, writeEntry, NOW, LATER, ROOT, slugOf } = require('./site-world.cjs');

const iso = (d) => d.toISOString();
const utc = (d) => `${iso(d).slice(0, 16).replace('T', ' ')} UTC`;
const F = (line, rule, note) => ({ line, rule, note });

/** Alpha and Beta share an event; Alpha changed, Beta is new. Gamma is unchanged and has saved flags. Gone was removed. */
async function smallSite() {
  const model = new SiteModel();
  model.add('Alpha', { dt: 'ToDo', event: 'Before Save', text: 'x = 1\n' });
  model.add('Beta', { dt: 'ToDo', event: 'Before Save', text: 'y = 2\n' });
  model.add('Gamma', { doctype: 'Client Script', dt: 'ToDo', type: null, text: 'frm.doc\n' });
  model.add('Gone', { dt: 'ToDo', event: 'Before Save', text: 'z = 3\n' });
  const t = await setup(model);
  await t.fetch();
  const h = (n) => model.manifest().scripts.find((s) => s.name === n).hash;
  writeEntry(t, 'Server Script', 'Alpha', { h: 'sha256:old', en: true });
  writeEntry(t, 'Client Script', 'Gamma', { h: h('Gamma'), en: true, rev: '2026-10-01', flags: [{ l: null, r: 'UI-01', s: 'low', f: 1, n: 'No header comment.' }, { l: 1, r: 'UI-21', s: 'low', f: 6, n: 'Uses cur_frm.' }] });
  writeEntry(t, 'Server Script', 'Gone', { h: h('Gone'), en: true, rev: '2026-09-20' });
  model.remove('Gone');
  await t.ready(LATER);
  return t;
}

module.exports = [
  // --- the whole report, word for word ----------------------------------------------------------
  ['a small run produces exactly this report: header, summary, factors, escaped text, carry-forward', async () => {
    const t = await smallSite();
    t.fill(1, { Alpha: [F(1, 'UI-02', 'Magic number | pipe <b>bold</b> [click](http://evil.example) end'), F(null, 'UI-07', 'Token in text.')] });
    const r = await t.record(1, [], LATER);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.text.includes('Report updated: octocheck/reports/report-2026-10-09-080005.md (1 of 1 task done).'), r.text);
    const expected = [
      '# OctoCheck Site Report — octo-test — 2026-10-09-080005',
      '',
      'Site: octo-test (http://HOST), Frappe 15.0.0, connector 0.1.0',
      'Rules: UI-script rules v0.2.0-draft (27 review rules, 4 contract checks, 0 team rules; disabled for this project: none)',
      `Plan fetched: ${utc(LATER)}, approved: ${utc(NOW)}`,
      'Tasks completed: 1 / 1',
      'Scripts reviewed this run: 2 (1 new, 1 changed, 0 queued because the rules changed, 0 expired by age)',
      'Linked scripts re-checked for contract issues: 0',
      'Not re-reviewed (unchanged since their last review): 1',
      'Flags this run: 2 (1 high, 0 medium, 1 low)',
      '',
      '## Summary by script',
      '',
      '| Script | High | Medium | Low |',
      '| --- | --- | --- | --- |',
      '| [Alpha](http://HOST/app/server-script/Alpha) | 1 | 0 | 1 |',
      '',
      '## Factor 1 — Comments',
      '',
      '### [Alpha](http://HOST/app/server-script/Alpha)',
      'Server Script (DocType Event) · ToDo / Before Save',
      '',
      '| Line | Rule | Severity | Note |',
      '| --- | --- | --- | --- |',
      '| 1 | UI-02 | Low | Magic number \\| pipe &lt;b&gt;bold&lt;/b&gt; \\[click\\](http://evil.example) end |',
      '',
      '## Factor 3 — Dynamic paths',
      '',
      '### [Alpha](http://HOST/app/server-script/Alpha)',
      'Server Script (DocType Event) · ToDo / Before Save',
      '',
      '| Line | Rule | Severity | Note |',
      '| --- | --- | --- | --- |',
      '| whole script | UI-07 | High | Token in text. |',
      '',
      '## Factor 4 — Test cases',
      '',
      'Not applicable to UI scripts: no flags are raised for tests.',
      '',
      '## Reviewed, no flags',
      '',
      'Beta',
      '',
      '## Removed since the last review',
      '',
      '- Gone (Server Script, last reviewed 2026-09-20)',
      '',
      '## Not re-reviewed this run (unchanged since last scan)',
      '',
      'These scripts have not changed since their last review, so they were skipped to save tokens. The flags below are carried forward from that review and were not re-verified this run.',
      '',
      '**[Gamma](http://HOST/app/client-script/Gamma)** (last reviewed 2026-10-01)',
      '- whole script — [UI-01] low — No header comment. (carried forward)',
      '- line 1 — [UI-21] low — Uses cur_frm. (carried forward)',
      '',
      `<!-- Built by OctoCheck from the saved review state at ${iso(LATER)}. Do not edit: it is rebuilt after every task. -->`,
      '',
    ].join('\n');
    assert.strictEqual(t.reportText(), expected);
    await t.done();
  }],
  ['text from the site or the model can never become a table cell, a link or markup in the report', async () => {
    const t = await smallSite();
    t.fill(1, { Alpha: [F(1, 'UI-02', 'a | b <script>alert(1)</script> [x](javascript:alert(1)) `code` \\ end')] });
    assert.strictEqual((await t.record(1, [], LATER)).code, 0);
    const text = t.reportText();
    const row = text.split('\n').find((l) => l.startsWith('| 1 | UI-02 |'));
    assert.strictEqual(row.split(/(?<!\\)\|/).length, 6, `exactly four cells: ${row}`);
    assert.ok(!text.includes('<script>') && !text.includes('[x](javascript:'), text);
    assert.ok(row.includes('&lt;script&gt;') && row.includes('\\[x\\]'), row);
    await t.done();
  }],

  // --- when it is built ------------------------------------------------------------------------------
  ['the report is rebuilt after every task into the same file; it says INCOMPLETE until the last one', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    const seen = [];
    for (let id = 1; id <= 5; id += 1) {
      t.fill(id);
      const r = await t.record(id);
      assert.strictEqual(r.code, 0, r.text);
      assert.ok(r.text.includes(`Report updated: octocheck/reports/report-2026-10-09-080005.md (${id} of 5 tasks done${id < 5 ? ', incomplete' : ''}).`), r.text);
      seen.push(t.reportText());
      assert.deepStrictEqual(t.reportFiles(), ['report-2026-10-09-080005.md'], 'one file for the whole run');
    }
    for (let i = 0; i < 4; i += 1) {
      assert.ok(seen[i].startsWith(`# OctoCheck Site Report — octo-test — 2026-10-09-080005\n\n> **INCOMPLETE: ${i + 1} of 5 tasks done.**`), seen[i].slice(0, 200));
      assert.ok(seen[i].includes('## Not yet reviewed'));
    }
    assert.ok(!seen[4].includes('INCOMPLETE') && !seen[4].includes('## Not yet reviewed'), 'the banner goes when the last task is recorded');
    assert.ok(seen[4].includes('Tasks completed: 5 / 5'));
    await t.done();
  }],
  ['an incomplete report lists the tasks that have not run, with their scripts', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    t.fill(1);
    await t.record(1);
    const text = t.reportText();
    assert.ok(text.includes('- Task 2 (review): DocType Event: ToDo / Before Save — OC Test 1 Missing Field, OC Test 2 None Not Handled, OC Test 6 Old Disabled Rule, OC Test 8 Clean Control'), text);
    assert.ok(text.includes('- Task 5 (review): Scheduler Event: OC Test 5 Hardcoded Values — OC Test 5 Hardcoded Values'), text);
    assert.ok(text.includes('Tasks completed: 1 / 5'));
    await t.done();
  }],
  ['a report that cannot be built never costs the flags: record still succeeds and says what to do', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    fs.mkdirSync(path.join(t.w.cwd, 'octocheck'), { recursive: true });
    fs.writeFileSync(path.join(t.w.cwd, 'octocheck', 'reports'), 'a file where the folder should be');
    t.fill(1, { 'OC Test 3 Query In Loop': [F(3, 'UI-24', 'loop query')] });
    const r = await t.record(1);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.text.includes('Warning: the report could not be built'), r.text);
    assert.ok(r.text.includes('Your flags are saved. Run report --site octo-test to try again.'), r.text);
    assert.ok(r.text.includes('Task 1 of 5 complete — 1 flag found.'), 'the usual lines are still printed');
    assert.strictEqual(t.progress().tasks[0].status, 'done');
    assert.strictEqual(t.entry(slugOf('Server Script', 'OC Test 3 Query In Loop')).flags.length, 1);
    fs.rmSync(path.join(t.w.cwd, 'octocheck', 'reports'));
    const again = await t.report();
    assert.strictEqual(again.code, 0, again.text);
    assert.ok(t.reportText().includes('loop query'), 'the report command rebuilds it from the saved state');
    await t.done();
  }],
  ['the report command rebuilds the same report from the saved state, and explains when there is nothing to build from', async () => {
    const t = await setup(new FixtureSite());
    let r = await t.report();
    assert.strictEqual(r.code, 1);
    assert.ok(r.text.includes('plan.json is missing. Run fetch for this site first.'), r.text);
    await t.fetch();
    r = await t.report();
    assert.ok(r.text.includes('progress.json is missing. Run tasks for this site first.'), r.text);
    await t.tasks();
    await t.tasks(['--approve']);
    t.fill(1);
    await t.record(1);
    const first = t.reportText();
    r = await t.report(NOW);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.text.includes('Report written: octocheck/reports/report-2026-10-09-080005.md'), r.text);
    assert.ok(r.text.includes('1 of 5 tasks done (incomplete). Flags: 0 (0 high, 0 medium, 0 low).'), r.text);
    assert.strictEqual(t.reportText(), first, 'same state and same time: same report');
    await t.done();
  }],
  ['a plan with nothing to review still gets its report, with the flags carried forward', async () => {
    const model = new SiteModel();
    model.add('Gamma', { doctype: 'Client Script', dt: 'ToDo', type: null, text: 'frm.doc\n' });
    const t = await setup(model);
    await t.fetch();
    writeEntry(t, 'Client Script', 'Gamma', { h: model.manifest().scripts[0].hash, en: true, flags: [{ l: 1, r: 'UI-21', s: 'low', f: 6, n: 'Uses cur_frm.' }] });
    await t.fetch(LATER);
    const r = await t.tasks();
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.text.includes('Nothing to review. Report written: octocheck/reports/report-2026-10-09-080005.md'), r.text);
    assert.ok(!r.text.includes('Report will be written to'), r.text);
    const text = t.reportText();
    assert.ok(text.includes('Tasks completed: 0 / 0'), text);
    assert.ok(!text.includes('INCOMPLETE'), 'nothing was left undone');
    assert.ok(text.includes('Not re-reviewed (unchanged since their last review): 1'));
    assert.ok(text.includes('- line 1 — [UI-21] low — Uses cur_frm. (carried forward)'), text);
    assert.ok(!text.includes('No new flags this run.'), 'no task ran, so it does not claim a clean review');
    await t.done();
  }],

  // --- what goes in it ---------------------------------------------------------------------------------
  ['the summary lists scripts worst first, and flags within a script are sorted by line', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    t.fill(1, { 'OC Test 3 Query In Loop': [F(5, 'UI-20', 'b'), F(3, 'UI-24', 'a')] });
    await t.record(1);
    t.fill(2, {
      'OC Test 1 Missing Field': [F(3, 'UI-20', 'low one')],
      'OC Test 2 None Not Handled': [F(2, 'UI-14', 'high one'), F(4, 'UI-11', 'medium one')],
    });
    await t.record(2);
    const text = t.reportText();
    const summary = text.split('\n').filter((l) => /^\| \[OC Test/.test(l)).map((l) => l.match(/\[(OC Test [^\]]+)\]/)[1]);
    assert.deepStrictEqual(summary, ['OC Test 2 None Not Handled', 'OC Test 3 Query In Loop', 'OC Test 1 Missing Field']);
    const factor6 = text.slice(text.indexOf('## Factor 6'), text.indexOf('## Factor 7'));
    assert.ok(factor6.indexOf('OC Test 1 Missing Field') < factor6.indexOf('OC Test 3 Query In Loop'), 'scripts in name order within a factor');
    await t.done();
  }],
  ['flags from rules the project disabled are hidden from the carried-forward part', async () => {
    const t = await smallSite();
    t.fill(1);
    await t.record(1, [], LATER);
    assert.ok(t.reportText().includes('[UI-01] low — No header comment.'));
    t.local('- { id: UI-01, disabled: true }\n[]\n');
    await t.report(LATER);
    const text = t.reportText();
    assert.ok(!text.includes('[UI-01]'), 'a rule the team switched off is not shown');
    assert.ok(text.includes('[UI-21] low — Uses cur_frm. (carried forward)'));
    assert.ok(text.includes('disabled for this project: UI-01'), text);
    await t.done();
  }],
  ['contract checks: the trigger is named, a clean re-check is listed, and neighbours are not also "not re-reviewed"', async () => {
    const model = new SiteModel();
    model.add('Edited Event', { dt: 'ToDo', event: 'Before Save', text: 'doc.priority = 1\n' });
    model.add('Neighbour One', { dt: 'ToDo', event: 'Before Save', text: 'doc.priority = 2\n' });
    model.add('Neighbour Two', { dt: 'ToDo', event: 'Before Save', text: 'doc.priority = 3\n' });
    model.add('Quiet One', { dt: 'ToDo', event: 'Validate', text: 'pass\n' });
    model.link('Edited Event', 'Neighbour One', 'same_event').link('Edited Event', 'Neighbour Two', 'same_event');
    const t = await setup(model);
    await t.fetch();
    const edited = slugOf('Server Script', 'Edited Event');
    for (const s of model.manifest().scripts) writeEntry(t, s.doctype, s.name, { h: s.hash, en: true, flags: s.name === 'Quiet One' ? [{ l: 1, r: 'UI-01', s: 'low', f: 1, n: 'Quiet carried flag' }] : [] });
    writeEntry(t, 'Server Script', 'Edited Event', { h: 'sha256:old', en: true, flags: [{ l: 1, r: 'UI-C-04', s: 'medium', f: 'C', n: 'An earlier contract flag', b: 'server-someone-else-12345678' }] });
    model.edit('Edited Event', 'doc.priority = 9\n');
    await t.ready(LATER);
    t.fill(1, { 'Edited Event': [F(1, 'UI-02', 'magic number')] });
    assert.strictEqual((await t.record(1, [], LATER)).code, 0);
    t.fill(2, { 'Neighbour One': [{ line: 1, rule: 'UI-C-02', trigger: edited, note: 'writes priority differently now' }] });
    const r = await t.record(2, [], LATER);
    assert.strictEqual(r.code, 0, r.text);
    const text = t.reportText();
    assert.ok(text.includes('## Factor C — Contract impact'), text);
    assert.ok(text.includes('Re-checked because **Edited Event** changed (same_event: test link (same_event), was linked before this change).'), text);
    assert.ok(/\| 1 \| UI-C-02 \| High \| writes priority differently now \| Edited Event \|/.test(text), text);
    assert.ok(text.includes('## Re-checked, no contract issues\n\nNeighbour Two'), text);
    assert.ok(text.includes('### Earlier contract flags still open on scripts reviewed this run'), text);
    assert.ok(text.includes('- line 1 — [UI-C-04] medium — An earlier contract flag'), text);
    assert.ok(text.includes('Linked scripts re-checked for contract issues: 2'));
    const carried = text.slice(text.indexOf('## Not re-reviewed this run'));
    assert.ok(carried.includes('Quiet One') && carried.includes('Quiet carried flag'));
    assert.ok(!carried.includes('Neighbour'), 'a script re-checked this run is not also listed as skipped');
    await t.done();
  }],
  ['removed, unavailable and over-the-limit scripts, and notes, are reported', async () => {
    const model = new SiteModel();
    model.add('Keep', { dt: 'ToDo', event: 'Before Save', text: 'k = 1\n' });
    model.add('Missing', { dt: 'ToDo', event: 'Validate', text: 'm = 1\n' });
    const t = await setup(model);
    await t.fetch();
    model.hidden.add('Missing'); // in the manifest, but the bundle call does not return it
    const r = await t.fetch(LATER);
    assert.ok(r.text.includes('Not available'), r.text);
    await t.tasks();
    await t.tasks(['--approve']);
    t.fill(1);
    assert.strictEqual((await t.record(1)).code, 0);
    const text = t.reportText();
    assert.ok(text.includes('## Not available\n\n- Missing — the connector did not return it'), text);
    await t.done();
  }],
  ['a script whose recorded findings went missing is reported in the notes, not hidden', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    t.fill(1, { 'OC Test 3 Query In Loop': [F(3, 'UI-24', 'loop query')] });
    await t.record(1);
    fs.rmSync(path.join(t.stateDir, 'recorded', 'task-1.json'));
    assert.strictEqual((await t.report()).code, 0);
    const text = t.reportText();
    assert.ok(text.includes('## Notes'), text);
    assert.ok(text.includes('The recorded findings of task 1 are missing, so its flags are not in this report. Its saved entries still hold them.'), text);
    assert.ok(!text.includes('loop query'));
    await t.done();
  }],
  ['the report is only ever written inside octocheck/reports/', async () => {
    const t = await setup(new FixtureSite());
    await t.ready();
    const file = path.join(t.stateDir, 'progress.json');
    for (const bad of ['../evil.md', '/tmp/evil.md', 'octocheck/reports/../../evil.md', 'octocheck/cache/report.md', 'octocheck/reports/report.txt']) {
      const progress = JSON.parse(fs.readFileSync(file, 'utf8'));
      progress.run_report_file = bad;
      fs.writeFileSync(file, JSON.stringify(progress));
      const r = await t.report();
      assert.strictEqual(r.code, 1, bad);
      assert.ok(r.text.includes('is not inside octocheck/reports/'), `${bad}: ${r.text}`);
    }
    assert.ok(!fs.existsSync(path.join(t.w.cwd, 'evil.md')));
    assert.ok(!fs.existsSync(path.join(path.dirname(t.w.cwd), 'evil.md')));
    await t.done();
  }],

  // --- the command files ----------------------------------------------------------------------------------
  ['/octocheck-continue says the report is built by a script, and what to tell the user', () => {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'commands', 'octocheck-continue.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes('The report is built by a script after every task, never by you'));
    assert.ok(text.includes('"Report updated" line'));
    assert.ok(text.includes('but do not open or edit it'));
    assert.ok(text.includes('If record printed a "Warning" about the report, repeat it to the user.'));
    assert.ok(!text.includes('in a later step'), 'the old placeholder is gone');
  }],
  ['the site CLI documents report', () => {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'scripts', 'octocheck-site.cjs'), 'utf8');
    assert.ok(text.includes('report --site <name>'));
  }],
];
