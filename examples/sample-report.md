# OctoCheck Report — sample (excerpted)

Ruleset version: 1.0.0
Tasks completed: 14 / 14
Files reviewed: (excerpted — see below for a representative slice, not the full run)

This is a trimmed excerpt from a real first run of OctoCheck against a mid-sized Frappe
app, kept here to show what actual output looks like — not a template. Paths have been
generalized. See README.md for how to reproduce this on your own repo.

## Factor 5 — Edge cases

**app/onboarding/format_review.py**
- format_review.py:74 — [FR-5-03] high — `update_field_rule` takes a template name directly
  and has no ownership check before mutating that template's fields — only a role check
  gates the related confirm/delete actions (role only, not ownership). Since the DocType
  grants full read/write to every authenticated user at the DocType level, any signed-up
  user who knows or guesses another user's template name can edit its field rules.

**frontend/src/views/Overview.jsx**
- Overview.jsx:50 — [FE-5-01] high — References a dashboard field the API never actually
  returns; the "live" banner renders "undefined formats live" once loading finishes instead
  of a real count — confirmed by cross-checking the frontend against the actual API response
  shape, not a hypothetical.

## Factor 7 — Optimize

**app/api.py**
- api.py:625 — [PY-7-01] high — A per-row document fetch runs inside a loop that itself runs
  for every item in a list, producing an N+1 fetch on every dashboard load instead of a
  single batched query.

## Factor 4 — Test cases

**app/doctype/some_doctype**
- test_some_doctype.py:1 — [FR-4-01] high — Test file exists but is an empty stub with zero
  test methods — no coverage for the state transitions this DocType is responsible for.

---

Full runs typically also include `### Factor 1 — Comments`, `### Factor 2 — Casing`,
`### Factor 3 — Dynamic paths`, and `### Factor 6 — Org standards` sections, and explicitly
report "No findings" for any task that's genuinely clean rather than omitting it — see
README.md for what a task with no issues looks like in practice.
