'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { shouldBlock } = require('../.claude/hooks/block-credentials-read.cjs');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-credentials-read.cjs');
const ENV = { HOME: '/home/sanket' };
const CWD = '/home/sanket/frappe-bench/apps/octocheck_connector';

const call = (tool_name, tool_input, cwd = CWD) => ({ tool_name, tool_input, cwd });
const blocked = (payload, env = ENV) => shouldBlock(payload, env);

function runHook(payload, env = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [HOOK], { input, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

module.exports = [
  ['blocks reading the credentials file by every route', async () => {
    const cases = [
      call('Read', { file_path: '/home/sanket/.config/octocheck/octocheck-credentials.json' }),
      call('Read', { file_path: '~/.config/octocheck/octocheck-credentials.json' }),
      call('Read', { file_path: '$HOME/.config/octocheck/octocheck-credentials.json' }),
      call('Bash', { command: 'cat ~/.config/octocheck/octocheck-credentials.json' }),
      call('Bash', { command: 'cat /home/sanket/.config/octocheck/*' }),
      call('Bash', { command: 'less "$HOME/.config/octocheck/x"' }),
      call('Grep', { pattern: 'secret', path: '~/.config/octocheck' }),
      call('Grep', { pattern: 'secret', path: '/home/sanket/.config' }),
      call('Grep', { pattern: 'secret', path: '~' }),
      call('Grep', { pattern: 'secret', path: '/home/sanket' }),
      call('Glob', { pattern: '**/octocheck-credentials*' }),
      call('Glob', { pattern: '*', path: '/home/sanket/.config/octocheck' }),
      call('Read', { file_path: '../../../.config/octocheck/octocheck-credentials.json' }),
      call('Read', { file_path: '/home/sanket/.config/../.config/octocheck/octocheck-credentials.json' }),
      call('Bash', { command: 'echo $OCTOCHECK_CREDENTIALS_DIR' }),
      call('Read', { file_path: '\\home\\sanket\\.config\\octocheck\\octocheck-credentials.json' }),
      call('Read', { file_path: '/HOME/SANKET/.CONFIG/OCTOCHECK/OCTOCHECK-CREDENTIALS.JSON' }),
    ];
    for (const c of cases) assert.ok(blocked(c), `should block: ${JSON.stringify(c.tool_input)}`);
  }],

  ['allows normal OctoCheck work', async () => {
    const cases = [
      call('Read', { file_path: 'octocheck/progress.json' }),
      call('Read', { file_path: '/home/sanket/frappe-bench/apps/octocheck_connector/octocheck/cache/sites/test/state.json' }),
      call('Grep', { pattern: 'frappe.call', path: 'octocheck/cache' }),
      call('Grep', { pattern: 'secret' }),
      call('Glob', { pattern: '**/*.py' }),
      call('Bash', { command: 'git diff --name-status' }),
      call('Bash', { command: 'node .claude/scripts/octocheck-site.cjs fetch --site test' }),
      call('Read', { file_path: 'rules/rules.core.yaml' }),
      call('Read', { file_path: '/home/sanket/frappe-bench/apps/octocheck_connector/octocheck.sites.json' }),
      call('Write', { file_path: 'octocheck/reports/report-2026-10-09.md', content: 'ok' }),
      call('Read', { file_path: '/home/sanket/.bashrc' }),
      call('Read', { file_path: '/home/sanket/.config/other-app/settings.json' }),
    ];
    for (const c of cases) assert.ok(!blocked(c), `should allow: ${JSON.stringify(c.tool_input)}`);
  }],

  ['follows a custom credentials folder from the environment', async () => {
    const env = { HOME: '/home/sanket', OCTOCHECK_CREDENTIALS_DIR: '/srv/secrets/octo' };
    assert.ok(blocked(call('Read', { file_path: '/srv/secrets/octo/anything.json' }), env));
    assert.ok(blocked(call('Grep', { pattern: 'x', path: '/srv/secrets' }), env));
    assert.ok(!blocked(call('Read', { file_path: '/srv/other/file.json' }), env));
  }],

  ['works as a separate process: exit 2 with a message to block, 0 to allow', async () => {
    const bad = runHook(call('Read', { file_path: '~/.config/octocheck/octocheck-credentials.json' }), { HOME: '/home/sanket' });
    assert.strictEqual(bad.status, 2);
    assert.ok(bad.stderr.includes('keeps API secrets away from Claude'));
    assert.ok(bad.stderr.includes('rotate'));
    const good = runHook(call('Read', { file_path: 'octocheck/plan.md' }), { HOME: '/home/sanket' });
    assert.strictEqual(good.status, 0);
    assert.strictEqual(good.stderr, '');
  }],

  ['fails closed on input it cannot read', async () => {
    for (const garbage of ['', 'not json', '{"tool_name":']) {
      const r = runHook(garbage);
      assert.strictEqual(r.status, 2, JSON.stringify(garbage));
      assert.ok(r.stderr.includes('could not parse'));
    }
  }],

  ['also reads the camelCase payload shape the write guard accepts', async () => {
    assert.ok(blocked({ toolName: 'Read', toolInput: { filePath: '~/.config/octocheck/octocheck-credentials.json', file_path: '~/.config/octocheck/x' } }));
    assert.ok(blocked({ toolName: 'Bash', toolInput: { command: 'cat ~/.config/octocheck/octocheck-credentials.json' } }));
  }],

  ['the settings snippet registers both hooks with the right matchers', async () => {
    const cfg = require('../.claude/settings.hooks.json');
    const entries = cfg.hooks.PreToolUse;
    const byCommand = (name) => entries.find((e) => e.hooks.some((h) => h.command.includes(name)));
    const write = byCommand('block-source-write.cjs');
    const creds = byCommand('block-credentials-read.cjs');
    assert.ok(write && creds, 'a hook is missing from settings.hooks.json');
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(new RegExp(`(^|\\|)${tool}(\\||$)`).test(creds.matcher), `credentials guard does not cover ${tool}`);
    }
    assert.strictEqual(write.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  }],

  ['the hook commands find their files through the project folder and fail closed', async () => {
    const cfg = require('../.claude/settings.hooks.json');
    for (const entry of cfg.hooks.PreToolUse) {
      for (const h of entry.hooks) {
        assert.ok(h.command.includes('"$CLAUDE_PROJECT_DIR/.claude/hooks/'), `not tied to the project folder: ${h.command}`);
        assert.ok(h.command.endsWith('|| exit 2'), `does not block when the hook cannot run: ${h.command}`);
        assert.ok(!/^node \.claude\//.test(h.command), 'a path relative to the current folder breaks when the shell changes folder');
      }
    }
  }],
  ['both guards still work, and still block, when the shell is in a sub-folder or the hook cannot run', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'octocheck-hookproj-'));
    const hooksDir = path.join(project, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const f of ['block-source-write.cjs', 'block-credentials-read.cjs']) fs.copyFileSync(path.join(__dirname, '..', '.claude', 'hooks', f), path.join(hooksDir, f));
    const deep = path.join(project, 'octocheck', 'cache', 'sites', 'x', 'bundles');
    fs.mkdirSync(deep, { recursive: true });
    const cfg = require('../.claude/settings.hooks.json').hooks.PreToolUse;
    const command = (name) => cfg.find((e) => e.hooks[0].command.includes(name)).hooks[0].command;
    const run = (name, payload, projectDir = project, cwd = deep) => spawnSync('sh', ['-c', command(name)], {
      cwd, input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/home/sanket', CLAUDE_PROJECT_DIR: projectDir },
    });
    const outside = { tool_name: 'Write', tool_input: { file_path: path.join(project, 'src', 'app.py') }, cwd: deep };
    const inside = { tool_name: 'Write', tool_input: { file_path: path.join(project, 'octocheck', 'cache', 'sites', 'x', 'results', 'task-1.json') }, cwd: deep };
    const creds = { tool_name: 'Read', tool_input: { file_path: '~/.config/octocheck/octocheck-credentials.json' }, cwd: deep };
    assert.strictEqual(run('block-source-write', outside).status, 2, 'a write outside octocheck/ is blocked from a sub-folder');
    assert.strictEqual(run('block-source-write', inside).status, 0, 'a write inside octocheck/ is allowed from a sub-folder');
    assert.strictEqual(run('block-credentials-read', creds).status, 2, 'reading the credentials file is blocked from a sub-folder');
    assert.strictEqual(run('block-credentials-read', inside).status, 0);
    // A hook that cannot run must block, not wave the call through.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'octocheck-nohook-'));
    assert.strictEqual(run('block-source-write', inside, empty).status, 2, 'missing write guard blocks');
    assert.strictEqual(run('block-credentials-read', inside, empty).status, 2, 'missing credentials guard blocks');
    // What the old relative command did from a sub-folder: it failed with code 1, which does not block.
    const old = spawnSync('sh', ['-c', 'node .claude/hooks/block-source-write.cjs'], { cwd: deep, input: JSON.stringify(outside), encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.ok(old.status !== 0 && old.status !== 2, `the old form failed open (status ${old.status})`);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }],
];
