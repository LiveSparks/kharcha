# WF-2 — Survey recurring-transaction detection in open-source finance tools

label: `wayfinder:research`
status: closed
blocked-by: (none — frontier ticket, background agent)

## Question

How do established open-source finance tools detect recurring transactions, and what is worth
borrowing for Kharcha's Schedule (regular interval ± margin) and Pattern (same payee, similar
amounts, irregular) detectors?

Survey Actual Budget, Firefly III, Maybe, ParsePay, and any comparable SMS-ledger apps.
For each: detection algorithm (interval clustering? date-diff heuristics? ML?), tolerance
handling, cold-start behavior (how much history is needed), and false-positive controls.

Output: a findings file with concrete, borrowable mechanics and a recommendation for each of
Schedule and Pattern. This is evidence for the Schedule and Pattern spec tickets.

## Resolution

2026-10-09: Findings written to docs/research/recurring-detection-survey.md. Firefly III and
Actual Budget are both declared-schedule + matcher architectures (no discovery-first ML);
Firefly contributes amount bands, the lastPaid watermark, and EOM clamping; Actual contributes
candidate-suggestion and the paid-window advance state machine. ParsePay has no recurring
engine, confirming the layer is unsolved in SMS-ledger tools. Recommendations: Schedule needs
≥3 occurrences with interval-clustering (7/14/30/91 ± interval-scaled margin), Firefly-style
min/max amount band, Actual-style advance-on-match; Pattern needs ≥4 occurrences across ≥3
distinct months at ±15% amount band, displayed as habit statements. Note: the first research
subagent hit its tool-call limit at 30 iterations and delivered no file; this session
completed the survey from the primary sources it left (firefly-iii sparse clone) plus direct
raw-source fetches.
