#!/usr/bin/env node
// OctoCheck installer. Works on Windows, macOS, and Linux without bash/WSL.
// Usage: npx github:Octo-Advisory/octocheck [target-directory]
// (or, after npm publish: npx octocheck [target-directory])

const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '..');
const targetDir = path.resolve(process.argv[2] || '.');

function fail(message) {
  console.error(`OctoCheck install failed: ${message}`);
  process.exit(1);
}

function copyFile(fromRelative, toRelative) {
  const from = path.join(sourceDir, fromRelative);
  const to = path.join(targetDir, toRelative);
  if (!fs.existsSync(from)) {
    fail(`expected source file missing: ${fromRelative} — this download looks incomplete or has a different layout than expected.`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  copied ${fromRelative} -> ${path.relative(process.cwd(), to)}`);
}

if (!fs.existsSync(targetDir)) {
  fail(`target directory does not exist: ${targetDir}`);
}
if (!fs.existsSync(path.join(targetDir, '.git'))) {
  console.warn(`Warning: ${targetDir} doesn't look like a git repo root (no .git found). Continuing anyway.`);
}

console.log(`Installing OctoCheck into ${targetDir}\n`);

copyFile('.claude/commands/octocheck-init.md', '.claude/commands/octocheck-init.md');
copyFile('.claude/commands/octocheck-continue.md', '.claude/commands/octocheck-continue.md');
copyFile('.claude/hooks/block-source-write.cjs', '.claude/hooks/block-source-write.cjs');
copyFile('.claude/hooks/block-credentials-read.cjs', '.claude/hooks/block-credentials-read.cjs');
copyFile('.claude/scripts/octocheck-site.cjs', '.claude/scripts/octocheck-site.cjs');
copyFile('.claude/scripts/octocheck-fetch.cjs', '.claude/scripts/octocheck-fetch.cjs');
copyFile('.claude/scripts/octocheck-schema.cjs', '.claude/scripts/octocheck-schema.cjs');
copyFile('.claude/scripts/bundle_schema_v1.json', '.claude/scripts/bundle_schema_v1.json');
copyFile('rules/rules.core.yaml', 'rules/rules.core.yaml');

const localRulesTarget = path.join(targetDir, 'rules.local.yaml');
if (!fs.existsSync(localRulesTarget)) {
  copyFile('rules/rules.local.yaml.example', 'rules.local.yaml');
} else {
  console.log('  rules.local.yaml already exists — left untouched');
}

const configTarget = path.join(targetDir, 'octocheck.config.yaml');
if (!fs.existsSync(configTarget)) {
  copyFile('octocheck.config.yaml.example', 'octocheck.config.yaml');
} else {
  console.log('  octocheck.config.yaml already exists — left untouched');
}

const gitignoreSnippet = fs.readFileSync(path.join(sourceDir, 'octocheck.gitignore.snippet'), 'utf8');
const gitignorePath = path.join(targetDir, '.gitignore');
const existingGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
if (!existingGitignore.includes('octocheck/cache/')) {
  fs.appendFileSync(gitignorePath, `\n${gitignoreSnippet}`);
  console.log('  appended OctoCheck entries to .gitignore');
} else {
  console.log('  .gitignore already has OctoCheck entries — left untouched');
}

console.log('\nHooks config (.claude/settings.hooks.json) was NOT auto-merged — settings.json');
console.log('is often already customized per project. Merge it in by hand:');
console.log(`  ${path.join(sourceDir, '.claude', 'settings.hooks.json')}`);
console.log('into your project\'s .claude/settings.json under the "hooks" key. It registers two hooks: the write guard and the');
console.log('credentials guard (needed only if you review Frappe sites; the site setup refuses to save a secret without it).\n');

console.log('Install complete. Next: open Claude Code in this repo and run /octocheck-init');