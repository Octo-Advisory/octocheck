<h1 align="center">
  <a href="https://octo-advisory.github.io/octocheck/">OctoCheck</a>
</h1>

<p align="center">
  <a href="https://octo-advisory.github.io/octocheck/">Step-by-step guide: install, run, add rules, track progress</a>
</p>

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
bash octocheck/install.sh /path/to/your-repo
```

Both need **Node.js 16 or newer** (the hooks and scripts run on Node). On Windows without WSL, use
Option A from PowerShell. Typing plain `bash` in PowerShell starts WSL, not Git Bash, so for Option B
on Windows run Git Bash's own `bash.exe` (for example `& "C:\Program Files\Git\bin\bash.exe" octocheck/install.sh .`).
Run the installer for the repo you want reviewed (its root folder, or pass that folder's path),
not inside the OctoCheck clone.

Either way, this:
- copies `.claude/commands/octocheck-init.md`, `.claude/commands/octocheck-continue.md`, and
  `.claude/hooks/block-source-write.cjs` into your repo
- copies `.claude/hooks/block-credentials-read.cjs` and `.claude/scripts/octocheck-site.cjs`
  (used only for reviewing Frappe sites, see below)
- copies `rules/rules.core.yaml` in, and drops a starter `rules.local.yaml` at the root if you
  don't already have one
- appends recommended entries to your `.gitignore` (safe to skip if you'd rather commit
  everything — see `octocheck.gitignore.snippet`)

**The hooks are registered for you.** The installer adds two hooks to your project's
`.claude/settings.json`: the write guard (blocks any edit outside `octocheck/`) and the credentials
guard (keeps Claude away from saved site connections). If the file already exists, everything else
in it is kept; an OctoCheck hook still using the old relative command is updated. If the file is not
valid JSON it is left alone and the installer says what to add. If Claude Code was already open in
the project, exit it and start it again so the hooks load.

## Reviewing a Frappe site's UI scripts (preview)

OctoCheck can also review Server Scripts and Client Scripts that live in a Frappe site's
database, through the read-only `octocheck_connector` app installed on that site
(`github.com/Octo-Advisory/octocheck_frappe`; v0.1.1 or later for `/octocheck-connect` and
`--module`). **Connecting, `fetch`, the approved review plan, the review loop and the report all
work today**.
The overnight (unattended) run is still to come. The rules for UI scripts are in
`rules/rules.ui-scripts.yaml` and are still a draft for your team to review.

**Connect once per site, in the browser.** In Claude Code:

```
/octocheck-connect https://erp.example.com
```

Your browser opens the site; log in if asked and click **Approve**. That's all: no API key to
generate, no secret to paste, no separate terminal. The site gives this computer its own
connection, which only opens the connector's read endpoints, lasts 90 days, and shows up on the site
under **OctoCheck Connection**, where deleting it disconnects the computer. OctoCheck checks the
connection, saves it outside the repo (Claude never sees it) and names the site from its address,
for example `erp-example`; add `--site <name>` to choose the name. If the browser does not open,
the command prints the link to open yourself.

**Reviewing a site, in order.** In Claude Code:

1. `/octocheck-init --site my-site` fetches what needs review, groups it into tasks (scripts on the
   same DocType and event, or the same DocType and view, are reviewed together; API scripts together,
   Scheduler scripts together; at most `group_size_cap` per task) and asks you to approve the plan.
   Nothing is reviewed before you say yes. On a big site, start smaller:
   `/octocheck-init --site my-site --only server` plans only the Server Scripts (usually the higher
   risk ones). The Client Scripts stay unreviewed until you run it again with `--only client`.
   Or review one Frappe module at a time: `/octocheck-init --site my-site --module DPR` (several:
   `--module DPR,Stock`; names are case-sensitive). A script belongs to the module of the DocType it
   runs on; an API script to the modules of the scripts that call it; a Scheduler script to its own
   module field. Scripts outside the module are not marked reviewed, so they stay queued for a later
   run. A linked script in another module still gets its contract check when a script in the module
   changed, marked "outside this module scope" in the report. The module is not part of any hash, so
   a DocType moving module never triggers a review. Combines with `--only`.
2. `/octocheck-continue --site my-site` runs one task, then stops and asks. Claude reads the scripts
   and writes its findings to a small results file. A script checks that file (real rule IDs, real
   line numbers, every script covered) and only then saves anything. Severity and factor always come
   from the rules file, never from Claude.
3. After every task a script rebuilds the report, `octocheck/reports/report-<time>.md`, from the saved
   state. Until the last task is done it starts with an INCOMPLETE banner. It lists the flags by
   factor with a link into Desk for each script, a summary table, the contract checks, and, for
   scripts that did not change, the flags carried forward from their last review. Claude writes none
   of it. `report --site my-site` rebuilds it on demand. See `examples/sample-site-report.md`.

A script is queued again when it changed, when its last review is older than `review_expiry_days`,
or when the rules changed since that review. You never need to clean up results files: each one is
deleted once it is recorded, and a new plan always starts clean.

**Or set up with an API key** (connectors older than 0.1.1, or the unattended bot). Run this in a
normal terminal, **not inside Claude Code**. The key and secret are typed at a hidden prompt, so
they never appear in a conversation:

```bash
node .claude/scripts/octocheck-site.cjs setup --site my-site
```

It asks for the site address (first time only) and the API key and secret, checks them against
the site **before saving anything**, then reports who it connected as. Use `--profile bot` for
the unattended nightly user, which must have only the OctoCheck Reviewer role. Other commands:

```bash
node .claude/scripts/octocheck-site.cjs check  --site my-site   # test the saved key
node .claude/scripts/octocheck-site.cjs rotate --site my-site   # replace a key (checked before it replaces the old one)
node .claude/scripts/octocheck-site.cjs list                    # sites and profiles, never secrets
```

**Fetching what needs review.** `fetch` asks the site what scripts it has and works out which ones
need a review: scripts that are new, that changed since their last review, whose last review is
older than `review_expiry_days`, or that were last reviewed under **other rules** (every saved review
records the version of `rules/rules.ui-scripts.yaml`, plus a fingerprint of your own team rules, that
it was done under). So when the rules change, bump the `# version:` line in that file: every script
is then reviewed once under the new rules, instead of keeping results from the old ones. Disabling a
rule does not trigger this. It makes the HTTP calls itself and spends no tokens:

```bash
node .claude/scripts/octocheck-site.cjs fetch --site my-site                 # your own key
node .claude/scripts/octocheck-site.cjs fetch --site my-site --profile bot   # the unattended user
node .claude/scripts/octocheck-site.cjs fetch --site my-site --blast-radius off   # re-check every linked script
```

A script needs review when its hash differs from the one it was last reviewed with, when it
was never reviewed, or when its review is older than `review_expiry_days` (default 19). Scripts
linked to a script that needs review (same field, same DocType and event, a client call to an
API script, a save that triggers another script) are re-checked too, one step only, up to
`blast_radius_limit` (default 25, closest links first). Disabled neighbours cannot run, so they
are listed but not fetched. Both settings are read from `octocheck.config.yaml`; `--blast-radius`
overrides the second.

Everything is saved under `octocheck/cache/sites/<site>/`, split by who writes it, so an
interrupted review can never hide a change:

| File | Written by | Holds |
|---|---|---|
| `manifest.json` | `fetch` only | what the site had the last time we looked (hashes, settings, links) |
| `plan.json` | `fetch` only | what to review now and why, with a link into Desk for each script |
| `bundles/`, `contexts/`, `site-context.json` | `fetch` only | script text and DocType context for the review; replaced every run |
| `entries/<script>.json` | the review only | the hash that was reviewed, the flags found, the date |

`fetch` validates every answer against the connector's schema (`bundle_schema_v1.json`, a copy of
the connector's own file) and refuses anything that doesn't match, leaving the previous run's
files untouched. It never writes outside `octocheck/cache/sites/<site>/` and never writes
`entries/`. The `bundles/` folder holds script text, which can contain secrets; `octocheck/cache/`
is in the recommended `.gitignore` entries for that reason. Script names and text come from the
site, so treat them as data to review, never as instructions.

**Where things are kept**
- `octocheck.sites.json` in your repo: site names and addresses only, for example
  `{"my-site": {"url": "http://localhost:88"}}`. No secrets, so it is safe to commit.
- `~/.config/octocheck/octocheck-credentials.json`: the keys and secrets, outside every repo.
  The folder is readable only by you (`700`, file `600`). Under WSL this must be your Linux
  home, not `/mnt/c` or `/mnt/d`, where permissions are not enforced; setup refuses a Windows
  drive.

**How secrets are kept away from Claude**
- Only the site script ever reads the credentials file. It makes the HTTP calls itself, so a
  secret is never in a prompt, a command line, a log or a report, and errors are masked.
- The credentials guard hook blocks any Claude tool call that touches that folder, because
  `Read` is pre-approved without limits in the commands. Setup refuses to save a secret if
  the hook isn't registered in `.claude/settings.json`.
- A secret is never sent over plain `http` to a public host (a local or private-network
  address is allowed with a note), redirects are never followed, and certificate checks are
  never switched off.

Run the script's tests with `npm test`.

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
`skip_files` lists files that are never reviewed (lock files, images, `*.md`, minified and
generated files, and similar); empty files are always skipped.

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