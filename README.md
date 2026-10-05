# OctoCheck

A read-only, LLM-based code review framework for [Claude Code](https://claude.com/claude-code).
Reviews Python, Java, frontend (HTML/CSS/JS), and Frappe code against a fixed, versioned rule
set, flags issues by file and line, and never modifies your source — enforced both by
instruction and by a hook that blocks Edit/Write outside its own working folder at the
process level, independent of the model's own compliance.

See `examples/sample-report.md` for what real output looks like.

## Why

Most AI code review either runs as an opaque CI check you can't inspect, or lives entirely in
a chat you have to re-explain each time. OctoCheck runs inside Claude Code, on your own
machine or CI runner, against a rule set you can read, version, and extend — and it plans its
work and asks for approval before touching anything, then checkpoints after every task so a
long review never runs away from you unsupervised unless you explicitly ask it to.

## Install

**Option A — one line, any OS, no bash/WSL required:**
```bash
npx github:Octo-Advisory/octocheck /path/to/your-repo
```

**Option B — clone + script (macOS/Linux/WSL/Git Bash):**
```bash
git clone https://github.com/Octo-Advisory/octocheck.git
bash octocheck-plugin/install.sh /path/to/your-repo
```

Either way, this:
- copies `.claude/commands/octocheck-init.md`, `.claude/commands/octocheck-continue.md`, and
  `.claude/hooks/block-source-write.cjs` into your repo
- copies `rules/rules.core.yaml` in, and drops a starter `rules.local.yaml` at the root if you
  don't already have one
- appends recommended entries to your `.gitignore` (safe to skip if you'd rather commit
  everything — see `octocheck.gitignore.snippet`)

**Then enable the hook** — not auto-merged, since your project's `.claude/settings.json` may
already be customized: open `.claude/settings.hooks.json` from this repo and merge its
`"hooks"` key into your project's `.claude/settings.json`. Without this step, read-only
enforcement still works via `allowed-tools`, just without the independent process-level
backstop.

## Use

1. Open Claude Code in your repo.
2. Run `/octocheck-init` — or `/octocheck-init main` to scope the whole review to just what's
   changed against a branch instead of the full codebase (much cheaper, since every check is
   LLM-based, not static).
   - It creates the `octocheck/` working folder.
   - It checks for `CLAUDE.md` — offers to create or refresh it, always asking permission
     first, and proceeds without one if you decline rather than stalling.
   - It writes `octocheck/plan.md`, a task-by-task breakdown of the review, and stops.
3. Read `octocheck/plan.md` and approve it (or ask for changes, then approve).
4. Run `/octocheck-continue`.
   - It runs exactly one task: reviews the files in scope against `rules.core.yaml` +
     `rules.local.yaml`, appends flags to `octocheck/reports/report-<date>.md`, and stops to
     ask before continuing.
   - Run `/octocheck-continue --auto` instead if you explicitly want it to keep going through
     every remaining task without stopping each time — it still stops immediately on any
     high-severity finding or blocked tool call. This is opt-in per run, never the default.
5. Keep running `/octocheck-continue` (or let `--auto` run) until it reports the review is
   complete.
6. Open `octocheck/reports/report-<date>.md` — flags grouped by factor, then file, then line,
   headed by the ruleset version that produced them.

## Customizing rules

- `rules/rules.core.yaml` — mandatory, factor IDs 1-7 plus `C` (contract impact) per stack, versioned. Don't edit this
  file directly in a project; it's meant to be updated centrally and re-installed. See
  `CONTRIBUTING.md` to propose a change.
- `rules.local.yaml` (repo root) — edit this freely for two things:
  - team-added rules, factor 8+
  - disabling a core rule that doesn't fit your project (`{ id: FE-6-01, disabled: true }`) —
    shows up in the report header, never silently dropped

See `rules/rules.local.yaml.example` for the exact syntax of both.

## Which files get re-checked

OctoCheck keeps a small map of who uses what (`octocheck/cache/graph/`, one file per source
file), built while it reviews. When a file changes, only the files that use the changed
function, field or export get a quick contract check — not a full review — and files on a
declared critical flow get traced end to end. Unchanged files are skipped and their earlier
flags are carried forward in the report. Two settings in `octocheck.config.yaml` tune this:
`review_expiry_days` (default 19) and `blast_radius_limit` (default 25); `0` or `off` disables
either.

Declare critical flows in `CLAUDE.md` (`/octocheck-init` will offer):
```
## Critical flows
- checkout: path/b.py → path/a.py → path/c.py
```

**Updating:** re-run the install command (clear npm's cache first, e.g.
`rm -rf ~/.npm/_npx && npx --yes github:Octo-Advisory/octocheck .`). Upgrading from 0.1.x: the
old `file-hashes.json` is ignored, so the first run re-reviews everything once to build the map.

## Design notes

- Every rule runs through LLM judgment — there's no static linter step in this build.
- Severity is locked to each rule's declared value in the YAML; it's never adjusted per
  instance, so reports stay comparable run to run and usable as a CI gate later.
- `git hash-object` fingerprints skip files unchanged since the last run to keep token use
  down; delete `octocheck/cache/` to force a full re-scan.
- `octocheck/progress.json` makes a review resumable — closing Claude Code mid-review and
  running `/octocheck-continue` again later picks up at the next pending task.
- Read-only is enforced twice: `allowed-tools` in each command's frontmatter restricts what
  the model can invoke, and `.claude/hooks/block-source-write.cjs` independently blocks any
  Edit/Write outside `octocheck/` at the process level once registered in settings.
- Non-interactive (`--auto`) mode is strictly opt-in per run — never inferred, and it still
  stops on anything high-severity or on an error.

## Contributing

See `CONTRIBUTING.md` — proposing new core rules, adding project-specific rules, and changing
the framework itself.

## License

MIT — see `LICENSE`.