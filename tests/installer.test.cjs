'use strict';
// A file that one of the scripts needs but the installers forgot to copy only shows up on someone
// else's machine. These tests install into a clean folder and run the installed scripts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALLED = [
  '.claude/commands/octocheck-init.md', '.claude/commands/octocheck-continue.md', '.claude/commands/octocheck-connect.md',
  '.claude/settings.hooks.json', '.claude/scripts/octocheck-hooks.cjs',
  '.claude/hooks/block-source-write.cjs', '.claude/hooks/block-credentials-read.cjs',
  '.claude/scripts/octocheck-site.cjs', '.claude/scripts/octocheck-fetch.cjs',
  '.claude/scripts/octocheck-schema.cjs', '.claude/scripts/bundle_schema_v1.json',
  '.claude/scripts/octocheck-tasks.cjs', '.claude/scripts/octocheck-review.cjs', '.claude/scripts/octocheck-report.cjs', '.claude/scripts/octocheck-rules.cjs',
  'rules/rules.core.yaml', 'rules/rules.ui-scripts.yaml', 'rules.local.yaml', 'octocheck.config.yaml',
];

function target() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocheck-install-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function check(dir) {
  for (const f of INSTALLED) assert.ok(fs.existsSync(path.join(dir, f)), `not installed: ${f}`);
  JSON.parse(fs.readFileSync(path.join(dir, '.claude/scripts/bundle_schema_v1.json'), 'utf8'));
  // Every sibling file a script requires must have been installed.
  for (const script of fs.readdirSync(path.join(dir, '.claude/scripts')).filter((f) => f.endsWith('.cjs'))) {
    const text = fs.readFileSync(path.join(dir, '.claude/scripts', script), 'utf8');
    for (const m of text.matchAll(/require\('\.\/([\w.-]+)'\)/g)) {
      assert.ok(fs.existsSync(path.join(dir, '.claude/scripts', m[1])), `${script} needs ${m[1]}, which was not installed`);
    }
  }
  // fetch must get as far as looking for the site, which proves its modules and the schema load.
  const r = spawnSync(process.execPath, ['.claude/scripts/octocheck-site.cjs', 'fetch', '--site', 'nowhere'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('is not in octocheck.sites.json'), r.stderr);
  assert.ok(!/Cannot find module/.test(r.stderr), r.stderr);
}

module.exports = [
  ['the npx installer copies everything the scripts need', async () => {
    const dir = target();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    check(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['the bash installer copies the same files', async () => {
    const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    if (bash.error || bash.status !== 0) return; // no bash here (plain Windows): nothing to test
    const dir = target();
    const r = spawnSync('bash', [path.join(ROOT, 'install.sh'), dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    check(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }],


  ['both installers register the hooks: a new settings.json, or merged into the team\'s, old commands replaced', async () => {
    const hasBash = !spawnSync('bash', ['--version'], { encoding: 'utf8' }).error;
    const installers = [(dir) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), dir], { encoding: 'utf8' })]
      .concat(hasBash ? [(dir) => spawnSync('bash', [path.join(ROOT, 'install.sh'), dir], { encoding: 'utf8' })] : []);
    const wanted = require('../.claude/settings.hooks.json').hooks.PreToolUse.map((g) => g.hooks[0].command);
    const commands = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    for (const install of installers) {
      // No settings yet: created with both hooks.
      const fresh = target();
      let r = install(fresh);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('Hooks: created .claude/settings.json'), r.stdout);
      assert.deepStrictEqual(commands(fresh), wanted);

      // The team's settings: kept; the old relative command replaced; the missing hook added.
      const old = target();
      fs.mkdirSync(path.join(old, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(old, '.claude', 'settings.json'), JSON.stringify({
        model: 'opus', permissions: { allow: ['Bash(ls:*)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo team hook' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node .claude/hooks/block-source-write.cjs' }] }] },
      }));
      r = install(old);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('updated the old command for block-source-write.cjs'), r.stdout);
      assert.ok(r.stdout.includes('added block-credentials-read.cjs'), r.stdout);
      assert.ok(!r.stdout.includes('WARNING: .claude/settings.json'), r.stdout);
      const merged = JSON.parse(fs.readFileSync(path.join(old, '.claude', 'settings.json'), 'utf8'));
      assert.strictEqual(merged.model, 'opus');
      assert.deepStrictEqual(merged.permissions, { allow: ['Bash(ls:*)'] });
      assert.deepStrictEqual(commands(old), ['echo team hook', ...wanted]);

      // Already done: nothing changes on a second run.
      const before = fs.readFileSync(path.join(old, '.claude', 'settings.json'), 'utf8');
      r = install(old);
      assert.ok(r.stdout.includes('already registers both OctoCheck hooks'), r.stdout);
      assert.strictEqual(fs.readFileSync(path.join(old, '.claude', 'settings.json'), 'utf8'), before);

      // Not valid JSON: left alone, with what to do. settings.local.json is never edited, only warned about.
      const broken = target();
      fs.mkdirSync(path.join(broken, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(broken, '.claude', 'settings.json'), '{ not json');
      fs.writeFileSync(path.join(broken, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/block-source-write.cjs' }] }] } }));
      r = install(broken);
      assert.strictEqual(fs.readFileSync(path.join(broken, '.claude', 'settings.json'), 'utf8'), '{ not json');
      assert.ok(r.stdout.includes('is not valid JSON, so it was left alone'), r.stdout);
      assert.ok(r.stdout.includes('WARNING: .claude/settings.local.json uses the OLD hook commands'), r.stdout);
      for (const d of [fresh, old, broken]) fs.rmSync(d, { recursive: true, force: true });
    }
  }],

  ['the installers never overwrite the team\'s own settings', async () => {
    const dir = target();
    fs.writeFileSync(path.join(dir, 'octocheck.config.yaml'), 'review_expiry_days: 7\n');
    fs.writeFileSync(path.join(dir, 'rules.local.yaml'), '# mine\n');
    spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'octocheck.config.yaml'), 'utf8'), 'review_expiry_days: 7\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'rules.local.yaml'), 'utf8'), '# mine\n');
    fs.rmSync(dir, { recursive: true, force: true });
  }],
];
