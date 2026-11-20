# WF-5 — Duplicate-review flow

label: `wayfinder:grilling`
status: closed
blocked-by: WF-1-data-model-accounts-aliases.md

## Question

The ledger already flags short-window same-amount repeats as `duplicate_review` (never drops
them). What does the user do with a flagged row?

- Review surface: where flagged rows appear, what evidence is shown side by side (both raw
  bodies, both parsed rows, timestamps).
- Merge semantics: confirm-duplicate keeps one row (which one — first? the one with the body
  timestamp?), discards/merges the other. Can a flag be reversed (mark not-duplicate)?
- What happens to aliases, references, and the account linkage of the merged-away row.
- Does the review queue also host parser-ambiguous rows (bank-gated but unparsed) or is that a
  separate list? The reconciliation found ~35 statement-only events that will never have an
  SMS — do they appear here at all?

Resolution: the review screen's behavior spec, ready for a prototype.

## Decision (closed 2026-11-20)

Grilled with the operator, who chose the recommended option on all four questions. The
numbers below come from replaying the 9-month SMS export
(`/root/lab/work/kharcha-reconcile-csv-20261009/kharcha-transactions.csv`, 1,661 parsed rows).

### Facts found in the code (mobile/src)

- `flagDuplicates` (lib/duplicates.ts) keys only on `amountPaise|direction` within 24h and
  sets `status='duplicate_review'` on the later row. It stores **no link** to the earlier
  row, so "Merge with earlier" in the inbox can only set the copy to `ignored`.
- `readBankSms` calls `flagDuplicates(result)` with no `existing` argument, so a scan
  compares rows only within its own batch. A copy that arrives in a later scan than the
  original is never flagged.
- The inbox `tabs` array omits `duplicate_review`, so flagged rows are invisible.
- `readBankSms` drops anything `parseBankSms` returns null for (`if (!parsed) continue`).
  "Bank-gated but unparsed" rows don't exist in the ledger today.
- The current rule flags 116 rows in 9 months. Most are real double-notifies: same
  account and merchant, 0–6 min apart, from sibling senders (`AD-`/`CP-`/`AX-HDFCBK`). Some
  are false, e.g. ₹50 to Highway Fuels vs ₹50 to Suresh Kumar Rao, 18h apart.

### Detection (tightened, still flag-only)

A new row is flagged against an earlier row when all of these hold:

1. Same `amount_paise` and `direction`. The earlier row is within 24h, and its status is not
   `ignored` or `merged`.
2. Accounts are compatible: same `account_id`, or either side NULL.
3. Payees are compatible (same effective payee, or either side has no payee key, e.g.
   "Unknown merchant") **or** the gap is ≤ 30 min.
4. The pair hasn't already been dismissed (see *Keep separate*).

The match runs against **ledger rows plus the scan batch**, so `readBankSms` must pass
existing rows from the last 24h before `since`. On the export this gives 92 flags instead
of 116 (about 10 a month). 13 of the 92 are more than 30 min apart and match only on
payee. Identical bodies are still deduped silently by `source_hash`, which doesn't change.

### Review surface

- **Inbox tab `Duplicates · N`**, next to *To review / In ledger / Ignored*. Each pair is
  one card with two SMS slips side by side (stacked on narrow screens). Each slip shows the
  raw body, sender, parsed amount, effective payee and account display names (WF-1/WF-3),
  and the body timestamp. A header shows the gap ("6 min apart"), and the default survivor
  is badged *Keep*. Actions:
  - **Merge**: confirm, keeping the badged row.
  - **Keep the other**: swap the survivor, then merge.
  - **Keep both**: not a duplicate.
- **Home card:** when N > 0, "2 possible duplicates to check" with *Review*, which opens the
  tab. It shares the WF-3 Home slot. Only one card shows at a time, and pending
  duplicates outrank the naming nudge because they distort totals. The card shows no
  notification and has no snooze. It goes away when N = 0.
- **Transaction detail** of a flagged row shows "Possible duplicate of …" linking to the
  partner, with the same three actions.

### Merge semantics

- **Default survivor = the fuller parse**: one point each for non-NULL `account_id`, a
  named merchant or counterparty payee (not "Unknown merchant"), `reference`, and a body
  timestamp. Ties go to the earlier row. The user can flip it before confirming.
- **The merged-away row** gets `status='merged'` and `duplicate_of = survivor.id`. It is
  never deleted. It keeps its raw SMS, `account_id`, `payee_id` and `payee_override_id`
  untouched, and it is excluded from totals, budgets, balances (WF-4), payee counts
  (WF-3's "Applies to N" and the 3rd-transaction nudge) and Schedule/Pattern input
  (WF-6/7).
- **Nothing is copied onto the survivor.** Raw fields stay as parsed (WF-1 rule), and the
  user-set category and payee override on the survivor stay. If the merged-away row held
  the user's edits, the user picks that row as survivor.
- **Unmerge** sits on the merged row's detail screen (reached from the survivor's
  "1 merged copy" line). It restores the row's pre-flag status (`auto`/`review`), clears
  `duplicate_of`, and sets `duplicate_cleared = 1`.
- **Keep both** sets the flagged row back to its pre-flag status, clears `duplicate_of`
  and sets `duplicate_cleared = 1`, so it is never flagged again.
- Merge chains don't form: flagging skips `merged` rows. If a third copy arrives, it
  pairs with the survivor.

### "Couldn't read" list (separate from duplicates)

- At ingest, an allowed-sender message that `parseBankSms` rejects is kept when it has an
  amount (`Rs|INR|₹` + digits) and a transaction verb (debited, credited, spent, sent,
  received, paid, withdrawn, deposited). Promo or bill-due wording (cashback, offer,
  pre-approved, loan, link shorteners, "is due") is left out. On the unfiltered export
  this keeps ~100 of 2,979 unparsed messages; sender gating will cut it further.
- These messages live in a new `unparsed_messages` table, not in `transactions`, because
  they have no amount/direction to satisfy its NOT NULL columns. An Inbox tab
  *Couldn't read · N* shows the raw SMS with two actions: *Add as transaction* (opens
  manual entry prefilled with the amount and time, then links `transaction_id`) and
  *Dismiss*. This tab gets no Home card.
- Each row is also a parser-regression signal. The spec should note that these rows are
  exportable for parser work (on-device only; see the privacy posture item on the map).
- **Statement-only events** (~35 in the reconciliation: interest, charges, no SMS)
  never appear in the app. They are WF-4's balance-drift concern, not a review item.

### Schema amendments

```sql
-- transactions.status CHECK gains 'merged'
ALTER TABLE transactions ADD COLUMN duplicate_of TEXT REFERENCES transactions(id);
  -- duplicate_review: the candidate partner; merged: the survivor; else NULL
ALTER TABLE transactions ADD COLUMN pre_flag_status TEXT;      -- restored by Keep both / Unmerge
ALTER TABLE transactions ADD COLUMN duplicate_cleared INTEGER NOT NULL DEFAULT 0;

CREATE TABLE unparsed_messages (
  id             TEXT PRIMARY KEY,
  source_hash    TEXT UNIQUE NOT NULL,
  sender         TEXT NOT NULL,
  raw_body       TEXT NOT NULL,
  received_at    INTEGER NOT NULL,
  amount_paise   INTEGER,                 -- best-effort hint for prefill
  status         TEXT NOT NULL CHECK (status IN ('pending','added','dismissed')),
  transaction_id TEXT REFERENCES transactions(id),
  created_at     INTEGER NOT NULL
);
```

Migration: existing `duplicate_review` rows have no partner, so the migration re-runs
detection over them to fill `duplicate_of`. Rows it can't pair go back to `auto`.

Ledger provider gains `mergeDuplicate(flaggedId, survivorId)`, `keepBoth(id)`,
`unmerge(id)`, `addFromUnparsed(id)`, `dismissUnparsed(id)`. The inbox's
`setTransaction(..., 'ignored')` merge path is removed.

### Hand-offs

- WF-4: balances sum only rows whose status is not `ignored`/`merged`. Statement-only
  events stay WF-4's call.
- WF-6/7: detection input excludes `merged` and `duplicate_review` rows. A pending pair
  counts once, as the survivor, so a duplicate doesn't double a Schedule hit.
- WF-9: verify on device that a cross-scan double-notify (SMS 2 arrives after a scan)
  gets flagged, and that Merge, Keep both and Unmerge all round-trip.
