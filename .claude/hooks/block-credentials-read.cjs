#!/usr/bin/env node
// OctoCheck credentials guard.
//
// Registered as a PreToolUse hook (see settings.hooks.json). It runs outside the
// conversation, so a prompt cannot talk it out of its job: it blocks any tool call that
// points at the folder where `octocheck-site.cjs setup` saves API secrets.
//
// This is the second layer. The first is that the secret never appears anywhere Claude
// reads: only the site script touches the file, and the commands allow Claude to run
// nothing but that script. This hook covers the gap that Read, Grep and Glob are
// pre-approved without limits.
//
// Exit code 0 = allow. Exit code 2 + a stderr message = block.

const os = require('os');
const path = require('path');

const CRED_FILE_STEM = 'octocheck-credentials';
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'directory', 'dir'];

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function slashes(text) {
  return String(text).replace(/\\/g, '/');
}

function expand(p, home, cwd) {
  let s = slashes(p).replace(/\$\{?HOME\}?/g, slashes(home));
  if (s === '~' || s.startsWith('~/')) s = slashes(home) + s.slice(1);
  return path.resolve(cwd, s);
}

function inside(child, parent) {
  const a = slashes(child).toLowerCase();
  const b = slashes(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/** True if this tool call refers to the credentials. Exported for tests. */
function shouldBlock(payload, env = process.env) {
  const input = payload.tool_input || payload.toolInput || {};
  const cwd = payload.cwd || process.cwd();
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dir = path.resolve(env.OCTOCHECK_CREDENTIALS_DIR || path.join(home, '.config', 'octocheck'));
  const text = slashes(strings(input).join('\n')).toLowerCase();

  const needles = [CRED_FILE_STEM, '.config/octocheck', 'octocheck_credentials_dir', slashes(dir).toLowerCase()];
  if (needles.some((n) => text.includes(n))) return true;

  // A path that is the folder itself, or contains it (grep -r ~/.config), or is inside it.
  for (const field of PATH_FIELDS) {
    if (typeof input[field] === 'string' && input[field]) {
      const resolved = expand(input[field], home, cwd);
      if (inside(resolved, dir) || inside(dir, resolved)) return true;
    }
  }
  return false;
}

module.exports = { shouldBlock };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      // Fail closed, same as the write guard.
      process.stderr.write('OctoCheck credentials guard: could not parse the tool call payload, blocking as a precaution.\n');
      process.exit(2);
    }
    if (shouldBlock(payload)) {
      const tool = payload.tool_name || payload.toolName || 'tool';
      process.stderr.write(
        `OctoCheck keeps API secrets away from Claude. Blocked a ${tool} call that refers to the saved ` +
        'credentials. To change a key, the user runs `node .claude/scripts/octocheck-site.cjs rotate` in a terminal.\n'
      );
      process.exit(2);
    }
    process.exit(0);
  });
}
