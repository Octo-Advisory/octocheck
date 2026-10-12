'use strict';
// Reads rule files whose entries are one-line YAML mappings, like
//   - { id: UI-01, stack: ui-script, factor: 1, description: "text, with commas: and colons", severity: low }
// This is not a YAML parser, on purpose: it understands only that one shape, which is the shape
// of rules.core.yaml and rules.ui-scripts.yaml. Anything else on an entry line is an error, so a
// typo in a rule file fails loudly instead of dropping a rule.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class RulesError extends Error {}

const UI_RULES_FILE = 'rules/rules.ui-scripts.yaml';

/** Split "a: 1, b: \"x, y\"" at the commas that sit outside quotes. */
function splitPairs(body) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && quoted) { current += ch + (body[i + 1] || ''); i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (quoted) throw new RulesError('unclosed quote');
  if (current.trim()) parts.push(current);
  return parts;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new RulesError(`bad quoted value ${v}`);
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** Parse the rules in a file's text. Returns { version, rules }. Comment and blank lines are ignored. */
function parseRules(text) {
  const rules = [];
  let version = null;
  String(text).split(/\r?\n/).forEach((line, index) => {
    const v = line.match(/^#\s*version:\s*(\S+)/);
    if (v && !version) version = v[1];
    if (!/^\s*-\s/.test(line)) return;
    const m = line.match(/^\s*-\s*\{(.*)\}\s*$/);
    if (!m) throw new RulesError(`line ${index + 1}: a rule must be one line like "- { id: X, ... }"`);
    const rule = {};
    for (const pair of splitPairs(m[1])) {
      const at = pair.indexOf(':');
      if (at < 1) throw new RulesError(`line ${index + 1}: "${pair.trim()}" is not key: value`);
      const key = pair.slice(0, at).trim();
      if (key in rule) throw new RulesError(`line ${index + 1}: "${key}" appears twice`);
      rule[key] = parseValue(pair.slice(at + 1));
    }
    rules.push(rule);
  });
  return { version, rules };
}

/**
 * Which rules a project uses: the UI rules, minus any the project disabled in rules.local.yaml,
 * plus any team rules it added for the ui-script stack. A disabled rule is listed, never silently
 * dropped. Team rules may not reuse the reserved factors (1-7 and C).
 *
 * Returns { summary, active }: the summary goes into progress.json, `active` is the list of rules
 * in force (the review checks results against it). `summary.id` names the rule set a review was
 * done under: the version of the UI rules file, plus a short fingerprint of the team rules when
 * there are any. fetch queues a script again when its saved review was done under another id.
 * Disabling a rule does not change the id (a review with fewer checks is still a valid review).
 *
 * With { optional: true }, a missing UI rules file gives null instead of an error, so fetch can
 * still run on a project that has not installed the site rules.
 */
function loadRules(cwd, options = {}) {
  const { UserError } = require('./octocheck-site.cjs');
  const read = (file) => { try { return fs.readFileSync(path.join(cwd, file), 'utf8'); } catch (e) { return null; } };
  const parse = (file, text) => {
    try { return parseRules(text); } catch (e) {
      if (e instanceof RulesError) throw new UserError(`${file}: ${e.message}`);
      throw e;
    }
  };
  const coreText = read(UI_RULES_FILE);
  if (coreText === null) {
    if (options.optional) return null;
    throw new UserError(`${UI_RULES_FILE} is missing. Install OctoCheck again.`);
  }
  const core = parse(UI_RULES_FILE, coreText);
  if (!core.version) throw new UserError(`${UI_RULES_FILE} has no "# version:" line. The version is what tells OctoCheck that the rules changed.`);
  const ids = new Set(core.rules.map((r) => r.id));
  const out = { file: UI_RULES_FILE, version: core.version, review_rules: 0, contract_checks: 0, disabled: [], team_added: [], team_discarded: [] };
  const teamRules = [];
  const localText = read('rules.local.yaml');
  if (localText !== null) {
    for (const r of parse('rules.local.yaml', localText).rules) {
      if (r.disabled === true) {
        if (ids.has(r.id)) out.disabled.push(r.id);
      } else if (r.stack === 'ui-script') {
        const reserved = r.factor === 'C' || (Number.isInteger(r.factor) && r.factor >= 1 && r.factor <= 7);
        if (reserved) { out.team_discarded.push(r.id); } else { out.team_added.push(r.id); teamRules.push(r); }
      }
    }
  }
  const active = core.rules.filter((r) => !out.disabled.includes(r.id)).concat(teamRules);
  for (const r of core.rules) {
    if (out.disabled.includes(r.id)) continue;
    if (r.factor === 'C') out.contract_checks += 1; else out.review_rules += 1;
  }
  out.team_rules = out.team_added.length;
  const fingerprint = teamRules.length
    ? `+team.${crypto.createHash('sha1').update(JSON.stringify(teamRules.map((r) => [r.id, r.factor, r.applies || 'both', r.severity, r.description]).sort())).digest('hex').slice(0, 8)}`
    : '';
  out.id = `${core.version}${fingerprint}`;
  return { summary: out, active };
}

module.exports = { parseRules, loadRules, RulesError, UI_RULES_FILE };
