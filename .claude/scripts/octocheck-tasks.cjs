'use strict';
// `tasks`: turn what fetch saved (plan.json + manifest.json) into the list of review tasks.
// No AI and no network. Claude reads the result; it never builds the groups itself, so the split
// is the same every run and can be tested.
//
//   node .claude/scripts/octocheck-site.cjs tasks --site <name>            build the tasks (approved: false)
//   node .claude/scripts/octocheck-site.cjs tasks --site <name> --approve  record the user's yes
//
// Grouping (decisions 7a):
//   Server Script, type DocType Event  -> one group per DocType + event      (ToDo / Before Save)
//   Client Script                      -> one group per DocType + view       (ToDo / Form)
//   everything else (API, Scheduler Event, Permission Query, ...) -> one task per script
// A group with more than `group_size_cap` scripts is split into parts of that size, in script-name
// order, so the same scripts stay together from one run to the next. The cap counts scripts, not
// text size. 0 or off switches the cap off.
//
// Scripts that fetch needs fully reviewed become `review` tasks. Their linked neighbours become
// `contract` tasks (only the contract check, rules with factor C), grouped the same way and placed
// after every review task.
//
// Writes <state dir>/progress.json: the task list, the report file name, and `approved: false`.
// Only this command and the review commands write that file; fetch never does.

const fs = require('fs');
const path = require('path');
const site = require('./octocheck-site.cjs');
const { loadRules } = require('./octocheck-rules.cjs');
const { readLimit, stateDirFor, clean } = require('./octocheck-fetch.cjs');

const { UserError } = site;
const DEFAULT_GROUP_CAP = 5;
const KIND_ORDER = { event: 0, client: 1, single: 2 };

const pad = (n) => String(n).padStart(2, '0');

/** Same shape as `date +%Y-%m-%d-%H%M%S` (local time), used in the report file name. */
function stamp(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readGroupCap(cwd) {
  let text = '';
  try { text = fs.readFileSync(path.join(cwd, 'octocheck.config.yaml'), 'utf8'); } catch (e) { /* default */ }
  return readLimit(text, 'group_size_cap', DEFAULT_GROUP_CAP);
}

/** Which group a script belongs to. `meta` is the script's row in manifest.json. */
function groupOf(item, meta) {
  const m = meta || {};
  if (item.doctype === 'Server Script' && m.script_type === 'DocType Event' && m.reference_doctype && m.doctype_event) {
    return { kind: 'event', doctype: m.reference_doctype, event: m.doctype_event, label: `DocType Event: ${clean(m.reference_doctype)} / ${clean(m.doctype_event)}` };
  }
  if (item.doctype === 'Client Script' && m.reference_doctype && m.apply_to) {
    return { kind: 'client', doctype: m.reference_doctype, view: m.apply_to, label: `Client Script: ${clean(m.reference_doctype)} / ${clean(m.apply_to)}` };
  }
  const what = item.doctype === 'Client Script' ? 'Client Script' : (m.script_type || 'Server Script');
  return { kind: 'single', label: `${what}: ${clean(item.name)}`, single: item.slug };
}

const groupKey = (g) => `${KIND_ORDER[g.kind]}\u0000${g.label}\u0000${g.single || ''}`;

function scriptRow(item, meta, extra) {
  const m = meta || {};
  return {
    slug: item.slug, doctype: item.doctype, name: item.name, script_type: m.script_type || null, enabled: item.enabled !== false,
    desk_url: item.desk_url, bundle: item.bundle, context: item.context || null, ...extra,
  };
}

/** Split into groups, then into parts of at most `cap` scripts. Returns task shells in a stable order. */
function chunkInto(items, metaOf, cap, type, makeRow) {
  const groups = new Map();
  for (const item of items) {
    const g = groupOf(item, metaOf(item));
    const key = groupKey(g);
    if (!groups.has(key)) groups.set(key, { g, items: [] });
    groups.get(key).items.push(item);
  }
  const tasks = [];
  for (const key of [...groups.keys()].sort()) {
    const { g, items: members } = groups.get(key);
    members.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    const size = cap > 0 ? cap : members.length;
    const parts = Math.ceil(members.length / size);
    for (let p = 0; p < parts; p += 1) {
      const slice = members.slice(p * size, (p + 1) * size);
      const { label, ...group } = g;
      delete group.single;
      tasks.push({
        type,
        name: parts > 1 ? `${label} (part ${p + 1} of ${parts})` : label,
        group, part: parts > 1 ? { n: p + 1, of: parts } : null,
        scripts: slice.map(makeRow), status: 'pending',
      });
    }
  }
  return tasks;
}

function readRuleSet(cwd) {
  return loadRules(cwd).summary;
}

/** Build progress.json from plan.json and manifest.json. Pure: no files are touched. */
function buildProgress({ plan, manifest, cap, now, rules }) {
  const warnings = [];
  const seen = new Map();
  const metaOf = (item) => {
    if (seen.has(item.slug)) return seen.get(item.slug);
    const meta = manifest && manifest.scripts && manifest.scripts[`${item.doctype}/${item.name}`];
    if (!meta) warnings.push(`"${clean(item.name)}" is not in manifest.json, so it gets a task of its own.`);
    seen.set(item.slug, meta);
    return meta;
  };
  const review = chunkInto(plan.review || [], metaOf, cap, 'review', (item) => scriptRow(item, metaOf(item), {
    status: item.status, reason: item.reason, hash: item.hash, enabled_flipped: item.enabled_flipped || undefined,
  }));
  const contract = chunkInto(plan.impacted || [], metaOf, cap, 'contract', (item) => scriptRow(item, metaOf(item), {
    because: (item.because || []).map((b) => ({ script: b.script, slug: b.slug, kind: b.kind, reason: b.reason, source: b.source })),
  }));
  const tasks = review.concat(contract).map((t, i) => ({ id: i + 1, ...t }));
  const count = (type) => tasks.filter((t) => t.type === type).reduce((n, t) => n + t.scripts.length, 0);
  return {
    mode: 'site', site: plan.site, plan_fetched_at: plan.fetched_at, approved: false,
    run_report_file: `octocheck/reports/report-${stamp(now)}.md`,
    group_size_cap: cap,
    rules: rules || null,
    counts: { tasks: tasks.length, review_tasks: review.length, contract_tasks: contract.length, review_scripts: count('review'), contract_scripts: count('contract') },
    tasks,
    removed: plan.removed || [], unavailable: plan.unavailable || [],
    impacted_over_limit: plan.impacted_over_limit || [], impacted_disabled: plan.impacted_disabled || [],
    notes: (plan.warnings || []).concat(plan.notes || [], warnings),
  };
}

function readRequired(file, what, fix = 'fetch') {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new UserError(`${what} is missing. Run ${fix} for this site first.`);
  }
  try { return JSON.parse(text); } catch (e) {
    throw new UserError(`${what} could not be read. Run ${fix} again to rebuild it.`);
  }
}

/** Record the user's yes. Refuses when the plan changed since the tasks were built, so a yes can
 *  never be applied to a task list the user did not see. */
function approveTasks(flags, ctx) {
  const { io, cwd } = ctx;
  const stateDir = stateDirFor(cwd, flags.site);
  const progressFile = path.join(stateDir, 'progress.json');
  const plan = readRequired(path.join(stateDir, 'plan.json'), 'plan.json');
  const progress = readRequired(progressFile, 'progress.json', 'tasks');
  if (progress.mode !== 'site' || !Array.isArray(progress.tasks)) throw new UserError('progress.json is not a site plan. Run tasks again.');
  if (progress.plan_fetched_at !== plan.fetched_at) {
    throw new UserError('The site was fetched again after these tasks were built, so the plan you saw is out of date. Run tasks again and approve the new plan.');
  }
  if (progress.tasks.length === 0) throw new UserError('There are no tasks, so there is nothing to approve.');
  if (progress.approved === true) {
    io.out(`${flags.site}: this plan was already approved. Nothing changed.`);
    return progress;
  }
  progress.approved = true;
  progress.approved_at = (ctx.now ? ctx.now() : new Date()).toISOString();
  fs.writeFileSync(progressFile, `${JSON.stringify(progress, null, 2)}\n`);
  io.out(`${flags.site}: plan approved (${progress.tasks.length} task${progress.tasks.length === 1 ? '' : 's'}). Next: /octocheck-continue --site ${flags.site}`);
  return progress;
}

async function runTasks(flags, ctx) {
  const { io, cwd } = ctx;
  site.checkSiteName(flags.site);
  if (flags.approve) return approveTasks(flags, ctx);
  const stateDir = stateDirFor(cwd, flags.site);
  const plan = readRequired(path.join(stateDir, 'plan.json'), 'plan.json');
  const manifest = readRequired(path.join(stateDir, 'manifest.json'), 'manifest.json');
  if (plan.plan_version !== 1) throw new UserError(`plan.json is version ${plan.plan_version}; this OctoCheck understands version 1. Update OctoCheck or run fetch again.`);
  const rules = readRuleSet(cwd);
  if (plan.rules_id !== rules.id) {
    throw new UserError(`The rules changed since the last fetch (${plan.rules_id || 'none recorded'} to ${rules.id}), so which scripts need review may be out of date. Run fetch again, then tasks.`);
  }
  const progress = buildProgress({ plan, manifest, cap: readGroupCap(cwd), now: ctx.now ? ctx.now() : new Date(), rules });
  fs.writeFileSync(path.join(stateDir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`);

  const c = progress.counts;
  io.out(`${flags.site}: ${c.tasks} task${c.tasks === 1 ? '' : 's'} (${c.review_tasks} review covering ${c.review_scripts} script${c.review_scripts === 1 ? '' : 's'}, ${c.contract_tasks} contract covering ${c.contract_scripts}).`);
  io.out(`Group size cap: ${progress.group_size_cap > 0 ? `${progress.group_size_cap} scripts per task` : 'off'}.`);
  io.out(`Rules: ${rules.file} v${rules.version}: ${rules.review_rules} review rules, ${rules.contract_checks} contract checks, ${rules.team_rules} team rule${rules.team_rules === 1 ? '' : 's'}; disabled for this project: ${rules.disabled.length ? rules.disabled.join(', ') : 'none'}.`);
  if (rules.team_discarded.length) io.out(`Note: team rule${rules.team_discarded.length === 1 ? '' : 's'} ${rules.team_discarded.join(', ')} ignored: factors 1-7 and C are reserved for the core rules.`);
  for (const t of progress.tasks) io.out(`  ${t.id}. [${t.type}] ${t.name}: ${t.scripts.length} script${t.scripts.length === 1 ? '' : 's'}`);
  for (const r of progress.removed.slice(0, 20)) io.out(`Removed since the last review: ${clean(r.name)}`);
  for (const n of progress.notes) io.out(`Note: ${n}`);
  io.out(`Report will be written to: ${progress.run_report_file}`);
  io.out(`Progress: ${path.relative(cwd, path.join(stateDir, 'progress.json'))}`);
  return progress;
}

module.exports = { runTasks, approveTasks, buildProgress, groupOf, readGroupCap, readRuleSet, loadRules, readRequired, stamp, DEFAULT_GROUP_CAP };
