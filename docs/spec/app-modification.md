# Kharcha app modification: implementation spec

status: **approved by the operator** (WF-8, 2026-11-20; all §10 rulings accepted)
source tickets: WF-1, WF-3, WF-4, WF-5, WF-6, WF-7 (closed) and WF-2 (research)
next: WF-9 defines the on-device verification gate that closes each phase

This document assembles the closed decisions into one build order. Each ticket is the
authority on *why*. This spec covers *what gets built, in what order, and against which
schema*. Where the tickets left a gap that only shows up at assembly time, the decision is
marked **[WF-8]** and listed in §10 for the operator to confirm.

---

## 1. Ground rules (apply to every phase)

1. **Never auto-drop a transaction.** Detection only flags. Rows the user merges away are
   kept as `merged` and can be unmerged.
2. **Raw parser fields are never rewritten.** `merchant`, `account_last4`,
   `counterparty_last4`, `counterparty_masked`, `raw_body`, `amount_paise` and `direction`
   hold what the parser emitted. Names, categories and identity sit beside them and resolve
   at read time.
3. **Resolve on read; store only decisions.** Display names, effective categories,
   balances, gaps, Schedule states, Schedule matches, suggestions and Habits are all
   computed. What gets stored is what the user decided (names, links, limits, confirmed
   Schedules, dismissals, merges) plus the parser output.
4. **Body timestamp beats SMS delivery time** (`occurredAtFrom`, already merged).
5. **Offline.** Nothing new leaves the device (§9).
6. **Pure functions in `src/lib`, memoized in `LedgerProvider`.** Every detector and
   resolver is a pure function with a `node --test` fixture, so it can be tested without a
   device.

### Row population used by everything below

| Population | Definition | Used by |
|---|---|---|
| **Live** | status ∈ {`auto`, `review`, `manual`} | totals, budgets, insights, balances, payee counts |
| **Detection input** | Live rows, plus a pending `duplicate_review` pair counted once (the earlier row of the pair) | Schedules, Habits |
| **Excluded** | `ignored`, `merged`, and the later row of a pending `duplicate_review` pair | nothing except history views |

Unexplained-difference rows (WF-4) aren't transactions and never enter any population.

**[WF-8]** WF-6 says a pending pair counts "as its earlier row", while WF-5/WF-7 say "as the
survivor". Until the user merges, the default survivor is the fuller parse, which is
usually but not always the earlier row. Ruling: before the merge, the *earlier* row counts
(it's stable and needs no scoring on every read). After the merge, the survivor counts,
because the other row is `merged`.

---

## 2. Feature order

The operator set the order: payee naming, account naming and duplicate review come first.
Each phase is one execution session, ends with `npm test` green and its WF-9 checklist
signed on the device, and ships its own `user_version` migration.

| Phase | Builds | Tickets | Migration | Depends on |
|---|---|---|---|---|
| **P1 Identity and naming** | migration framework, `accounts`/`payees`, ingest resolution, Payee row, name sheet, Payees list, Accounts screen (names and debit-card link), default categories, Home slot with the naming nudge | WF-1, WF-3 | v1 → v2 | none |
| **P2 Duplicate review** | tightened detection against the ledger, partner link, Duplicates tab, Merge / Keep both / Unmerge, Home duplicate card, Couldn't-read capture and tab | WF-5 | v2 → v3 | P1 (payee/account compatibility, display names) |
| **P3 Balances** | parser balance/limit fields, anchors, gap rows, opening balance, credit limit, Accounts balances, Home Net line | WF-4 | v3 → v4 | P1 (accounts, `funded_by`), P2 (`merged` exclusion) |
| **P4 Schedules** | `detectSeries`, suggestions, Track it / Not a schedule, manual *Track as schedule*, matcher and states, Schedules screen, Home strip, payee badge | WF-6 | v4 → v5 | P1 (payee groups), P2 (detection input) |
| **P5 Habits** | `detectHabits`, Insights Habits section, Habit chip, *Not a habit* | WF-7 | v5 → v6 | P4 (`matchSchedules`) |
| **P6 Gate** | full WF-9 run on device and regression corpus | WF-9 | none | all |

P3 and P4 don't depend on each other and could swap places. P5 has to follow P4.

---

## 3. Data model (end state after P5)

Current baseline (`mobile/src/lib/database.ts`): `transactions`, `budgets`, `senders`,
`preferences`, `metadata`, all created with `CREATE TABLE IF NOT EXISTS` and no version.
`counterparty_masked` is emitted by the parser and dropped by `fromRow` (always `null`).

### 3.1 New tables

```sql
-- P1 (WF-1, WF-3, WF-4 columns added in P3)
CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  bank                  TEXT NOT NULL,          -- bank family code, see §3.4
  last4                 TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('bank','credit_card','debit_card','unknown')),
  funded_by             TEXT REFERENCES accounts(id),   -- debit_card → bank account; user-confirmed
  name                  TEXT,                   -- alias; NULL = default label
  created_at            INTEGER NOT NULL,
  -- P3:
  opening_balance_paise INTEGER,
  opening_balance_at    INTEGER,
  credit_limit_paise    INTEGER,
  UNIQUE (bank, last4)
);

CREATE TABLE payees (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('merchant','masked')),
  bank        TEXT NOT NULL DEFAULT '',   -- masked: bank family; merchant: ''
  key         TEXT NOT NULL,              -- normalized merchant | counterparty last4 | '<last4>#<n>' (override-created)
  masked      TEXT,                       -- verbatim mask as first seen, for display
  name        TEXT,                       -- alias; NULL = default label
  category    TEXT,                       -- default category (WF-3)
  nudged_at   INTEGER,                    -- 3rd-transaction Home card answered (WF-3)
  created_at  INTEGER NOT NULL,
  habit_hidden INTEGER NOT NULL DEFAULT 0, -- P5 (WF-7)
  UNIQUE (kind, bank, key)
);

-- P2 (WF-5)
CREATE TABLE unparsed_messages (
  id             TEXT PRIMARY KEY,
  source_hash    TEXT UNIQUE NOT NULL,
  sender         TEXT NOT NULL,
  raw_body       TEXT NOT NULL,
  received_at    INTEGER NOT NULL,
  amount_paise   INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('pending','added','dismissed')),
  transaction_id TEXT REFERENCES transactions(id),
  created_at     INTEGER NOT NULL
);

-- P2 [WF-8]: WF-5 "Keep both … never flagged again" needs to remember the pair.
CREATE TABLE duplicate_dismissals (
  a_id TEXT NOT NULL REFERENCES transactions(id),
  b_id TEXT NOT NULL REFERENCES transactions(id),   -- a_id < b_id
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

-- P4 (WF-6)
CREATE TABLE schedules (
  id            TEXT PRIMARY KEY,
  payee_id      TEXT NOT NULL REFERENCES payees(id),   -- representative; group resolved on read
  account_id    TEXT REFERENCES accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  interval      TEXT NOT NULL CHECK (interval IN ('weekly','fortnightly','monthly','quarterly')),
  anchor_day    INTEGER NOT NULL,
  anchor_month  INTEGER,
  amount_min    INTEGER NOT NULL,
  amount_max    INTEGER NOT NULL,
  last_paid_at  INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('active','ended','dismissed')),
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER NOT NULL
);
```

**[WF-8] `duplicate_dismissals`.** WF-5 has *Keep both* set `duplicate_cleared = 1` on the
flagged row, which stops that row from ever being flagged again. That flag also blocks a
genuine third copy from pairing with it. A pair table is more precise, and criterion 4 in
WF-5's detection ("the pair hasn't already been dismissed") reads as pair-scoped. The spec
keeps `duplicate_cleared` as WF-5 wrote it and adds the pair table as what detection
actually checks. `duplicate_cleared` becomes informational. If the operator would rather
keep only the row flag, drop the table: the behavior matches on all 92 replay flags,
since none involves three copies.

### 3.2 `transactions` end state

Columns added, by phase:

| Column | Phase | Meaning |
|---|---|---|
| `account_id` | P1 | → `accounts.id`; NULL when the SMS has no last4 |
| `payee_id` | P1 | → `payees.id`, resolved at ingest |
| `payee_override_id` | P1 | per-row reassignment (*Move this one*) |
| `counterparty_masked` | P1 | persist the parser's existing output |
| `category_by_user` | P1 | 1 = the user picked this row's category; `manual` rows start at 1 |
| `duplicate_of` | P2 | `duplicate_review`: the partner; `merged`: the survivor |
| `pre_flag_status` | P2 | restored by Keep both / Unmerge |
| `duplicate_cleared` | P2 | set by Keep both / Unmerge |
| `reported_balance_paise` | P3 | signed balance stated in the SMS (CR +, DR −) |
| `reported_avl_limit_paise` | P3 | available credit limit stated in the SMS |

The `status` CHECK gains `'merged'` in P2. SQLite can't alter a CHECK constraint, so the
v2→v3 migration **rebuilds the table**: create `transactions_new` with the new CHECK, copy
the rows, drop the old table, rename, and recreate both indexes. All of this happens inside
the migration transaction, with `PRAGMA foreign_keys` off for the rebuild. **[WF-8]**

New indexes: `transactions (payee_id)`, `transactions (account_id, occurred_at)`,
`transactions (duplicate_of)`.

### 3.3 Read-time resolvers (P1, extended later)

```
effectivePayeeId(t)   = t.payee_override_id ?? t.payee_id
payeeLabel(p)         = p.name ?? (p.kind = 'merchant' ? p.key-as-displayed : `a/c ${p.masked} · ${p.bank}`)
accountLabel(a)       = a.name ?? (a.kind = 'credit_card' ? `${bank} card ••${last4}` : `${bank} ••${last4}`)
effectiveCategory(t)  = t.category_by_user ? t.category : (payee.category ?? t.category)
payeeGroupKey(p)      = p.name ? casefold(trim(p.name)) : p.id     -- WF-6 = WF-7 grouping
balanceAccount(a)     = a.kind = 'debit_card' && a.funded_by ? a.funded_by : a.id
```

For merchant payees the default label is the merchant string as the parser first emitted
it (`payees.key` is the normalized form). **[WF-8]** Store the first-seen display form in
`payees.masked` for merchant payees too, since the column is free on that row kind, so the
label doesn't show the normalized lowercase key.

### 3.4 Bank family from sender **[WF-8]**

`transactions` has no bank column, and the sender rule `label` is free text. Ingest maps
the sender address (with routing prefix stripped) to a family code using a fixed table in
`src/lib/banks.ts`:

| Sender core contains | Family |
|---|---|
| `HDFCBK` | HDFC |
| `ICICI` | ICICI |
| `SBI` | SBI |
| `PNB` | PNB |
| anything else | the stripped sender core (e.g. `KOTAKB`) |

The P1 migration uses the same function to backfill. PNB isn't in `DEFAULT_SENDERS` today
even though PNB ••7712 is in the corpus. P1 adds `PNBSMS` as a default sender for new
installs only (existing users' lists aren't touched).

---

## 4. Migrations

### 4.1 Framework (P1)

- `getDatabase()` keeps its current `CREATE TABLE IF NOT EXISTS` block as the **v1
  baseline**. After it runs, `PRAGMA user_version` is read. A fresh install and an existing
  pre-versioning install both read 0, and both count as v1.
- `migrations: Array<(tx) => Promise<void>>` in `src/lib/migrations.ts`, where index *i*
  takes v(i+1) to v(i+2). Each step runs in `withExclusiveTransactionAsync` and sets
  `user_version` as its last statement, so a failed step leaves the previous version in
  place and is retried on the next launch.
- Every migration is tested in `node --test` against an in-memory SQLite fixture seeded
  from the replay CSV (§8).

### 4.2 Steps

**v1 → v2 (P1)**
1. Create `accounts`, `payees`.
2. Add `account_id`, `payee_id`, `payee_override_id`, `counterparty_masked`,
   `category_by_user` to `transactions`.
3. For every row with `raw_body`, re-run `parseBankSms(raw_body)` to recover
   `counterpartyMasked`. This fills in a field the parser already emits but that wasn't
   stored. Rows the parser now rejects keep `counterparty_masked = NULL`, and nothing else
   on them changes.
4. Derive bank family from `sender` (§3.4), upsert the account and payee per row, and
   write `account_id`/`payee_id`. Manual rows (`sender` NULL) get no account, and their
   payee is a merchant payee keyed on the typed merchant.
5. `category_by_user = 1` where `status = 'manual'`.

**v2 → v3 (P2)**
1. Rebuild `transactions` with `'merged'` in the status CHECK (§3.2), adding
   `duplicate_of`, `pre_flag_status`, `duplicate_cleared` in the same rebuild.
2. Create `unparsed_messages`, `duplicate_dismissals`.
3. For every existing `duplicate_review` row, run the tightened detection (§5.2) against
   ledger rows from the prior 24h. If a partner is found, set `duplicate_of` and set
   `pre_flag_status` to the status the row would have had without the flag (`auto` when
   confidence ≥ 0.9 and auto-add is on, else `review`). If no partner is found, set status
   to that same unflagged value. **[WF-8]** The rule for the restored status is spelled out
   here; WF-5 says "back to `auto`".
4. No backfill of `unparsed_messages`: rejected SMS were never stored. The next full scan
   (the 90-day window) captures them.

**v3 → v4 (P3)**
1. Add `reported_balance_paise`, `reported_avl_limit_paise` to `transactions`, and
   `opening_balance_paise`, `opening_balance_at`, `credit_limit_paise` to `accounts`.
2. Re-parse `raw_body` with the P3 parser to fill both reported fields (a parser-field
   backfill, the same as v1→v2 step 3).

**v4 → v5 (P4)** Create `schedules`. No backfill. The first detection run produces the
suggestions.

**v5 → v6 (P5)** Add `payees.habit_hidden`.

### 4.3 Backup snapshot **[WF-8]**

`Snapshot.schema = 1` covers transactions, budgets, senders and preferences only. Without a
change, a backup would silently lose names, links, merges and Schedules. So:

- P1 introduces `Snapshot.schema = 2`: `{ schemaVersion: <user_version>, transactions,
  budgets, senders, preferences, accounts, payees, unparsed_messages?, duplicate_dismissals?,
  schedules?, exportedAt }`. A table that doesn't exist yet at the writer's version is
  omitted. Rows are exported with every column.
- Restoring a schema-1 snapshot inserts the v1 tables, sets `user_version` to v1, and then
  runs the migrations forward. This reuses the migration code path.
- Restoring a schema-2 snapshot from a *newer* `schemaVersion` than the app is refused
  with the existing "unsupported version" error.
- The web preview (`database.web.ts`) moves to the same schema-2 JSON shape under a new
  key (`kharcha.browser-ledger.v2`) and migrates the v1 key on first read. The web build
  has no SMS, so P2 Couldn't-read and anchors stay empty there. Every pure function runs
  unchanged.

---

## 5. Features

### 5.1 P1: Identity and naming (WF-1, WF-3)

**Ingest** (`readBankSms` → `addTransaction`): parse, then map the bank family from the
sender, upsert the account `(bank, last4)` with `kind` from the SMS shape (card-spend
shapes → `credit_card`/`debit_card`, else `bank`, else `unknown`), then upsert the payee.
A non-null merchant gives a merchant payee on `normalize(merchant)`. A null merchant with
a counterparty gives `('masked', bank, counterparty_last4)`. Neither gives no payee. Write
`account_id`, `payee_id` and `counterparty_masked`.

**Ledger provider API** (replaces `setTransaction`):
`setTransactionStatus(id, status)`, `setTransactionCategory(id, category)` (sets
`category_by_user = 1`), `movePayee(id, payeeId | {newName})`, `renamePayee(id, name |
null, category?)`, `renameAccount(id, name | null)`, `linkDebitCard(cardId, bankId |
null)`. `editTransaction`'s merchant rewrite is removed.

**Screens**

- **Transaction detail** (`transaction/[id].tsx`): the free-text "Name or place" field
  is removed. A *Payee* row shows the effective payee label with *Name*/*Rename*, plus
  later chips (P4 badge, P5 Habit). A *Wrong payee? Move this one* row picks an existing
  payee or creates `'<last4>#<n>'`. *Paid from* shows the account label and opens
  Accounts. The category picker calls `setTransactionCategory`.
- **Name sheet** (shared by payees and accounts): Name is required, 1–40 chars, trimmed,
  and clearing it sets NULL. Category is optional and payee-only. The reach line reads
  "Applies to N past and all future transactions", where N counts Live rows whose
  effective payee is this one. P4/P5 add *Track as schedule* and *Not a habit* here.
- **Payees list** (new route `payees.tsx`): unnamed payees by total Live spend
  descending, then named payees A–Z. Each row shows label, count and total. Entry: *Payees
  and accounts · N unnamed* on the You tab.
- **Accounts screen** (new route `accounts.tsx`): accounts grouped by bank with kind and
  label. The debit-card suggestion card appears when a `debit_card`/`unknown` account
  shares a bank with a `bank` account and has card spends with no matching bank-account
  SMS: "••8812 looks like a debit card on HDFC ••3391 · Link". It's reached from the
  Payees list and from *Paid from*. P3 adds balances.
- **Home card slot** (new component `HomeSlot`): renders at most one card. P1 has a
  single source: the naming nudge, shown for an unnamed payee whose effective Live count
  is ≥ 3 and `nudged_at IS NULL`, picking the highest-spend one. The text is "You've paid
  <label> 3 times. Name it?" with *Name* and *Not now*, and either button stamps
  `nudged_at`. P2 and P4 add sources and the priority order (§6).

### 5.2 P2: Duplicate review (WF-5)

**Detection** (`flagDuplicates(batch, existing)` in `lib/duplicates.ts`): `readBankSms`
passes Live and `duplicate_review` ledger rows from `since − 24h` onward. A new row is
flagged against the earliest qualifying earlier row when all of these hold: same
`amount_paise` and `direction` within 24h, partner status not `ignored`/`merged`;
compatible accounts (equal or either NULL); compatible payees (same effective payee,
either side without a payee, **or** gap ≤ 30 min); and the pair not in
`duplicate_dismissals`. Setting the flag sets `pre_flag_status` to the row's would-be
status, `status = 'duplicate_review'` and `duplicate_of = partner`. Identical bodies are
still dropped by `source_hash`. Replay target: **86 flags** on the 9-month export (WF-5 estimated 92 on an earlier parse; amended 2026-11-21, see verification-gate §5 P2).

**Survivor score**: one point each for a non-null `account_id`, a payee that isn't
"Unknown merchant", a non-null `reference`, and a body timestamp
(`occurredAtFrom(raw_body)` non-null). Ties go to the earlier row.

**API**: `mergeDuplicate(flaggedId, survivorId)` sets the other row to `merged` with
`duplicate_of = survivor`, and if the user flipped the choice the survivor gets its
`pre_flag_status` back. `keepBoth(id)` restores `pre_flag_status`, clears `duplicate_of`,
sets `duplicate_cleared` and inserts a dismissal. `unmerge(id)` does the same for a
`merged` row. `addFromUnparsed(id)` and `dismissUnparsed(id)` handle Couldn't-read rows.
The inbox's `'ignored'` merge path is removed.

**Couldn't read**: in `readBankSms`, when `parseBankSms` returns null for an allowed-sender
message, keep it in `unparsed_messages` if it matches an amount (`Rs|INR|₹` + digits) and a
transaction verb (debited|credited|spent|sent|received|paid|withdrawn|deposited), and
doesn't match the promo/bill exclusions (cashback|offer|pre-approved|loan|link shortener|is
due). Rows dedupe on `source_hash`. These rules live in `lib/unparsed.ts` as a pure
`isUnreadTransaction(body)`.

**Screens**: in the Inbox, the *Duplicates · N* tab shows pair cards with two slips (raw
body, sender, amount, payee and account labels, body time), a gap header, the *Keep* badge
and the actions *Merge*, *Keep the other*, *Keep both*. The *Couldn't read · N* tab offers
*Add as transaction* (manual entry prefilled with amount and time, which sets
`transaction_id`) and *Dismiss*. Transaction detail shows "Possible duplicate of …" with
the same actions, or "1 merged copy" leading to the merged row's *Unmerge*. The Home slot
gets the duplicate source "N possible duplicates to check · Review".

### 5.3 P3: Balances (WF-4)

**Parser**: `ParsedSms` gains `reportedBalancePaise` and `reportedAvlLimitPaise`. These
are captured from the tails the parser currently discards (`Avl bal`, `Aval Bal … CR|DR`,
`Bal Rs.`, `Avl Limit: INR`). The signs are CR = +, DR = −, and no marker = +. Amount
selection doesn't change: `nonTransactionAmount` still keeps these figures from becoming
the amount. Corpus tests cover PNB ••7712, HDFC ••8812, HDFC ••3391 and ICICI ••6119.

**`computeBalances(rows, accounts, now)`** in `lib/balances.ts` returns, per account:
`{ balancePaise | outstandingPaise | availablePaise | null, asOf, stale, gaps[] }`.
- Rows: Live rows whose `balanceAccount(account)` is this account, ordered by
  `occurred_at` and then `created_at`.
- Anchors: rows with `reported_balance_paise` (bank) or `reported_avl_limit_paise` (credit
  card), plus the opening balance as a synthetic anchor at `opening_balance_at` when the
  account has no SMS anchor. Debit-card anchors count toward the funding account only once
  `funded_by` is set.
- Balance = last anchor + signed Σ of rows after it (credit +, debit −).
- Gap between consecutive anchors A and B = B − (A + Σ rows between). A non-zero gap
  becomes a virtual row "Unexplained difference ±₹X" placed just before B.
- Credit card: with a limit, outstanding = `credit_limit_paise − last reported_avl_limit +
  Σ later spends − Σ later payments/refunds`. With no limit, "Available ₹X" only.
- `stale` = no anchor in the last 30 days.
- `unknown` accounts return `null`.

**Screens**: the Accounts screen shows each account's balance or outstanding, "as of
<time>" (muted when stale), a one-time *Set opening balance* prompt for bank accounts with
no anchor, and *Set credit limit* on cards. Account history (new route `account/[id].tsx`)
lists the account's rows with the gap rows interleaved, and tapping a gap opens manual
entry prefilled with that amount and direction. Home shows a single **Net ₹X** line (Σ
bank balances − Σ card outstanding, counting only accounts that have a figure) that taps
through to Accounts.

### 5.4 P4: Schedules (WF-6)

**`detectSeries(rows, payees, now)`** in `lib/schedules.ts` returns candidates
`{ seriesKey, interval, anchorDay, anchorMonth, amountMin, amountMax, hits[], lastHitAt }`:
- Input: Detection input rows that have a payee.
- Series key: `(payeeGroupKey, account_id, direction)`.
- Amount clusters: a row joins a cluster when it is within ±20% of the median of the
  cluster's last 3 hits.
- Classes, tried shortest first: weekly 7d ±1, fortnightly 14d ±2, monthly (calendar,
  anchor = median day-of-month, end-of-month clamp) ±4, quarterly (3 calendar months)
  ±7. A gap fits when it is k·P ± m·√k for k ∈ {1, 2}.
- Gate: ≥ 3 hits, ≥ 2 gaps with k = 1, ≥ 75% of gaps fitting, and the cluster holding ≥
  50% of its group's rows (same account and direction) between its first and last hit.
- Band on *Track it*: `[min(hits) × 0.8, max(hits) × 1.2]`, rounded to the rupee and
  editable. **[WF-8]** WF-6 says the band "comes from the series" without a formula; this
  one matches the ±20% clustering rule.
- Suggestions = candidates minus any `schedules` row (any status) on the same series key and
  interval. A series key is matched to a stored row through the stored `payee_id`'s group
  key, `account_id` and `direction`.
- Fixture: on the replay export, 8 candidates (5 active, 3 lapsed) and no Fresh Mart.

**`matchSchedules(rows, schedules, payees, now)`** returns `{ matches: Map<rowId,
scheduleId>, state: Map<scheduleId, {state, expectedAt, windowStart, windowEnd, lastPaidAt}> }`.
- Each window takes at most one match, the closest to the expected date, and a match
  advances the watermark.
- States are Upcoming, Due, Paid, Overdue, and Lapsed (2 consecutive misses); a later
  match revives the Schedule to Paid.
- Amount drift: if 2 consecutive periods have a same-key row that falls in the window but
  outside the band, the Schedule shows the *Amount changed: ₹a → ₹b, update?* prompt.
- `last_paid_at` is written back only when the user edits the Schedule. Otherwise the
  watermark is recomputed from history on every read. **[WF-8]** WF-6 says matches
  "advance `last_paid_at`" and also that matching happens "on read with no stored link".
  The column is kept as the starting point for the walk (it's set to the Track-it time),
  and the walk itself is computed.

**Re-run triggers**: after a scan, `renamePayee`, `movePayee`, `mergeDuplicate`, `keepBoth`
and `unmerge`. Detection is memoized on the ledger revision, so in practice every ledger
mutation re-runs it.

**Screens**: *Schedules* (new route `schedules.tsx`, reached from the You tab and from the
Home strip) has two sections. *Suggested* shows "Looks monthly: Google Play · ₹299 · 16
times since Jul 2025" with *Track it* and *Not a schedule*. *Tracking* is sorted by next
expected date, and each row has label, account, "₹299 · monthly", a state chip and "next
around 5 Nov". The Track form lets the user edit the name (through the name sheet),
interval, anchor and band. *Stop tracking* sets `ended`. *Track as schedule* on the payee
sheet and transaction detail opens the form prefilled from that row (monthly, anchor =
the row's day, band ±20%). Home gets an **Upcoming this week** strip, separate from the
slot, listing confirmed Schedules whose window opens within 7 days or that are Due or
Overdue; it's hidden when empty. The payee row and Payees list show a *Monthly · ₹299*
badge. The Home slot gets the suggestion source, limited to non-lapsed suggestions. There
are no notifications.

### 5.5 P5: Habits (WF-7)

**`detectHabits(rows, scheduleMatches, payees, accounts, now)`** in `lib/habits.ts`:
- Input: Detection input debit rows, minus rows in `scheduleMatches` for `active`/`ended`
  Schedules.
- Grouped by `payeeGroupKey`.
- Rows never counted: no payee or `UNKNOWN MERCHANT`; masked payees whose
  `counterparty_last4` (with bank, when known) equals one of the user's `accounts.last4`;
  payees whose name equals an account name; payments to a `credit_card` account;
  `habit_hidden` payees.
- Threshold: ≥ 4 spends across ≥ 3 calendar months within the trailing 365 days. Amount
  isn't checked.
- State: Active when the last spend is ≤ 60 days ago, otherwise Faded.
- Returns `{ groupKey, label, count, since, perMonthPaise, lastAt, state }`.

**Screens**: Insights gets a *Habits* section below *By category*, listing Active habits
by trailing-90-day spend ("Blinkit · 35 spends since Mar 2025 · ~₹1.4k/month · last 3 days
ago") with a collapsed *Faded (N)*; tapping a habit opens that payee's transactions. The
payee row gets a *Habit* chip, and the name sheet gets a *Not a habit* toggle. Habits
never show a date, a range, a Home card, or due/upcoming wording.

---

## 6. Home screen (end state)

From top to bottom:
1. **Net ₹X** line (P3), tapping through to Accounts.
2. **Card slot** (one card): pending duplicates (P2) > naming nudge (P1) > schedule
   suggestion (P4).
3. **Upcoming this week** strip (P4), hidden when empty.
4. The existing Home content, unchanged.

## 7. Screens and routes summary

| Route | Phase | New or changed |
|---|---|---|
| `transaction/[id].tsx` | P1, P2, P4, P5 | changed: payee row, move, paid-from link, duplicate panel, badges |
| `payees.tsx` | P1 | new |
| `accounts.tsx` | P1, P3 | new |
| `account/[id].tsx` | P3 | new |
| `schedules.tsx` | P4 | new |
| `(tabs)/home.tsx` | P1, P2, P3, P4 | changed: Net line, slot, strip |
| `(tabs)/inbox.tsx` | P2 | changed: Duplicates and Couldn't-read tabs; the `duplicate_review` gap is fixed |
| `(tabs)/insights.tsx` | P5 | changed: Habits section; totals use `effectiveCategory` (P1) |
| `(tabs)/you.tsx` | P1, P4 | changed: Payees and accounts entry, Schedules entry |
| `manual.tsx` | P2, P3 | changed: accepts a prefill (Couldn't-read, gap row) |

## 8. Testing before the device

- Every phase adds `node --test` suites under `mobile/test/`:
  - `migrations.test.mjs` runs each step on a fixture database (needs an in-memory SQLite
    binding for node; **[WF-8]** use `node:sqlite`, available in the Node version that
    runs `--experimental-strip-types`, so no new dependency is added).
  - Pure-function suites (`resolve`, `duplicates`, `balances`, `schedules`, `habits`) run
    on **synthetic** fixtures only: invented values, real message shapes.
- **Corpus targets** (86 flags, 8 candidates, anchor counts, 608/646 reconciliation) run in
  the local `npm run replay` harness, gated on `KHARCHA_CORPUS` and skipped in CI. The real
  export is never committed. Decided in WF-9; see [verification-gate.md](verification-gate.md).
- The baseline must not regress: parser corpus 49/49 and reconciliation 608/646.

## 9. Privacy posture (map item, resolved here **[WF-8]**)

The current `PRIVACY.md` stays true and gets one paragraph per new data class:

- Names, default categories, links, limits, opening balances, Schedules, dismissals and
  unparsed messages are stored in the same local SQLite database and nowhere else.
- `unparsed_messages` stores the **raw body of bank-sender SMS that weren't parsed**.
  That's a new class of stored text (today only accepted SMS bodies are kept), and the
  privacy doc must say so. These rows can be deleted with *Dismiss*. **[WF-8]** Dismissing
  also clears `raw_body` (it's set to an empty string and the hash is kept), so a dismissed
  message doesn't linger.
- All of these go into the optional encrypted backup (§4.3) under the same AES-GCM scheme.
  The backup API still sees only ciphertext.
- The "export for parser work" WF-5 mentions is a **user-initiated share-sheet export**
  of Couldn't-read rows, as a local file. There's no upload endpoint and no automatic
  sending. Nothing new is sent over the network in any phase.
- The cloud verifier tier stays out of scope (map).

## 10. Assembly decisions (operator-approved 2026-11-20)

Each item below was settled here because no ticket covered it. The operator approved all twelve.

1. **Pending-pair counting** (§1): the earlier row counts before a merge, the survivor
   after.
2. **`duplicate_dismissals` pair table** in addition to WF-5's row flag (§3.1).
3. **Table rebuild** for the `merged` CHECK in v2→v3 (§3.2).
4. **Merchant payee default label** uses the first-seen merchant string, stored in
   `payees.masked` (§3.3).
5. **Bank family table** from the sender, and **PNB added to the default senders** for new
   installs (§3.4).
6. **Per-phase migrations** v2 through v6, rather than one big migration (§4).
7. **Unflagged status** for orphaned legacy `duplicate_review` rows: the would-be status,
   not always `auto` (§4.2).
8. **Backup snapshot schema 2** plus forward migration on restore, and the web preview
   moving to the same shape (§4.3).
9. **Schedule band formula** on Track it: [min × 0.8, max × 1.2] (§5.4).
10. **`last_paid_at`** as the starting point for the read-time walk, not a value that
    reads write to (§5.4).
11. **`node:sqlite`** for migration tests, and **fixture privacy deferred to WF-9** (§8).
12. **Privacy posture**: nothing new leaves the device, unparsed bodies are disclosed and
    cleared on dismiss, and the export is share-sheet only (§9).

## 11. Not in this phase

- **Own-account transfer pairing.** The ₹47k HDFC ••3391 → PNB ••7712 transfer shows as two
  Schedules, one per account side. This was deliberate in WF-6 and is out of scope for v1.
  It's a candidate for the next map.
- Yearly Schedules, notifications, cloud verifier, statement import, full cross-provider
  auto-dedupe, upstream parser packaging (map *Out of scope*).
