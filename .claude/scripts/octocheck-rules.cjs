'use strict';
// Reads rule files whose entries are one-line YAML mappings, like
//   - { id: UI-01, stack: ui-script, factor: 1, description: "text, with commas: and colons", severity: low }
// This is not a YAML parser, on purpose: it understands only that one shape, which is the shape
// of rules.core.yaml and rules.ui-scripts.yaml. Anything else on an entry line is an error, so a
// typo in a rule file fails loudly instead of dropping a rule.

class RulesError extends Error {}

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

module.exports = { parseRules, RulesError };
