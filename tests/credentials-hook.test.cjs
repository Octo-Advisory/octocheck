'use strict';
const assert = require('assert');
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
];
