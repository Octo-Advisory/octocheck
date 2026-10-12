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
  '.claude/commands/octocheck-init.md', '.claude/commands/octocheck-continue.md',
  '.claude/hooks/block-source-write.cjs', '.claude/hooks/block-credentials-read.cjs',
  '.claude/scripts/octocheck-site.cjs', '.claude/scripts/octocheck-fetch.cjs',
  '.claude/scripts/octocheck-schema.cjs', '.claude/scripts/bundle_schema_v1.json',
  '.claude/scripts/octocheck-tasks.cjs', '.claude/scripts/octocheck-review.cjs', '.claude/scripts/octocheck-rules.cjs',
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


  ['both installers warn when the project still has the old relative hook commands, and stay quiet when it has the new ones', async () => {
    const hasBash = !spawnSync('bash', ['--version'], { encoding: 'utf8' }).error;
    const installers = [(dir) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), dir], { encoding: 'utf8' })]
      .concat(hasBash ? [(dir) => spawnSync('bash', [path.join(ROOT, 'install.sh'), dir], { encoding: 'utf8' })] : []);
    for (const install of installers) {
      const oldDir = target();
      fs.mkdirSync(path.join(oldDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node .claude/hooks/block-source-write.cjs' }] }] } }));
      const warned = install(oldDir);
      assert.strictEqual(warned.status, 0, warned.stderr);
      assert.ok(warned.stdout.includes('WARNING: .claude/settings.json uses the OLD hook commands'), warned.stdout);
      assert.ok(warned.stdout.includes('$CLAUDE_PROJECT_DIR'), warned.stdout);
      const newDir = target();
      fs.mkdirSync(path.join(newDir, '.claude'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, '.claude', 'settings.hooks.json'), path.join(newDir, '.claude', 'settings.json'));
      const quiet = install(newDir);
      assert.ok(!quiet.stdout.includes('WARNING'), quiet.stdout);
      fs.rmSync(oldDir, { recursive: true, force: true });
      fs.rmSync(newDir, { recursive: true, force: true });
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
