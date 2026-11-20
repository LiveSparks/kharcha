# WF-8 — Assemble the implementation spec

label: `wayfinder:task`
status: closed
blocked-by: WF-3-naming-ux.md, WF-4-balance-tracking.md, WF-5-duplicate-review-flow.md, WF-6-schedule-detection.md, WF-7-pattern-detection.md

## Question

Assemble the closed decisions into one reviewed spec document (docs/spec/app-modification.md):
feature order (payee naming + account naming + duplicate review first, per operator), data
model, screens, detection algorithms, migration for the already-merged parser fields, and the
verification gate. The spec is the map's destination; the operator reviews it before any
execution session starts.

## Decision (closed 2026-11-20)

Spec assembled at [docs/spec/app-modification.md](../spec/app-modification.md); the operator
approved it, including all twelve assembly-time decisions in its §10.

- **Order:** P1 identity + naming (WF-1/3) → P2 duplicate review + Couldn't read (WF-5) →
  P3 balances (WF-4) → P4 schedules (WF-6) → P5 habits (WF-7, needs P4) → P6 gate (WF-9).
  One execution session and one `user_version` migration (v2…v6) per phase.
- **Assembly rulings:** earlier row of a pending pair counts before merge, survivor after;
  `duplicate_dismissals` pair table; table rebuild for the `merged` CHECK; first-seen
  merchant string as default label; sender→bank family table and `PNBSMS` default sender;
  orphaned legacy flags restore their would-be status; backup snapshot schema 2 with
  forward migration on restore (web preview follows); Track-it band [min×0.8, max×1.2];
  `last_paid_at` is the walk's start, matches computed on read; `node:sqlite` for
  migration tests; fixture privacy deferred to WF-9.
- **Privacy posture:** nothing new leaves the device; unparsed bank-SMS bodies are a new
  stored class, disclosed in PRIVACY.md and blanked on Dismiss; parser-work export is
  share-sheet only; all new tables ride the existing encrypted backup.
- **Deferred:** own-account transfer pairing (next map).

### Hand-offs

- WF-9: per-phase checklists; decide whether the replay export may be committed as a
  fixture or stays env-var-gated; corpus 49/49 and reconciliation 608/646 must not regress.
