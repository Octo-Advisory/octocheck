---
description: Run the next pending OctoCheck task, then stop and ask before continuing
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git hash-object:*), Bash(git rev-parse:*), Bash(date:*)
---

You are continuing an OctoCheck review. Never use Edit or Write on any file outside
`octocheck/`. Only read source files and record flags — never modify them.

**Default: stop after every task and wait for the user.** Only if the user explicitly runs
`/octocheck-continue --auto` (or clearly asks to run all remaining tasks without stopping)
may you move straight to the next pending task, and even then stop and ask on any `high`
flag, any blocked tool call, or a blast-radius question (Step 5). Never infer `--auto`.

## Data you maintain (all under `octocheck/cache/`)
**Graph entry** — one file per source file: `graph/<repo path with "/" replaced by "__">.json`,
single-line JSON:
`{"p":"app/a.py","h":"<git hash-object>","api":["get_User(id) -> dict; raises if missing"],`
`"uses":["app/d.py#round_off"],"reexp":[],"flags":[{"l":5,"r":"PY-2-01","s":"medium","n":"..."}],`
`"rev":"2026-10-05","del":false}`
- `api`: what OTHER files can rely on — each public function/class/export/DocType field as
  `name(params) -> return; <raises / side effects / odd cases, only if a caller must know>`.
  Terse and consistent from run to run: wording noise creates false changes.
- `uses`: `"<repo file path>#<symbol>"` for every cross-file reference, resolved to real repo
  paths (use Glob): imports, requires, Java imports; Frappe `frappe.call("a.b.fn")` and
  `hooks.py` dotted paths → `a/b.py#fn`; `frappe.get_doc/get_all/db.get_value("X")` → that
  DocType's `.json` path (`#doctype`, or `#<fieldname>` for field use).
- `reexp`: repo paths whose symbols this file passes through wholesale.
- `flags`: this file's known flags, including contract (`-C-`) flags.

**`meta.json`**: `{"last_run_commit":"<sha>","flow_flags":{"<flow>":[...]}}`.
**Config**: `octocheck.config.yaml` (`review_expiry_days` default 19, `blast_radius_limit`
default 25; `0`/`off` disables).

**Find dependents of symbol S in file P** (Grep over `octocheck/cache/graph/`, fixed strings,
skip `"del":true`): entries containing `"P#S"` are direct dependents. Also find pass-through
files Q with Grep `"reexp":\[[^]]*"P"`, then repeat for `"Q#S"`. Keep a visited list so loops
end. Follow no further than that.

## Step 1 — Load state
Read `progress.json`. If `approved` isn't `true`, tell the user to run `/octocheck-init` first.
Take the first task with `status: pending`. None left → go to Step 7. Read the config and run
`date +%F` once. Branch on the task's `type`: `review` → Step 2, `contract` → Step 3,
`flow` → Step 4.

## Step 2 — `review` task
1. **One call each, for the whole task:** `git hash-object <all task files>` (one hash per
   line, same order), and one Grep over `octocheck/cache/graph/` for
   `"p":"(path1|path2|...)"` to load their entries.
2. **Ignore empty files:** a hash of `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` is an empty
   file. Don't read it and don't create an entry; count it under "empty files ignored" in the
   final summary. Also ignore any file matching `skip_files` that slipped into a task.
   **Skip** a file when its entry exists, `h` matches, and it isn't expired (`rev` older than
   `review_expiry_days`). Don't read it. Queue its entry's `flags` for the report's
   "Not re-reviewed" section (list it even with no flags). Expired files are reviewed and noted
   "(review expired)".
3. **Review** every other file: read it and evaluate it against each active rule whose `stack`
   matches and whose factor isn't `C`. All checks are judgment — there is no static tool.
   Record `{file}:{line} — [{rule_id}] {severity} — {one-line description}`.
   - **Severity is locked to the value in the YAML** — never raise or lower it. Put context in
     the description instead.
   - If the old entry has contract (`-C-`) flags, re-check each one and keep those that still
     apply.
   - If the file uses a symbol listed in `progress.json` `changed`, also check that use with
     the stack's `C` rules (Step 3 method).
4. **Update the entry:** compute new `api`, `uses`, `reexp`; set `h`, `flags`, `rev` = today.
   Read the existing entry file first if it exists, then Write (new entries: just Write).
5. **Detect changed symbols:** compare old `api` with new. A symbol is changed if it was
   removed or renamed, its parameters changed, or a caller would notice a difference in what
   it returns or raises. Added symbols are not changes. Ignore wording-only differences. No old
   entry → nothing to compare.
6. If any changed: add `{"f":"<file>","syms":[...],"what":"<old → new, short>"}` to
   `changed`, then queue follow-up tasks (Step 5).

## Step 3 — `contract` task (only the contract check, not a full review)
For each file in the task, for each trigger: Grep the file for the symbol (or its import) to
find call sites, and Read only those regions (offset/limit), not the whole file. Using the
trigger's `what`, apply the stack's `C` rules: does this file still use the changed symbol
correctly (name exists, arguments, expected return shape, fields, import path, method-path
string)? Record flags as `{file}:{line} — [{rule_id}] {severity} — … (because {trigger file}
changed: {what})`. Add them to the file's entry `flags` (replace earlier C flags for the same
trigger), keeping its `h` and `rev`. Files with no problem are listed as "re-checked, no
contract issues".

## Step 4 — `flow` task
For the named flow, walk its files in order. For each consecutive pair, Read only the
functions on the hand-off (find them via the `uses` entries and Grep) and check the whole path
still holds: the call still exists, inputs match, what comes back is still what the next step
expects. Report breaks as `[FLOW-01]`, naming the step where it breaks. Store the result in
`meta.json` `flow_flags`.

## Step 5 — Queue follow-up tasks (after Step 2.6)
For each changed symbol, find dependents (see above). Then:
- One `contract` task per dependent file (merge triggers if a pending one exists). If the
  dependent still has a pending `review` task, skip it — Step 2.3 covers it there.
- Count dependents for this change. Above `blast_radius_limit`: **stop and ask**: "Changing
  {file} affects {N} files, above the limit of {limit}. 1) check all, 2) check only direct
  callers, 3) skip and list them in the report." Follow the answer. (Applies in `--auto` too.)
- If the changed file is on a declared flow with no `flow` task yet this run, add one.
Append new tasks to the end of `tasks`, with a `trigger` reason.

## Step 6 — Report and checkpoint
Append to `run_report_file` from `progress.json` (create it on the first task with a header:
date/time and the rule set `# version:` from `rules.core.yaml`). Under
`### Factor <N> — <name>` headings, grouped by file, add this task's new flags. **File each
flag under the factor of its own rule ID — never recategorize.** Contract flags go under
`### Factor C — Contract impact`, each file labelled with why it was re-checked. Flow breaks
go under `## Critical flows`.

Keep one running section at the end of the report:
```markdown
## Not re-reviewed this run (unchanged since last scan)
Skipped to save tokens. Flags below are carried forward from each file's last review, not
re-verified now.
**{file}** (last reviewed {rev})
- {file}:{line} — [{rule_id}] {severity} — {note}, carried forward
**{file}** — No known flags from last review.
```
Also list contract-checked files with no problem under "Re-checked, no contract issues".

Mark the task `done` in `progress.json` (write it back with the updated `changed`/`tasks`).
Then, unless `--auto`, stop and say exactly:

> "Task {n} of {total} complete — {flag count} flags found. Continue with Task {n+1}? (yes/no)"

(`{total}` includes tasks added during the run.) In `--auto`, report the same line without the
question and continue, except stop and ask on any `high` flag, a blocked tool call, or an
unresolved error.

## Step 7 — Run complete
Set `last_run_commit` in `meta.json` to `git rev-parse HEAD`. Give a short summary: tasks run,
flags by severity, files skipped, contract checks done, and the report path. Stop.