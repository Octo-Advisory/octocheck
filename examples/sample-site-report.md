# OctoCheck Site Report — octocheck-test — 2026-10-09-080005

Site: octocheck-test (https://erp.example.com), Frappe 15.0.0, connector 0.1.0
Rules: UI-script rules v0.2.0-draft (27 review rules, 4 contract checks, 0 team rules; disabled for this project: none)
Plan fetched: 2026-10-09 08:00 UTC, approved: 2026-10-09 08:00 UTC
Tasks completed: 5 / 5
Scripts reviewed this run: 8 (8 new, 0 changed, 0 queued because the rules changed, 0 expired by age)
Linked scripts re-checked for contract issues: 0
Not re-reviewed (unchanged since their last review): 0
Flags this run: 18 (5 high, 4 medium, 9 low)

## Summary by script

| Script | High | Medium | Low |
| --- | --- | --- | --- |
| [OC Test 4 Guest API](https://erp.example.com/app/server-script/OC%20Test%204%20Guest%20API) | 2 | 0 | 0 |
| [OC Test 7 Client Call](https://erp.example.com/app/client-script/OC%20Test%207%20Client%20Call) | 1 | 1 | 3 |
| [OC Test 5 Hardcoded Values](https://erp.example.com/app/server-script/OC%20Test%205%20Hardcoded%20Values) | 1 | 1 | 2 |
| [OC Test 1 Missing Field](https://erp.example.com/app/server-script/OC%20Test%201%20Missing%20Field) | 1 | 0 | 1 |
| [OC Test 2 None Not Handled](https://erp.example.com/app/server-script/OC%20Test%202%20None%20Not%20Handled) | 0 | 1 | 1 |
| [OC Test 3 Query In Loop](https://erp.example.com/app/server-script/OC%20Test%203%20Query%20In%20Loop) | 0 | 1 | 1 |
| [OC Test 6 Old Disabled Rule](https://erp.example.com/app/server-script/OC%20Test%206%20Old%20Disabled%20Rule) | 0 | 0 | 1 |

## Factor 1 — Comments

### [OC Test 7 Client Call](https://erp.example.com/app/client-script/OC%20Test%207%20Client%20Call)
Client Script · ToDo / Form

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| whole script | UI-01 | Low | No header comment stating the script's purpose. |

## Factor 3 — Dynamic paths

### [OC Test 5 Hardcoded Values](https://erp.example.com/app/server-script/OC%20Test%205%20Hardcoded%20Values)
Server Script (Scheduler Event)

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 2 | UI-08 | Medium | Hard-coded host and URL (http://192.168.1.50:8000/api/notify) belong in Site Config or a Settings DocType. |
| 3 | UI-07 | High | An API token is hard-coded in the script text; it should live in a Settings DocType or site config. |

## Factor 4 — Test cases

Not applicable to UI scripts: no flags are raised for tests.

## Factor 5 — Edge cases

### [OC Test 1 Missing Field](https://erp.example.com/app/server-script/OC%20Test%201%20Missing%20Field)
Server Script (DocType Event) · ToDo / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 2 | UI-28 | High | doc.escalation_reason is read but ToDo has no such field, so the check is always true for High priority and blocks every such save. |

### [OC Test 2 None Not Handled](https://erp.example.com/app/server-script/OC%20Test%202%20None%20Not%20Handled)
Server Script (DocType Event) · ToDo / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 2 | UI-11 | Medium | get_value returns None when allocated_to is empty or the user is missing, and user_email.endswith then raises AttributeError. |

### [OC Test 4 Guest API](https://erp.example.com/app/server-script/OC%20Test%204%20Guest%20API)
Server Script (API)

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 2 | UI-14 | High | frappe.form_dict email is passed straight to get_value with no presence or format check. |

### [OC Test 7 Client Call](https://erp.example.com/app/client-script/OC%20Test%207%20Client%20Call)
Client Script · ToDo / Form

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 4 | UI-13 | Medium | frappe.call has no error handling, and r.message is used without checking it exists, so a failed or empty response throws. |
| 8 | UI-28 | High | assignee_note is written with set_value but ToDo has no such field. |

## Factor 6 — Org standards

### [OC Test 1 Missing Field](https://erp.example.com/app/server-script/OC%20Test%201%20Missing%20Field)
Server Script (DocType Event) · ToDo / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 3 | UI-20 | Low | frappe.throw message is not wrapped in _() for translation. |

### [OC Test 2 None Not Handled](https://erp.example.com/app/server-script/OC%20Test%202%20None%20Not%20Handled)
Server Script (DocType Event) · ToDo / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 4 | UI-20 | Low | frappe.msgprint message is not wrapped in _() for translation. |

### [OC Test 3 Query In Loop](https://erp.example.com/app/server-script/OC%20Test%203%20Query%20In%20Loop)
Server Script (DocType Event) · Event / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 5 | UI-20 | Low | frappe.throw message is built by string concatenation and not wrapped in _() for translation. |

### [OC Test 4 Guest API](https://erp.example.com/app/server-script/OC%20Test%204%20Guest%20API)
Server Script (API)

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| whole script | UI-17 | High | Allow Guest is on, and it returns full_name, mobile_no and last_login for any user to anonymous callers with no input or permission checks. |

### [OC Test 5 Hardcoded Values](https://erp.example.com/app/server-script/OC%20Test%205%20Hardcoded%20Values)
Server Script (Scheduler Event)

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| whole script | UI-22 | Low | Scheduler runs Daily with no stated reason for its frequency. |

### [OC Test 6 Old Disabled Rule](https://erp.example.com/app/server-script/OC%20Test%206%20Old%20Disabled%20Rule)
Server Script (DocType Event) · ToDo / Before Save · disabled

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| whole script | UI-23 | Low | Script is disabled and its comment says it was replaced, so it is dead code. |

### [OC Test 7 Client Call](https://erp.example.com/app/client-script/OC%20Test%207%20Client%20Call)
Client Script · ToDo / Form

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 3 | UI-20 | Low | Button label 'Check assignee' is not wrapped in __() for translation. |
| 8 | UI-21 | Low | Uses deprecated cur_frm instead of the frm argument. |

## Factor 7 — Optimize

### [OC Test 3 Query In Loop](https://erp.example.com/app/server-script/OC%20Test%203%20Query%20In%20Loop)
Server Script (DocType Event) · Event / Before Save

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 3 | UI-24 | Medium | frappe.db.exists is called once per participant row inside the loop, so the query count grows with the table size. |

### [OC Test 5 Hardcoded Values](https://erp.example.com/app/server-script/OC%20Test%205%20Hardcoded%20Values)
Server Script (Scheduler Event)

| Line | Rule | Severity | Note |
| --- | --- | --- | --- |
| 4 | UI-27 | Low | token is assigned but never used. |

## Reviewed, no flags

OC Test 8 Clean Control

<!-- Built by OctoCheck from the saved review state. Do not edit: it is rebuilt after every task. -->
