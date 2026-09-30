---
description: Run the next pending OctoCheck task, then stop and ask before continuing
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git hash-object:*)
---

You are continuing an OctoCheck review. You must never use an Edit or Write tool on any file
outside the `octocheck/` folder. You only read source files and record flags — never modify them.

**Default behavior is unchanged: stop after every task and wait for the user.** Only if the
user explicitly invokes this command as `/octocheck-continue --auto` (or says something
equivalent like "run all remaining tasks without stopping") should you skip the per-task
checkpoint and move straight to the next pending task after finishing one — still stopping
immediately, and reverting to asking, the moment you hit a task with high-severity flags, or
if any tool call is blocked/denied. Never infer `--auto` from context or from the user seeming
busy — it only applies when asked for, once, for that run.

## Step 1 — Load state
Read `octocheck/progress.json`. If `"approved"` is not `true`, stop and tell the user to run
`/octocheck-init` and approve the plan first. Otherwise find the first task with
`"status": "pending"`. If there is none, tell the user the review is complete and point them
to the latest file in `octocheck/reports/`.

## Step 2 — Skip unchanged files, but carry forward what's already known
For each file in the task, run `git hash-object <path>` to get its current blob hash, and
compare it against the `"hash"` value stored for that path in `octocheck/cache/file-hashes.json`
(entries there look like `{"path": {"hash": "...", "known_flags": [...]}}`). If they match:
- Skip the file entirely — do not read its contents. This is the token-saving step; a file
  that hasn't moved since the last run costs zero tokens to re-check.
- But do NOT skip it in the report. Carry its stored `known_flags` (if any) into this run's
  report under the "Not re-reviewed this run" section (see Step 4) — an old flag must never
  just vanish because its file wasn't touched. If `known_flags` is empty, still list the file
  there with "No known flags from last review," so the report is explicit about what wasn't
  re-checked rather than silent about it.

If the hash doesn't match (file changed or is new), proceed to Step 3 to actually review it.

## Step 3 — Review the remaining files
For every file that changed or is new, read it and evaluate it against every rule in
`rules.core.yaml` (and `rules.local.yaml`) whose `stack` matches that file's language and
whose `factor` was listed for this task in `plan.md`. Every check is a judgment call — reason
about the code directly, there is no static tool to fall back on. For each violation found,
record:

```
{file}:{line} — [{rule_id}] {severity} — {one-line description of what's wrong here}
```

**Severity is locked to the rule's declared value in rules.core.yaml / rules.local.yaml —
never raise or lower it based on context.** If the surrounding code genuinely changes how much
the issue matters (e.g. a missing test on a trivial data-only class vs. a missing test on
critical business logic), say so in the description text, but the `{severity}` field itself
always matches what that rule ID declares. This keeps severity comparable across runs and
usable as a CI gate later.

## Step 4 — Append to the report
Read `"run_report_file"` from `progress.json` — that exact path (set once by `/octocheck-init`
at the start of this run, e.g. `octocheck/reports/report-2026-09-30-143805.md`) is where every
task in this run writes, never recomputed per task. On the first task of the run, create it
starting with a header naming the date/time and the `# version:` value read from the top of
`rules.core.yaml` (see `templates/report.md.template`), so every report is traceable to the
exact rule set that produced it. Append this task's freshly-found flags under a `### Factor <N>
— <name>` heading per factor, grouped further by file, matching the format used across all
prior tasks so the file merges into one consistent document as tasks complete.

**The factor heading a flag is filed under must always be the factor number of its own rule
ID — never recategorize by judgment.** `PY-7-02` is a Factor 7 rule; it goes under `### Factor
7 — Optimize` even if the specific instance also touches on org standards or anything else. If
a rule's ID and its factor genuinely seem mismatched, that's a rules.core.yaml issue to flag
separately — the report itself must stay mechanically consistent with the rule's declared
factor.

At the very end of the report (after every task's factor sections), maintain one running
section for the whole run:

```markdown
## Not re-reviewed this run (unchanged since last scan)

These files weren't edited since the last review, so they were skipped to save tokens — the
flags below are carried forward from the last time each file was actually checked, not
re-verified this run.

**{file path}** (last reviewed {date from the cache entry, if available})
- {file}:{line} — [{rule_id}] {severity} — {note}, carried forward from a prior run
```

Append each Step-2-skipped file here as its task completes, so by the end of the run this
section covers every file that was skipped across all tasks, not just the last one.

## Step 5 — Update state and checkpoint
Mark this task `"status": "done"` in `progress.json`. For each file actually reviewed this
task (Step 3, not skipped), update its entry in `cache/file-hashes.json` to
`{"hash": "<new hash>", "known_flags": [<this run's flags for that file, or [] if none>],
"last_reviewed": "<today's date>"}` — this replaces whatever was there before, since it
reflects a fresh check. For files skipped in Step 2, leave their cache entry untouched.

Then, unless running in `--auto` mode (see above), stop and tell the user exactly:

> "Task {n} of {total} complete — {flag count} flags found. Continue with Task {n+1}? (yes/no)"

Do not start the next task yourself. Wait for the user to run `/octocheck-continue` again or
reply yes.

In `--auto` mode, instead report the same line without the question, then immediately start
the next pending task in the same turn — except stop and ask as normal if this task produced
any `high` severity flag, or if a task hit an unresolved error (e.g. a blocked tool call).
When every task is done, report a final summary and stop regardless of mode.