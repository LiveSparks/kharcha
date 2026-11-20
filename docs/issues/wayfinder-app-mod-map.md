# Wayfinder map — App modification phase (hands-free ledger)

Labels: `wayfinder:map`

## Destination

A complete, reviewed implementation spec for modifying the Kharcha app around the merged regex
parser: payee/account naming with aliases applied everywhere, per-account balance tracking,
the duplicate-review flow, Schedule and Pattern detection, and an on-device verification gate.
Spec is done when each feature's decisions are recorded in closed tickets and nothing is left
to decide before execution sessions begin.

## Notes

- Domain: personal-finance Android app (Expo/React Native), offline, SMS-driven. Parser and
  ledger already merged on `fix/sms-retrieval` (merge d50b00a): shape-first parser,
  counterpartyMasked/Last4 fields, duplicate_review flagging, body-timestamp precedence.
  npm test 49/49. Reconciliation baseline 608/646 (94.1%) against 9 months of statements.
- Skills to consult when working tickets: `grilling`, `domain-modeling`, `prototype` (for UX
  tickets), `research` (for the survey ticket).
- Standing preferences: never auto-drop a transaction (flag for review only); body timestamps
  outrank SMS delivery time; duplicate_review is the chosen mechanism for cross-provider
  double-notify; dedupe of *identical* bodies already exists via source hash.
- Evidence base: /root/lab/work/kharcha-reconcile-csv-20261009/reconciliation-report.csv;
  KB collection "Kharcha" holds the reconciliation baseline and design decisions.
- Tracker: local markdown (this directory). Ticket file = issue. Status line inside each file
  is the claim mechanism: `status: open`, `status: claimed (<session>)`, `status: closed`.
  Blocking is the `blocked-by:` line listing ticket filenames; a ticket is unblocked when all
  blockers are closed.

## Decisions so far

- [Map: destination is a reviewed implementation spec](wayfinder-app-mod-map.md): planning only;
  execution happens in later sessions, not on this map. (charting session)
- [Survey recurring-transaction detection in open-source finance tools](WF-2-recurring-detection-survey.md):
  Firefly III and Actual are declared-schedule+matcher engines; borrow amount bands, EOM clamp,
  lastPaid watermark, advance-on-match state machine, and candidate discovery as suggestion-only.
  Findings: docs/research/recurring-detection-survey.md

- [Data model for accounts and aliases](WF-1-data-model-accounts-aliases.md): `accounts` and
  `payees` tables, each with a `name` alias column; transactions keep raw parser fields and gain
  `account_id`/`payee_id`/`payee_override_id`; names resolve on read, so there is no backfill; debit
  cards link to their funding account via a user-confirmed `funded_by`; last-4 collisions merge by
  default, with a per-row override. Also: persist `counterparty_masked`, add `user_version` migrations.
- [Naming UX](WF-3-naming-ux.md): name from the transaction detail payee row or a Payees list
  sorted by unnamed spend; the sheet asks for a name plus an optional default category, which
  applies on read and never overrides a hand-set category; a separate Accounts screen holds
  account names and the debit-card link; nudges are a passive unnamed count plus a one-time Home
  card on a payee's 3rd transaction. The old per-row merchant edit field goes away.
- [Duplicate-review flow](WF-5-duplicate-review-flow.md): an Inbox *Duplicates* tab shows pairs
  side by side, plus a Home card in the shared slot that outranks the naming nudge. Merge
  keeps the fuller parse (user can flip it), and the other row becomes `merged` with
  `duplicate_of`, kept and reversible via Unmerge. *Keep both* clears the flag for good.
  Detection is tightened (compatible account; same payee or ≤30 min) and now checks the
  ledger, not just the scan batch (116 → 92 flags in 9 months). Unparsed amount-bearing bank
  SMS go to a separate *Couldn't read* list. Statement-only events never appear.
- [Balance tracking](WF-4-balance-tracking.md): balances come from read-time anchors. Every SMS
  that states a balance or available limit is an anchor, and balance = latest anchor + later
  rows. A user-entered opening balance is used only when an account never reports one. Drift
  between anchors shows as an "Unexplained difference" row that's excluded from spend. Card
  outstanding = user-entered limit − reported available limit. Debit cards roll into their
  funding account. Balances show on the Accounts screen, plus one "Net" line on Home.
- [Schedule detection](WF-6-schedule-detection.md): series key = effective payee group
  (identically named payees join), account, and direction. Amounts cluster within ±20% of
  the rolling median. Classes are weekly ±1d, fortnightly ±2d, monthly ±4d and quarterly ±7d,
  with calendar-month stepping and an end-of-month clamp. The gate is 3 hits, 2 consecutive
  periods, 75% of gaps fitting, and the series being ≥50% of the payee's rows. Detected series
  are *suggestions*. The user confirms (*Track it*) or dismisses them for good, and on the
  replay that leaves 8 candidates with 0 false positives. Confirmed Schedules match on read
  and show Upcoming/Due/Paid/Overdue/Lapsed on a Schedules screen and a Home "Upcoming this
  week" strip. There are no notifications in v1. *Track as schedule* allows manual creation.
  WF-6 supersedes the ±15% band relayed in WF-7, and exposes per-row matches for Habits.

- [Pattern detection](WF-7-pattern-detection.md): Patterns become *Habits*. A Habit is
  repeated spending at one payee with no amount or interval rule: debits only, ≥4 spends
  across ≥3 months in the trailing year. Self-transfers, card bills, unknown merchants and
  payees hidden with *Not a habit* are left out. Grouping uses the resolved display name, so
  aliases merge Habits retroactively. Rows matched to a Schedule are removed first. Habits
  appear passively in an Insights *Habits* section and as a payee-row chip, never with a date,
  a range or a Home card. The operator ruled that Schedules (bills/subscriptions, ±15%) can be
  created by the user, get their own list and get Home prompts; this was handed to WF-6.

- [Assemble the implementation spec](WF-8-assemble-spec.md): docs/spec/app-modification.md,
  operator-approved. Six phases (naming → duplicates → balances → schedules → habits → gate),
  one migration each (v2–v6), backup snapshot schema 2, and 12 assembly rulings (§10).
  Privacy posture: nothing new leaves the device; unparsed SMS bodies are disclosed and
  blanked on dismiss. Own-account transfer pairing deferred to the next map.
- [On-device verification gate](WF-9-on-device-verification-gate.md): docs/spec/verification-gate.md.
  Synthetic fixtures in CI and a local env-gated real-corpus replay (the export is never
  committed). A device gate after every phase, plus a P6 release-build regression. The
  operator ticks, and adb screenshots and DB pulls are the evidence, kept outside the repo.
  Numbers are asserted on the replay, behavior on the device. Finding: the parser-corpus
  test holds real SMS bodies and must be re-synthesized before any push.

## Not yet specified

- Own-account transfer pairing (e.g. ₹47k HDFC→PNB shows as two Schedules today; WF-6).
  Deferred out of this phase by WF-8.

## Out of scope

- Cloud verifier tier (OpenAI Luna Decisions / Jev / any hosted model): the app ships fully
  offline. Ruled out 2026-10-09 by the operator; becomes its own effort later if the review
  queue proves burdensome.
- Full cross-provider transaction dedupe (merging differently-worded messages for one
  transaction automatically): superseded by the duplicate_review flag for this phase.
- Bank-statement import into the app (statements were reconciliation evidence, not a feature).
- Upstream contribution/packaging of the parser changes.
