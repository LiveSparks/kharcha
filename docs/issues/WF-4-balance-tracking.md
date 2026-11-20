# WF-4 — Balance tracking semantics

label: `wayfinder:grilling`
status: closed
blocked-by: WF-1-data-model-accounts-aliases.md

## Question

How does per-account balance tracking work in an SMS-only ledger?

- The opening-balance problem: the ledger starts at the first SMS, not at the true balance.
  Options: seed from the "Avl Bal" figure PNB/HDFC put in every SMS (parser already sees these
  shapes), from a user-entered opening balance, or from a past statement import.
- Running balance per account from body-timestamp-ordered transactions; what to do about
  statement-only events (interest, service charges) that would make computed balances drift
  from reality.
- Card accounts: does a card show a "balance" (outstanding spend) distinct from its funding
  account? The reconciliation showed card payments already flow to the funding account.
- Where balance displays: per-account screen, home summary, both?

Resolution: written semantics for balance computation, seeding, and display.

## Decision (closed 2026-11-20)

Grilled with the operator, who chose the recommended option on all four questions.

### Facts found (SMS export 2025-06 → 2026-10, reconciliation report)

- Balance-bearing SMS by account: PNB ••7712 debits 15/17 ("Aval Bal 312.18 CR"); HDFC
  debit card ••8812 spends 42/88 ("Bal Rs.185420.10", which is the balance of funding account
  ••3391); HDFC ••3391 own messages 31/177 ("Update! … deposited … Avl bal"). HDFC UPI "Sent"
  messages never carry a balance. ICICI credit card ••6119 carries "Avl Limit: INR …", never
  a balance.
- The parser sees these tails but throws them away: `nonTransactionAmount` keeps them from
  becoming the amount, and the narration splits on `Avl bal`. No balance value is stored.
- Statement-only events (no SMS exists): 34 over 9 months. They are quarterly interest credits
  (••3391, ••7713), DC INTL markup/DCC fees, AQB service charges (••9025), SI-fail charges, and
  odd credits (dividend, LPG subsidy, ACH). Most are small, and they are what makes a computed
  balance drift.

### Semantics

- **Anchors.** The parser emits `reportedBalance` (paise, signed: CR = +, DR = −) and
  `reportedLimit` (available credit limit, paise) when the body has them. They're stored on
  the transaction row as `reported_balance_paise` / `reported_avl_limit_paise`. Any row with
  one of these is an anchor: it records the account's state *after* that transaction.
- **Which account an anchor belongs to.** The anchor belongs to the account the row resolves
  to, rolled up through `funded_by`. A ••8812 debit-card anchor is ••3391's balance. Until the
  user confirms the debit-card link (WF-1), card-side anchors are held on the card and are
  not used for the bank account. They apply retroactively once the link is set, because the
  balance is computed at read time.
- **Computation (read-time, no stored running balance).** For each bank account, order its
  rows (including rows from linked debit cards) by `occurred_at`, then by ingest order. The
  balance is the latest anchor plus the signed sum of rows after it. The UI shows "as of
  <timestamp of the last row counted>". If the account has never reported a balance, the user
  is asked once for an opening balance (`accounts.opening_balance_paise` +
  `opening_balance_at`), which acts as a synthetic anchor. A later SMS anchor takes
  precedence over it.
- **Drift → visible adjustment row.** Between two consecutive anchors A and B, the gap is
  B − (A + Σ rows between). Any non-zero gap is computed on read and rendered in that
  account's history as "Unexplained difference ±₹X", placed just before B. It's excluded
  from spend, budgets, insights, and Schedule/Pattern detection. Tapping it lets the user log
  a real transaction (e.g. "Interest"). Doing so shrinks or clears the gap, because nothing
  is stored for the adjustment itself. Gaps are never routed to the review queue. A gap more
  than 5% of the balance (or above ₹5,000) is a likely missed or misparsed SMS, which is a
  WF-9 verification signal and not a UX feature.
- **Credit cards.** `accounts.credit_limit_paise` is entered once by the user, prompted from
  the Accounts screen. Outstanding = limit − latest `reported_avl_limit`, plus card rows after
  that anchor (spends add, payments/refunds subtract). It uses the same anchor + delta + gap
  machinery. With no limit entered, the card shows "Available ₹X" only. Debit cards have no
  balance of their own: they show their spends and roll into the funding account. `unknown`
  accounts show no balance until their kind is set.
- **Display.** The WF-3 Accounts screen lists each account with its balance (or outstanding)
  and "as of", and taps into account history with the adjustment rows. Home gets one line,
  "Net ₹X" (sum of bank balances − sum of card outstanding, counting only accounts that have
  a balance), which taps through to Accounts. Accounts with stale anchors (no anchor in 30
  days) show the as-of date in muted text and are still counted.

### Schema delta (rides the WF-1 v1→v2 migration, or v3 if WF-1 lands first)

```sql
-- transactions gains:
--   reported_balance_paise     INTEGER   -- NULL unless the SMS states a balance
--   reported_avl_limit_paise   INTEGER   -- NULL unless the SMS states an available credit limit
-- accounts gains:
--   opening_balance_paise      INTEGER   -- user-entered, only when no anchor exists
--   opening_balance_at         INTEGER
--   credit_limit_paise         INTEGER   -- credit_card only
```

Existing rows get anchors by re-parsing their stored `body` in the migration. The parser is
deterministic, so this is a backfill of a parser field and not a rewrite of display data.

### Hand-offs

- Map "not yet specified" item on statement-only events is resolved: they surface as
  unexplained-difference rows and can be logged manually. No statement import.
- WF-5: gaps stay out of the review queue. The queue is for duplicates and unparseable rows only.
- WF-6/7: adjustment rows are not transactions and never feed detection.
- WF-9: per-account gap size is a verification metric (a parser regression shows up as a
  jump in gaps).
