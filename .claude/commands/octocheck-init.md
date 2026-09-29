---
description: Initialize OctoCheck review for this repo — builds/refreshes CLAUDE.md and drafts a review plan for approval
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git status:*)
---

You are initializing OctoCheck, a read-only code review framework. You must never use an
Edit or Write tool on any file outside the `octocheck/` folder. You never modify application
source code — you only read it and record flags about it. If `.claude/hooks/block-source-write.cjs`
is registered in this project's settings, any accidental Edit/Write attempt outside `octocheck/`
is also blocked at the process level, independent of these instructions.

Follow these steps in order. Do not skip ahead, and stop exactly where told.

## Step 1 — Set up the working folder
If `octocheck/` does not exist at the repo root, create it with:
- `octocheck/plan.md`
- `octocheck/progress.json` (start as `{"tasks": [], "current": null, "approved": false}`)
- `octocheck/cache/file-hashes.json` (start as `{}`)
- `octocheck/reports/` (empty folder)

## Step 2 — Handle CLAUDE.md
Check the repo root for `CLAUDE.md`.
- **Missing:** tell the user you'd like to create one, explain briefly what it will contain
  (stack, folder structure, key modules, naming conventions you observe), and wait for a yes
  before writing it. Build it from a read-only scan of the repo — do not guess.
  - **If they decline:** don't stall or ask again. Proceed to Step 3 without a CLAUDE.md —
    build the plan directly from what you can read of the repo structure in this session
    instead. Note once in `plan.md` that no CLAUDE.md was available, so the user knows later
    tasks have less shared context than usual.
- **Present:** read it, then compare its description of the repo against the current folder
  structure and recently changed files (`git log --stat -20`). If it's stale, tell the user
  specifically what's out of date and ask permission before updating only those sections.
  Never rewrite sections that are still accurate.
  - **If they decline the refresh:** proceed with the existing CLAUDE.md as-is, noting in
    `plan.md` that it may be out of date in the areas you flagged.

## Step 3 — Load the rule set
Read `rules/rules.core.yaml` from this plugin (mandatory, every entry engine: llm) and, if
present, `rules.local.yaml` at the repo root (team additions and disables). For each entry:
- If it has `factor` 1-7 for its stack, discard it — those IDs are reserved for core rules
  and can't be redefined here.
- If it's `{ id: <core-id>, disabled: true }`, remove that core rule from the active set for
  this project. Record how many were disabled and which IDs, for the plan and report headers
  — a disabled rule is visible in the output, never silently dropped.
- Otherwise (factor 8+), add it to the active set as a team rule.

## Step 4 — Build the task plan
Split the codebase into small tasks, one per top-level folder or module, capped at roughly
15 files per task so each task's context stays bounded. For a task whose files changed
recently, prefer scoping it to just the `git diff` against the last reviewed commit (see
`octocheck/cache/file-hashes.json` once populated) rather than the whole folder.

If the user invoked this command with an argument naming a branch or commit (e.g.
`/octocheck-init main`), skip the full-repo split entirely: run `git diff --name-only
<that-ref>...HEAD` and build the whole plan from just those changed files, as a single task
if it's small enough or split only if it exceeds the 15-file cap. This is the fastest, cheapest
way to review a feature branch instead of the whole codebase.

Write `octocheck/plan.md` in this exact structure:

```markdown
# OctoCheck Review Plan — <date>

Ruleset: rules.core.yaml v<version> (<N> core rules disabled for this project: <ids, or "none">)

## Task 1: <folder/module name>
- Files: <count> (<path>, <path>, ...)
- Factors checked: <list of factor numbers relevant to this stack>
- Status: pending

## Task 2: <folder/module name>
...
```

Also write the same task list into `octocheck/progress.json` under `tasks`, each with
`{"id": 1, "name": "...", "files": [...], "status": "pending"}`.

## Step 5 — Stop and ask for approval
Show the user `octocheck/plan.md` and ask exactly this:

> "Here's the review plan — N tasks covering M files. Approve this plan? (yes/no)"

Do not run `/octocheck-continue` yourself and do not scan any file's content against the
rules yet. Wait for the user's explicit yes. If they say no, ask what to change and revise
the plan, then ask again.

On approval, set `"approved": true` in `octocheck/progress.json` and tell the user to run
`/octocheck-continue` to start Task 1.
