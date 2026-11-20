# WF-7 — Pattern detection spec

label: `wayfinder:grilling`
status: closed
blocked-by: WF-1-data-model-accounts-aliases.md, WF-2-recurring-detection-survey.md

## Question

Specify the Pattern detector: paying the same payee (or counterparty) similar amounts at
irregular intervals, to surface spending habits that are not regular bills.

- Grouping key: merchant alias if one exists, else raw merchant, else counterpartyLast4. How
  do renamed/aliased payees retroactively join their Pattern groups?
- "Similar amount": what band (±10%? rounded to ₹50/₹100 buckets?).
- What the user sees: a "habits" view? A prompt ("You've spent ₹2-3k at Amazon Pay 6 times in
  3 months — name this pattern?")?
- Distinction from Schedule on screen: a Pattern must never be presented as a predicted bill.
- False-positive controls: minimum occurrence count, time span, distinct months.

Resolution: detection definition, display form, and how Patterns and Schedules coexist
(can one group be both?).

## Resolution

2026-11-20 (grilling with the operator). In the app, a Pattern is called a **Habit**: repeated
spending at one payee with no amount or interval rule. Amount bands and the ±15% margin
belong to Schedules (WF-6), not Habits. The system finds Habits on its own and the user never
creates one. They live in a passive list and never get a Home prompt. Schedules are the
opposite: the user can create them, they have their own list, and they get Home prompts
(hand-off below).

### Evidence (9-month ledger, `kharcha-transactions.csv`, 1,661 parsed rows)

- The research's ±15%-of-median band breaks real habits apart: Blinkit drops from 35 spends to
  9 and Fresh Mart from 44 to 6. Grocery and food habits are wide by nature, so amount is
  not a membership test for Habits.
- An ungated run (≥4 rows across ≥3 months, both directions) gives 65 groups. The noise in it
  is `UNKNOWN MERCHANT` (145 debits), self-transfers (ARJUN MEHTA, ARJUNMEHTA-2@OKICICI),
  card-bill payments (ICICI BANK CREDIT CARD, CREDIT) and income credits. Category can't
  filter these, because 1,319 of 1,661 rows are `Transfers`, which includes UPI payments to
  shops and people.
- Removing those and the interval-regular series leaves 44 groups over the full ledger and 13
  in the trailing 180 days (Fresh Mart, Amazon Pay, Blinkit, Zomato, MR DIY, Airtel,
  OpenRouter, …).
- Merchant-string variants split one habit into several (ZOMATO / ZOMATO LIMITED / ZOMATO
  PRIVATE LIMITED; three GOOGLE WORKSPACE strings). WF-1 aliases fix this, as described next.

### Detection

1. **Input:** debit rows only. Excluded statuses: `ignored`, `merged`, `duplicate_review`
   (per WF-5; a pending pair counts once, as the survivor).
2. **Grouping key = resolved display identity, at read time:** the case-folded
   `COALESCE(override_payee.name, payee.name)` when a name exists, else `payee_id`. Two payees
   the user names the same ("Zomato") form one group. Because names resolve on read (WF-1),
   renaming or aliasing a payee moves its past rows into the group right away, with no
   re-keying and no backfill. A per-row `payee_override_id` moves that row's evidence too.
3. **Never a Habit:**
   - rows with no payee, or with the parser's `UNKNOWN MERCHANT` fallback;
   - self-transfers: a masked payee whose `counterparty_last4` matches one of the user's own
     `accounts.last4` (bank family included when known), or a payee whose name matches an
     account's name;
   - payments to a `credit_card` account (card bills);
   - payees the user has hidden (`payees.habit_hidden = 1`, set by *Not a habit*). This is
     the manual escape hatch for the self-transfers and card bills that the first two rules
     can't see in SMS text.
4. **Schedule wins, per row:** rows WF-6 matched to a Schedule are removed before Habit
   counting. What's left can still form a Habit if it meets the thresholds by itself (for
   example, extra Google Play purchases beside a monthly ₹299 subscription). A row is never
   evidence for both.
5. **Thresholds:** ≥4 qualifying spends across ≥3 distinct calendar months, counted within
   the trailing 365 days. Amount is not checked.
6. **States:** *Active* if the last spend was ≤60 days ago, otherwise *Faded*. A Habit that
   drops below the threshold leaves the list. Nothing is stored, so it can come back on its
   own.
7. **Compute:** a pure function `detectHabits(rows, schedules, payees, accounts, now)`. It
   is memoized in the LedgerProvider the same way Insights totals are. No table is needed.
   The only schema change:

   ```sql
   ALTER TABLE payees ADD COLUMN habit_hidden INTEGER NOT NULL DEFAULT 0;
   ```

### Display

- **Insights → Habits section,** below "By category". One row per Active Habit, sorted by
  spend in the trailing 90 days:
  `Blinkit · 35 spends since Mar 2025 · ~₹1.4k/month · last 3 days ago`.
  `~/month` is the trailing-365-day total divided by the months spanned. A collapsed
  *Faded (N)* group sits below. Tapping a row opens that payee's transactions.
- **Payee row** (transaction detail, WF-3): a small `Habit` chip when the payee is in an
  Active Habit. The payee sheet gains a *Not a habit* toggle (`habit_hidden`).
- **Never shown for a Habit:** an expected or next date, an amount range, a Home card, or
  any "due"/"upcoming" wording. Unnamed payees appear under their default label (WF-1). The
  WF-3 naming nudge stays the only prompt to name them.

### Coexistence with Schedules

Each row gets one label, and the Schedule label is assigned first. A payee can show in both
lists only when its non-Schedule leftovers meet the Habit thresholds by themselves. A payee
whose rows all belong to a Schedule never appears in Habits.

### Hand-offs

- **WF-6 (Schedule):** from the operator, 2026-11-20. Schedules are subscriptions and bills.
  They carry the ±15% amount margin, are found automatically and can also be created by the
  user, have their own Schedules list, and are prompted on the Home screen. WF-6 must expose,
  for each row, whether a Schedule matched it, because Habit detection consumes that. Fixture
  note: Google Workspace bills under three merchant strings (with and without `CYBS`/`SI`),
  so it is a Schedule only after the strings are aliased together or matched by
  normalization.
- **WF-3:** the payee sheet gains the *Not a habit* toggle and the payee row gains the
  `Habit` chip.
- **WF-9:** verify on device that renaming two variant payees to one name merges their Habit
  right away, and that *Not a habit* removes the row and survives a rescan.
