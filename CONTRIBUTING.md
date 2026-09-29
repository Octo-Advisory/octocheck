# Contributing to OctoCheck

The rule set is the core of this project and is expected to grow. Here's how to propose a
change to it, and how to change anything else.

## Proposing a new core rule

Core rules (`rules/rules.core.yaml`) apply to every project that installs OctoCheck, so they
go through review — this isn't the place for something specific to your team's codebase (see
"Project-specific rules" below for that).

1. Open an issue first, not a PR. Describe: which stack it applies to, what the violation
   looks like concretely (a short code snippet is ideal), why it's worth checking for across
   projects generally rather than just yours, and a suggested severity (`high` / `medium` /
   `low`).
2. If it's accepted, submit a PR adding the entry to `rules/rules.core.yaml`:
   - `id`: `<STACK>-<factor>-<NN>` — reuse an existing factor number (1-7) if the rule fits
     one of the seven categories already defined; propose a new factor only with strong
     justification, since factor numbers are meant to stay stable across the whole rule set.
   - `engine`: `llm` — this build has no static-tooling path (see README's design notes).
   - Bump the `version:` comment at the top of the file (patch version for a rule addition,
     minor for a new factor, major for anything that changes existing rule IDs or removes
     rules).
3. Include a short test case in your PR description — a code snippet that should trigger the
   rule and one that shouldn't (a near-miss) — so reviewers can sanity-check the description
   is specific enough for an LLM to apply consistently.

## Project-specific rules

These don't need a PR here at all — add them directly to your own project's
`rules.local.yaml`, factor 8+. See `rules/rules.local.yaml.example` for the syntax, including
how to disable a core rule that doesn't fit your project.

## Changing the framework itself

For anything in `.claude/commands/`, `.claude/hooks/`, `bin/install.js`, or `install.sh`:

- Open an issue describing the problem before a large change — these files are what every
  installed project runs, so behavior changes affect everyone on their next re-install.
- Keep the read-only guarantee intact. Any change touching `allowed-tools` in a command's
  frontmatter, or the hook's block logic, needs explicit reasoning in the PR for why it's
  still safe — this is the one property the whole project depends on.
- Test against a real repo before submitting, not just a toy example — run `/octocheck-init`
  and at least one `/octocheck-continue` task, and paste the actual output in the PR.

## Reporting a bad flag

If a rule produces a wrong or unhelpful flag on real code, open an issue with the file/line
(sanitized if needed), which rule ID fired, and why it's wrong. That's directly useful for
tightening a rule's description even without a proposed rewrite.
