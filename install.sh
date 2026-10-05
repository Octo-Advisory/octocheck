#!/usr/bin/env bash
# Installs OctoCheck into the target repo (defaults to the current directory).
# For Windows without WSL/Git Bash, use `npx github:Octo-Advisory/octocheck` instead —
# see bin/install.js, which does the same thing in a way that works everywhere.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

fail() {
  echo "OctoCheck install failed: $1" >&2
  exit 1
}

[ -d "$TARGET_DIR" ] || fail "target directory does not exist: $TARGET_DIR"
[ -f "$SOURCE_DIR/.claude/commands/octocheck-init.md" ] || fail "expected source file missing: .claude/commands/octocheck-init.md — this checkout looks incomplete or has a different layout than expected."

if [ ! -d "$TARGET_DIR/.git" ]; then
  echo "Warning: $TARGET_DIR doesn't look like a git repo root. Continuing anyway."
fi

echo "Installing OctoCheck into $TARGET_DIR"
echo

mkdir -p "$TARGET_DIR/.claude/commands" "$TARGET_DIR/.claude/hooks"
cp -v "$SOURCE_DIR/.claude/commands/octocheck-init.md" "$TARGET_DIR/.claude/commands/"
cp -v "$SOURCE_DIR/.claude/commands/octocheck-continue.md" "$TARGET_DIR/.claude/commands/"
cp -v "$SOURCE_DIR/.claude/hooks/block-source-write.cjs" "$TARGET_DIR/.claude/hooks/"

mkdir -p "$TARGET_DIR/rules"
cp -v "$SOURCE_DIR/rules/rules.core.yaml" "$TARGET_DIR/rules/"

if [ ! -f "$TARGET_DIR/rules.local.yaml" ]; then
  cp -v "$SOURCE_DIR/rules/rules.local.yaml.example" "$TARGET_DIR/rules.local.yaml"
else
  echo "  rules.local.yaml already exists — left untouched"
fi

if [ ! -f "$TARGET_DIR/octocheck.config.yaml" ]; then
  cp -v "$SOURCE_DIR/octocheck.config.yaml.example" "$TARGET_DIR/octocheck.config.yaml"
else
  echo "  octocheck.config.yaml already exists — left untouched"
fi

if ! grep -q "octocheck/cache/" "$TARGET_DIR/.gitignore" 2>/dev/null; then
  echo "" >> "$TARGET_DIR/.gitignore"
  cat "$SOURCE_DIR/octocheck.gitignore.snippet" >> "$TARGET_DIR/.gitignore"
  echo "  appended OctoCheck entries to .gitignore"
else
  echo "  .gitignore already has OctoCheck entries — left untouched"
fi

echo
echo "Hooks config (.claude/settings.hooks.json) was NOT auto-merged — settings.json"
echo "is often already customized per project. Merge it in by hand:"
echo "  $SOURCE_DIR/.claude/settings.hooks.json"
echo "into your project's .claude/settings.json under the \"hooks\" key."
echo
echo "Install complete. Next: open Claude Code in this repo and run /octocheck-init"