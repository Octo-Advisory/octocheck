#!/usr/bin/env node
'use strict';
// Registers OctoCheck's two hooks (the write guard and the credentials guard) in a project's
// .claude/settings.json, keeping everything else in that file exactly as the team set it.
//
//   node .claude/scripts/octocheck-hooks.cjs [project folder]      (the installers run this)
//
// - No settings.json yet: it is created from settings.hooks.json.
// - settings.json exists: each missing OctoCheck hook is added to hooks.PreToolUse; an OctoCheck
//   hook still using the old relative command ("node .claude/hooks/...", which stops working when
//   Claude changes folder) is replaced with the current one. Nothing else is changed.
// - settings.json is not valid JSON: it is left alone and the person is told what to add.
// Claude Code reads hooks when it starts, so a session that was already open needs a restart.

const fs = require('fs');
const path = require('path');

const HOOK_FILES = ['block-source-write.cjs', 'block-credentials-read.cjs'];

function readHooksConfig(sourceDir) {
  return JSON.parse(fs.readFileSync(path.join(sourceDir, '.claude', 'settings.hooks.json'), 'utf8'));
}

const groupsOf = (settings) => (settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : []);
const commandsOf = (group) => (group && Array.isArray(group.hooks) ? group.hooks : []).map((h) => String((h && h.command) || ''));
const fileOf = (command) => HOOK_FILES.find((f) => command.includes(f)) || null;

/** Pure: settings object + hooks config -> { settings, added, replaced }. Never removes anything. */
function mergeHooks(existing, config) {
  const settings = JSON.parse(JSON.stringify(existing || {}));
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  const added = [];
  const replaced = [];
  for (const wanted of groupsOf(config)) {
    const file = fileOf(commandsOf(wanted)[0] || '');
    if (!file) continue;
    const current = wanted.hooks[0].command;
    let found = false;
    for (const group of settings.hooks.PreToolUse) {
      for (const h of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
        const cmd = String((h && h.command) || '');
        if (!cmd.includes(file)) continue;
        found = true;
        if (/node \.claude\/hooks\//.test(cmd)) {
          h.command = current;
          if (wanted.matcher && group.matcher !== wanted.matcher) group.matcher = wanted.matcher;
          replaced.push(file);
        }
      }
    }
    if (!found) {
      settings.hooks.PreToolUse.push(JSON.parse(JSON.stringify(wanted)));
      added.push(file);
    }
  }
  return { settings, added, replaced };
}

/** Register the hooks in <projectDir>/.claude/settings.json. Returns what happened, for printing. */
function ensureHooks(projectDir, sourceDir) {
  const config = readHooksConfig(sourceDir);
  const file = path.join(projectDir, '.claude', 'settings.json');
  let existing = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { status: 'unreadable', file, added: [], replaced: [] };
    }
  }
  const { settings, added, replaced } = mergeHooks(existing, config);
  if (existing && !added.length && !replaced.length) return { status: 'already', file, added, replaced };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { status: existing ? 'updated' : 'created', file, added, replaced };
}

function describeResult(r) {
  if (r.status === 'created') return 'Hooks: created .claude/settings.json with the write guard and the credentials guard.';
  if (r.status === 'already') return 'Hooks: .claude/settings.json already registers both OctoCheck hooks.';
  if (r.status === 'updated') {
    const parts = [];
    if (r.added.length) parts.push(`added ${r.added.join(' and ')}`);
    if (r.replaced.length) parts.push(`updated the old command for ${r.replaced.join(' and ')}`);
    return `Hooks: ${parts.join('; ')} in .claude/settings.json. Your other settings were kept.`;
  }
  return 'Hooks: .claude/settings.json is not valid JSON, so it was left alone. Fix it, then add the "PreToolUse" entries from .claude/settings.hooks.json under "hooks" (or run this installer again).';
}

module.exports = { mergeHooks, ensureHooks, describeResult, HOOK_FILES };

if (require.main === module) {
  const projectDir = path.resolve(process.argv[2] || '.');
  const sourceDir = path.resolve(__dirname, '..', '..');
  try {
    const r = ensureHooks(projectDir, sourceDir);
    console.log(describeResult(r));
    process.exitCode = r.status === 'unreadable' ? 1 : 0;
  } catch (e) {
    console.error(`Hooks could not be registered: ${e.message}`);
    process.exitCode = 1;
  }
}
