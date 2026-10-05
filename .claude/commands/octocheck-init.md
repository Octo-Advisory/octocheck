---
description: Initialize OctoCheck review for this repo — builds/refreshes CLAUDE.md and drafts a review plan for approval
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git rev-parse:*), Bash(date:*)
---

You are initializing OctoCheck, a read-only code review framework. Never use Edit or Write on
any file outside `octocheck/`. Never modify application source — only read it and record flags.
If `.claude/hooks/block-source-write.cjs` is registered in this project's settings, any
Edit/Write outside `octocheck/` is also blocked at the process level.

Follow these steps in order. Stop exactly where told. Keep reads minimal: this command plans,
it does not review code.

## Step 1 — Working folder
If `octocheck/` is missing, create: `octocheck/plan.md`, `octocheck/progress.json`, `octocheck/reports/`.
Every run (new or existing folder) starts `progress.json` fresh as:
`{"tasks":[],"approved":false,"run_report_file":null,"changed":[],"flows":[]}`.
Do not touch `octocheck/cache/` — it persists across runs (per-file graph entries in
`cache/graph/`, run info in `cache/meta.json`). Ignore a leftover `cache/file-hashes.json` from
an older version: its files simply get fully reviewed once so the new graph can be built.

## Step 2 — CLAUDE.md
Check the repo root for `CLAUDE.md`.
- **Missing:** say you'd like to create one (stack, folder structure, key modules, naming
  conventions, and optionally critical flows), and wait for a yes. Build it from a read-only
  scan — do not guess. If they decline, continue without it and note once in `plan.md` that
  later tasks have less shared context.
- **Present:** compare it with the current folder structure and `git log --stat -20`. If stale,
  say specifically what's out of date and ask permission before updating only those sections.
  If they decline, continue with it as-is and note in `plan.md` that it may be outdated.
- **Critical flows (optional):** when creating or refreshing CLAUDE.md, ask once whether to
  declare critical flows (paths where a break would hurt most). Format, one per line:
  ```
  ## Critical flows
  - checkout: path/b.py → path/a.py → path/c.py → path/d.py
  ```
  Never invent flows; only record ones the user states.

## Step 3 — Rules and settings
Read `rules/rules.core.yaml` (all `engine: llm`) and, if present, `rules.local.yaml`. For each
local entry:
- `factor` 1-7 or `C` for its stack → discard (reserved for core rules).
- `{ id: <core-id>, disabled: true }` → remove that core rule for this project; record the IDs
  for the plan header (a disabled rule is visible in output, never silently dropped).
- Otherwise (factor 8+) → add as a team rule.

Read `octocheck.config.yaml` if present. Settings (defaults if the file or key is missing):
`review_expiry_days: 19`, `blast_radius_limit: 25`. A value of `0` or `off` disables that
setting. Copy the effective values into `plan.md`'s header.

## Step 4 — Deleted files since the last run
If `octocheck/cache/meta.json` has `last_run_commit`, run
`git diff --name-status --diff-filter=D <last_run_commit>` (covers committed and uncommitted
deletions). For each deleted path that has an entry in `octocheck/cache/graph/`:
- Find its dependents with Grep over `octocheck/cache/graph/` for the fixed string `"<path>#`
  (skip entries with `"del":true`). Each dependent file gets a `contract` task (see Step 5)
  with trigger `{"f":"<path>","syms":["*"],"what":"file deleted"}`; merge triggers into one
  task per dependent file.
- Mark the deleted file's entry `"del":true` (Read it, then Write it back).

## Step 5 — Build the task plan
Split the codebase into `review` tasks, one per top-level folder or module, capped at about 15
files each so context stays bounded. Files unchanged since the last run are skipped cheaply
during execution (`/octocheck-continue` compares hashes), so list every file; don't pre-filter.

If the user passed a branch or commit (e.g. `/octocheck-init main`), skip the full split: run
`git diff --name-only <ref>...HEAD` and build the plan from only those files (one task, or
split by the 15-file cap).

Task shape in `progress.json`:
`{"id":1,"type":"review","name":"...","files":[...],"status":"pending"}`. Contract tasks from
Step 4 look like `{"id":n,"type":"contract","name":"Contract: <file>","files":["<file>"],
"triggers":[...],"status":"pending"}`.

Flows: copy each flow from CLAUDE.md into `progress.json` `flows` as
`{"name":"checkout","files":["path/b.py","path/a.py",...]}`.

Generate the report timestamp once, now (`date +%Y-%m-%d-%H%M%S` if unsure) and store
`"run_report_file":"octocheck/reports/report-<timestamp>.md"` in `progress.json`. Every task
this run writes to that exact file, so two runs never mix, even on the same day.

Write `octocheck/plan.md`:

```markdown
# OctoCheck Review Plan — <date>

Ruleset: rules.core.yaml v<version> (<N> core rules disabled: <ids or "none">)
Settings: review expiry <N days|off>, blast-radius limit <N files|off>
Report will be written to: octocheck/reports/report-<timestamp>.md
Critical flows: <names, or "none declared">

## Task 1: <folder/module>
- Type: review
- Files: <count> (<paths>)
- Status: pending

(Contract and flow tasks are added automatically while the review runs, when a changed
file affects other files. They appear in progress.json and in the report with the reason.)
```

## Step 6 — Approval
Show `plan.md` and ask exactly:

> "Here's the review plan — N tasks covering M files. Approve this plan? (yes/no)"

Do not review any file's content yet. Wait for an explicit yes; if no, ask what to change,
revise, ask again. On approval set `"approved": true` and tell the user to run
`/octocheck-continue`.