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

mkdir -p "$TARGET_DIR/.claude/commands" "$TARGET_DIR/.claude/hooks" "$TARGET_DIR/.claude/scripts"
cp -v "$SOURCE_DIR/.claude/commands/octocheck-init.md" "$TARGET_DIR/.claude/commands/"
cp -v "$SOURCE_DIR/.claude/commands/octocheck-continue.md" "$TARGET_DIR/.claude/commands/"
cp -v "$SOURCE_DIR/.claude/commands/octocheck-connect.md" "$TARGET_DIR/.claude/commands/"
cp -v "$SOURCE_DIR/.claude/settings.hooks.json" "$TARGET_DIR/.claude/"
cp -v "$SOURCE_DIR/.claude/hooks/block-source-write.cjs" "$TARGET_DIR/.claude/hooks/"
cp -v "$SOURCE_DIR/.claude/hooks/block-credentials-read.cjs" "$TARGET_DIR/.claude/hooks/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-site.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-fetch.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-schema.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-tasks.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-review.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-report.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-rules.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/octocheck-hooks.cjs" "$TARGET_DIR/.claude/scripts/"
cp -v "$SOURCE_DIR/.claude/scripts/bundle_schema_v1.json" "$TARGET_DIR/.claude/scripts/"

mkdir -p "$TARGET_DIR/rules"
cp -v "$SOURCE_DIR/rules/rules.core.yaml" "$TARGET_DIR/rules/"
cp -v "$SOURCE_DIR/rules/rules.ui-scripts.yaml" "$TARGET_DIR/rules/"

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
# Register the write guard and the credentials guard in .claude/settings.json, keeping the team's
# other settings. The hooks themselves need Node, so Node is expected here too.
if command -v node >/dev/null 2>&1; then
  if node "$SOURCE_DIR/.claude/scripts/octocheck-hooks.cjs" "$TARGET_DIR"; then
    echo "If Claude Code is already open in this project, exit it and start it again so the hooks load."
  fi
else
  echo "Node.js was not found, so the hooks were not registered. Install Node.js (LTS), then run this"
  echo "installer again, or add the \"PreToolUse\" entries from .claude/settings.hooks.json to .claude/settings.json."
fi
echo
for f in settings.json settings.local.json; do
  if grep -qs 'node \.claude/hooks/' "$TARGET_DIR/.claude/$f"; then
    echo "WARNING: .claude/$f uses the OLD hook commands (\"node .claude/hooks/...\"). Those stop working"
    echo "whenever Claude changes folder, and a hook that cannot run does NOT block anything. Replace them with the"
    echo "commands in .claude/settings.hooks.json (they start with node \"\$CLAUDE_PROJECT_DIR\"/... and end with || exit 2)."
    echo
  fi
done

echo "Install complete. Next: open Claude Code in this repo and run /octocheck-init"
echo "To review a Frappe site's UI scripts: run /octocheck-connect in Claude Code and approve it in your browser."