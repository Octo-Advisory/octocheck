'use strict';
// The site report. A script builds it from what was saved, so Claude writes none of it and a slip
// cannot reach it. No AI and no network, so building it costs no tokens.
//
//   node .claude/scripts/octocheck-site.cjs report --site <name>
//
// It is rebuilt after every recorded task and again at the end, always into the same file (the
// name was fixed when the plan was made), so a run that stops halfway still leaves a report. Until
// every task is done the first lines say it is INCOMPLETE. Built from, all under
// octocheck/cache/sites/<site>/: progress.json (the plan and its tasks), plan.json (what fetch
// found), manifest.json (script details), recorded/task-<n>.json (the checked findings of each
// finished task) and entries/<slug>.json (flags saved from earlier reviews, for the scripts
// that were not reviewed this run).

const fs = require('fs');
const path = require('path');
const site = require('./octocheck-site.cjs');
const { clean, stateDirFor } = require('./octocheck-fetch.cjs');
const { readRequired, describeModuleScope } = require('./octocheck-tasks.cjs');
const { loadRules } = require('./octocheck-rules.cjs');

const { UserError } = site;

const FACTOR_NAMES = { 1: 'Comments', 2: 'Casing', 3: 'Dynamic paths', 4: 'Test cases', 5: 'Edge cases', 6: 'Org standards', 7: 'Optimize' };
const REPORT_DIR = 'octocheck/reports/';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// --- text helpers ------------------------------------------------------------

/** Text that came from the site or from the model goes into Markdown, so nothing in it may become
 *  a table cell, a link or markup. */
const esc = (s) => String(s).replace(/[\\|<>[\]]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));
const cell = (s) => esc(String(s).replace(/\s+/g, ' ').trim());
const utc = (iso) => (Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown');
const lineOf = (l) => (Number.isInteger(l) ? String(l) : 'whole script');
const where = (l) => (Number.isInteger(l) ? `line ${l}` : 'whole script');
const byLine = (a, b) => (a.l === null || a.l === undefined ? 0 : a.l) - (b.l === null || b.l === undefined ? 0 : b.l) || String(a.r).localeCompare(String(b.r));
const isContractFlag = (f) => f && (f.f === 'C' || (typeof f.r === 'string' && f.r.startsWith('UI-C-')));
const link = (name, url) => (typeof url === 'string' && /^https?:\/\//.test(url) ? `[${cell(name)}](${url.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : cell(name));

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function describe(row, meta) {
  const m = meta || {};
  const disabled = row.enabled === false ? ' · disabled' : '';
  if (row.doctype === 'Client Script') return `Client Script${m.reference_doctype ? ` · ${clean(m.reference_doctype)}${m.apply_to ? ` / ${clean(m.apply_to)}` : ''}` : ''}${disabled}`;
  const type = m.script_type ? ` (${clean(m.script_type)})` : '';
  const where = m.script_type === 'DocType Event' && m.reference_doctype ? ` · ${clean(m.reference_doctype)}${m.doctype_event ? ` / ${clean(m.doctype_event)}` : ''}` : '';
  return `Server Script${type}${where}${disabled}`;
}

const reasonIsRules = (reason) => /^reviewed (under rules|before the rules version)/.test(String(reason || ''));

// --- gathering ------------------------------------------------------------------

function gather(cwd, stateDir) {
  const plan = readRequired(path.join(stateDir, 'plan.json'), 'plan.json');
  const progress = readRequired(path.join(stateDir, 'progress.json'), 'progress.json', 'tasks');
  if (progress.mode !== 'site' || !Array.isArray(progress.tasks)) throw new UserError('progress.json is not a site plan. Run tasks again.');
  const manifest = readJsonSafe(path.join(stateDir, 'manifest.json')) || { scripts: {} };
  const warnings = [];
  const recorded = new Map();
  for (const task of progress.tasks) {
    if (task.status !== 'done') continue;
    const r = readJsonSafe(path.join(stateDir, 'recorded', `task-${task.id}.json`));
    if (!r || !Array.isArray(r.scripts)) { warnings.push(`The recorded findings of task ${task.id} are missing, so its flags are not in this report. Its saved entries still hold them.`); continue; }
    recorded.set(task.id, r);
  }
  const rules = loadRules(cwd, { optional: true });
  const ruleName = new Map();
  if (rules) for (const r of rules.active) ruleName.set(r.id, r);
  const hidden = new Set(rules ? rules.summary.disabled : []);
  const entry = (slug) => {
    const e = readJsonSafe(path.join(stateDir, 'entries', `${slug}.json`));
    return e && Array.isArray(e.flags) ? e : null;
  };
  return { plan, progress, manifest, recorded, warnings, ruleName, hidden, entry, rulesSummary: rules ? rules.summary : progress.rules };
}

// --- building --------------------------------------------------------------------

function buildReport({ cwd, stateDir, now }) {
  const g = gather(cwd, stateDir);
  const { plan, progress, manifest, recorded } = g;
  const metaOf = (row) => (manifest.scripts || {})[`${row.doctype}/${row.name}`];
  const total = progress.tasks.length;
  const done = progress.tasks.filter((t) => t.status === 'done').length;
  const pending = progress.tasks.filter((t) => t.status !== 'done');
  const incomplete = done < total;

  // This run's findings, from the recorded copies.
  const reviewed = [];
  const contract = [];
  for (const task of progress.tasks) {
    const r = recorded.get(task.id);
    if (!r) continue;
    (task.type === 'contract' ? contract : reviewed).push(...r.scripts.map((s) => ({ ...s, task })));
  }
  const reviewFlags = (s) => s.flags.filter((f) => !isContractFlag(f));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const s of reviewed.concat(contract)) for (const f of s.flags) counts[f.s] += 1;
  const totalFlags = counts.high + counts.medium + counts.low;

  // How this run's scripts got into the plan.
  const taskScripts = progress.tasks.filter((t) => t.type === 'review').flatMap((t) => t.scripts);
  const by = { new: 0, changed: 0, rules: 0, age: 0 };
  for (const s of taskScripts) {
    if (s.status === 'new') by.new += 1;
    else if (s.status === 'changed') by.changed += 1;
    else if (reasonIsRules(s.reason)) by.rules += 1;
    else by.age += 1;
  }
  const contractTaskScripts = progress.tasks.filter((t) => t.type === 'contract').flatMap((t) => t.scripts);
  const inTasks = new Set(progress.tasks.flatMap((t) => t.scripts.map((s) => s.slug)));
  // In a module run, only the scope's own unchanged scripts are carried forward; listing the whole
  // site would bury the module's report.
  const scopeModules = progress.scope && Array.isArray(progress.scope.modules) ? new Set(progress.scope.modules) : null;
  const inScopeModules = (u) => !scopeModules || ((metaOf(u) || {}).modules || []).some((m) => scopeModules.has(m));
  const notReReviewed = (plan.unchanged || []).filter((u) => !inTasks.has(u.slug) && inScopeModules(u)).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));

  const stamp = (path.basename(progress.run_report_file || '').match(/^report-(.+)\.md$/) || [])[1] || 'unnamed';
  const rs = g.rulesSummary;
  const out = [];
  const push = (...lines) => out.push(...lines);

  push(`# OctoCheck Site Report — ${esc(progress.site)} — ${stamp}`, '');
  if (incomplete) {
    push(`> **INCOMPLETE: ${done} of ${total} tasks done.** The tasks still to run are listed under "Not yet reviewed". Flags below are only from the finished tasks.`, '');
  }
  push(`Site: ${esc(progress.site)}${plan.url ? ` (${esc(plan.url)})` : ''}${plan.connector ? `, Frappe ${esc(plan.connector.frappe_version)}, connector ${esc(plan.connector.version)}` : ''}`);
  if (rs) {
    push(`Rules: UI-script rules v${esc(rs.version)} (${rs.review_rules} review rules, ${rs.contract_checks} contract checks, ${plural(rs.team_rules || 0, 'team rule')}; disabled for this project: ${rs.disabled && rs.disabled.length ? rs.disabled.join(', ') : 'none'})`);
  }
  if (progress.scope && Array.isArray(progress.scope.modules)) {
    const d = progress.scope;
    const waiting = d.deferred ? ` (${d.deferred} of them need${d.deferred === 1 ? 's' : ''} review and stay${d.deferred === 1 ? 's' : ''} queued)` : '';
    push(`Scope: ${esc(describeModuleScope(d))} Scripts outside the scope were not reviewed in this run${waiting}.`);
  } else if (progress.scope && progress.scope.only) {
    const d = progress.scope;
    push(`Scope: ${d.only === 'server' ? 'Server Scripts' : 'Client Scripts'} only (--only ${d.only}). Deferred, never reviewed yet: ${plural(d.deferred, `${d.deferred_kind} script`)}. Review them later with /octocheck-init --site ${esc(progress.site)} --only ${d.deferred_kind}.`);
  }
  push(`Plan fetched: ${utc(plan.fetched_at)}${progress.approved_at ? `, approved: ${utc(progress.approved_at)}` : ''}`);
  push(`Tasks completed: ${done} / ${total}`);
  push(`Scripts reviewed this run: ${taskScripts.length} (${by.new} new, ${by.changed} changed, ${by.rules} queued because the rules changed, ${by.age} expired by age)`);
  push(`Linked scripts re-checked for contract issues: ${contractTaskScripts.length}`);
  push(`Not re-reviewed (unchanged since their last review): ${notReReviewed.length}`);
  push(`Flags this run: ${totalFlags} (${counts.high} high, ${counts.medium} medium, ${counts.low} low)`, '');
  if (totalFlags === 0 && done > 0) push('No new flags this run.', '');

  // One row per script with flags, worst first, so the reader sees where to start.
  const perScript = new Map();
  for (const s of reviewed.concat(contract)) {
    if (!s.flags.length) continue;
    if (!perScript.has(s.slug)) perScript.set(s.slug, { name: s.name, url: s.desk_url, high: 0, medium: 0, low: 0 });
    for (const f of s.flags) perScript.get(s.slug)[f.s] += 1;
  }
  if (perScript.size) {
    push('## Summary by script', '', '| Script | High | Medium | Low |', '| --- | --- | --- | --- |');
    const rows = [...perScript.values()].sort((a, b) => b.high - a.high || b.medium - a.medium || b.low - a.low || a.name.localeCompare(b.name));
    for (const r of rows) push(`| ${link(r.name, r.url)} | ${r.high} | ${r.medium} | ${r.low} |`);
    push('');
  }

  // Flags by factor.
  const factors = new Set([4]);
  for (const s of reviewed) for (const f of reviewFlags(s)) factors.add(f.f);
  for (const f of [...factors].filter((x) => typeof x === 'number').sort((a, b) => a - b)) {
    const group = reviewed.filter((s) => reviewFlags(s).some((x) => x.f === f)).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    const name = (group.length && reviewFlags(group[0]).find((x) => x.f === f).fn) || FACTOR_NAMES[f] || `Factor ${f}`;
    push(`## Factor ${f} — ${esc(name)}`, '');
    if (f === 4) {
      push('Not applicable to UI scripts: no flags are raised for tests.', '');
      continue;
    }
    for (const s of group) {
      push(`### ${link(s.name, s.desk_url)}`, describe(s, metaOf(s)), '', '| Line | Rule | Severity | Note |', '| --- | --- | --- | --- |');
      for (const x of reviewFlags(s).filter((y) => y.f === f).sort(byLine)) push(`| ${lineOf(x.l)} | ${esc(x.r)} | ${cap(x.s)} | ${cell(x.n)} |`);
      push('');
    }
  }

  // Contract impact: this run's checks, and earlier ones still open on scripts reviewed this run.
  const contractWithFlags = contract.filter((s) => s.flags.length).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  const kept = [];
  for (const s of reviewed) {
    const e = g.entry(s.slug);
    const old = e ? e.flags.filter((f) => isContractFlag(f) && !g.hidden.has(f.r)) : [];
    if (old.length) kept.push({ ...s, old });
  }
  if (contractWithFlags.length || kept.length) {
    push('## Factor C — Contract impact', '');
    for (const s of contractWithFlags) {
      // One clause per triggering script, with every reason it is linked, even when it is linked both now and before the change.
      const triggers = new Map();
      for (const b of s.because || []) {
        const key = b.slug || b.script;
        if (!triggers.has(key)) triggers.set(key, { script: b.script, kinds: new Map() });
        const kinds = triggers.get(key).kinds;
        if (!kinds.has(b.kind)) kinds.set(b.kind, []);
        if (!kinds.get(b.kind).includes(b.reason)) kinds.get(b.kind).push(b.reason);
      }
      const why = [...triggers.values()].map((t) => `**${cell(t.script)}** changed (${[...t.kinds].map(([kind, reasons]) => `${cell(kind)}: ${reasons.map((r) => cell(r)).join(', ')}`).join('; ')})`);
      push(`### ${link(s.name, s.desk_url)}`, `${describe(s, metaOf(s))}${s.outside_scope ? ' · outside this module scope' : ''}`);
      push(`Re-checked because ${why.length ? why.join('; ') : 'a linked script changed'}.`, '', '| Line | Rule | Severity | Note | Because |', '| --- | --- | --- | --- | --- |');
      const triggerName = new Map((s.because || []).map((b) => [b.slug, b.script]));
      for (const x of [...s.flags].sort(byLine)) push(`| ${lineOf(x.l)} | ${esc(x.r)} | ${cap(x.s)} | ${cell(x.n)} | ${cell(triggerName.get(x.b) || '—')} |`);
      push('');
    }
    if (kept.length) {
      push('### Earlier contract flags still open on scripts reviewed this run', '', 'These come from an earlier contract check. They stay until a contract check on the same trigger clears them.', '');
      for (const s of kept.sort((a, b) => a.name.localeCompare(b.name))) {
        push(`**${link(s.name, s.desk_url)}**`);
        for (const x of [...s.old].sort(byLine)) push(`- ${where(x.l)} — [${esc(x.r)}] ${x.s} — ${cell(x.n)}`);
        push('');
      }
    }
  }
  const clean2 = contract.filter((s) => s.flags.length === 0).map((s) => s.name).sort((a, b) => a.localeCompare(b));
  if (clean2.length) push('## Re-checked, no contract issues', '', clean2.map((n) => cell(n)).join(', '), '');

  const noFlags = reviewed.filter((s) => s.flags.length === 0).map((s) => s.name).sort((a, b) => a.localeCompare(b));
  if (noFlags.length) push('## Reviewed, no flags', '', noFlags.map((n) => cell(n)).join(', '), '');

  if (pending.length) {
    push('## Not yet reviewed', '', 'These tasks have not run yet.', '');
    for (const t of pending) push(`- Task ${t.id} (${t.type}): ${cell(t.name)} — ${t.scripts.map((s) => cell(s.name)).join(', ')}`);
    push('');
  }

  const removed = progress.removed || [];
  if (removed.length) {
    push('## Removed since the last review', '');
    for (const r of removed) push(`- ${cell(r.name)} (${cell(r.doctype)}${r.last_reviewed ? `, last reviewed ${cell(r.last_reviewed)}` : ''})`);
    push('');
  }
  const unavailable = progress.unavailable || [];
  if (unavailable.length) {
    push('## Not available', '');
    for (const u of unavailable) push(`- ${cell(u.name)} — ${cell(u.why)}`);
    push('');
  }
  const over = progress.impacted_over_limit || [];
  const disabledLinked = progress.impacted_disabled || [];
  if (over.length || disabledLinked.length) {
    push('## Linked scripts not re-checked', '');
    if (over.length) push(`- Over the limit of ${plan.settings ? plan.settings.blast_radius_limit : 'linked scripts'}: ${over.map((o) => cell(o.name)).join(', ')}`);
    if (disabledLinked.length) push(`- Disabled, so they cannot run: ${disabledLinked.map((o) => cell(o.name)).join(', ')}`);
    push('');
  }
  const notes = (progress.notes || []).concat(g.warnings);
  if (notes.length) {
    push('## Notes', '');
    for (const n of notes) push(`- ${cell(n)}`);
    push('');
  }

  if (notReReviewed.length) {
    push('## Not re-reviewed this run (unchanged since last scan)', '',
      'These scripts have not changed since their last review, so they were skipped to save tokens. The flags below are carried forward from that review and were not re-verified this run.', '');
    for (const u of notReReviewed) {
      const e = g.entry(u.slug);
      const url = plan.url ? `${plan.url}/app/${u.doctype === 'Client Script' ? 'client-script' : 'server-script'}/${encodeURIComponent(u.name)}` : null;
      push(`**${link(u.name, url)}**${e && e.rev ? ` (last reviewed ${cell(e.rev)})` : ''}`);
      if (!e) { push('- No saved review found for this script.', ''); continue; }
      const flags = e.flags.filter((f) => !g.hidden.has(f.r)).sort(byLine);
      if (!flags.length) push('- No known flags from last review.');
      for (const x of flags) push(`- ${where(x.l)} — [${esc(x.r)}] ${x.s} — ${cell(x.n)} (carried forward)`);
      push('');
    }
  }

  push(`<!-- Built by OctoCheck from the saved review state at ${(now || new Date()).toISOString()}. Do not edit: it is rebuilt after every task. -->`, '');
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), done, total, counts, incomplete, file: progress.run_report_file };
}

/** Build the report and write it to the run's report file. */
function writeReport({ cwd, stateDir, now }) {
  const built = buildReport({ cwd, stateDir, now });
  const rel = String(built.file || '').split(path.sep).join('/');
  if (!rel.startsWith(REPORT_DIR) || rel.includes('..') || !rel.endsWith('.md')) {
    throw new UserError(`The report file name "${rel}" is not inside ${REPORT_DIR}. Run /octocheck-init --site again to make a new plan.`);
  }
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, built.text);
  fs.renameSync(tmp, file);
  return { ...built, rel };
}

function runReport(flags, ctx) {
  const { io, cwd } = ctx;
  site.checkSiteName(flags.site);
  const stateDir = stateDirFor(cwd, flags.site);
  const r = writeReport({ cwd, stateDir, now: ctx.now ? ctx.now() : new Date() });
  io.out(`Report written: ${r.rel}`);
  io.out(`${r.done} of ${plural(r.total, 'task')} done${r.incomplete ? ' (incomplete)' : ''}. Flags: ${r.counts.high + r.counts.medium + r.counts.low} (${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.low} low).`);
  return r;
}

module.exports = { runReport, writeReport, buildReport };
