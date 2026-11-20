# WF-9 — On-device verification gate

label: `wayfinder:task`
status: closed
blocked-by: WF-8-assemble-spec.md

## Question

Define the closing gate: how each feature is proven on the real device before the phase is
called done.

- Rebuild plan: expo prebuild + gradle assembleDebug (nohup + log-poll; ~18 min first build),
  Metro + adb reverse over wireless debugging (device last seen at <phone-ip>:<port>;
  wireless debugging likely needs re-enabling; pairing persists).
- Per-feature verification script: name a payee, watch aliases propagate to existing rows;
  check per-account balance against a known statement figure; flag/merge a planted duplicate;
  confirm a Schedule appears on the SI series (47,000 monthly HDFC→PNB is a known real one).
- Regression harness: does the 9-month reconciliation corpus become a CI-side test?

Resolution: the verification checklist the operator signs off on.

## Decision (closed 2026-11-20)

Grilled with the operator, who chose the recommended option on all four questions. Gate
document: [docs/spec/verification-gate.md](../spec/verification-gate.md).

- **Harness:** CI runs synthetic fixtures only. The real-corpus replay (`npm run replay`,
  built in P1) is local and gated on `KHARCHA_CORPUS`, and the real export is never
  committed, because `origin` is the public upstream repo. Reconciliation (`reconcile3.py`)
  is re-run locally with a bar of ≥ 608/646.
- **Cadence:** a device gate after every phase P1–P5, and P6 is a full regression on a
  release-mode build. A single debug APK serves P1–P5, since no phase touches native code;
  later phases reload through Metro and adb reverse.
- **Evidence:** the operator ticks each step, and the session captures adb screenshots plus
  pre/post database pulls with SQL assertions. Everything is kept in
  `/root/lab/work/kharcha-gate-<phase>-<date>/`, outside the repo. Sign-off is "P<n>
  signed" in the session.
- **Pass bars:** exact numbers are asserted on the fixed-corpus replay. Device checks are
  behavioral, plus sanity bounds against the bank apps' own figures.
- **Safety:** pull the database (with WAL) before new code runs at every gate. `pre-P1.db`
  is kept until P6, and it also drives the v1→v6 upgrade test.

### Finding

`mobile/test/parser-corpus.test.mjs` already commits 36 real SMS bodies (account digits,
refs, VPAs, names). The branch is unpushed. Those cases need re-synthesizing before any
push or upstream PR.
