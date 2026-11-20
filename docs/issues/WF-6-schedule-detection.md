# WF-6 — Schedule detection spec

label: `wayfinder:grilling`
status: closed
blocked-by: WF-1-data-model-accounts-aliases.md, WF-2-recurring-detection-survey.md

## Question

Specify the Schedule detector: a transaction repeating at a regular interval (weekly, monthly,
quarterly) with a tolerance margin of a few days either side.

- Inputs: body-timestamp-ordered ledger, keyed by payee/counterparty and account. How much
  history before the first Schedule is declared (cold start)?
- Interval classes: which to support at v1 (weekly / fortnightly / monthly / quarterly), and
  how the tolerance margin is defined (±N days as a fraction of interval? fixed days?).
- Amount tolerance: exact, rounded bucket, or percentage band?
- What the UI claims: "expected next: on/around <date>"? Confidence display?
- False positives: two same-amount UPI transfers a month apart is not a Schedule. What evidence
  gates the label (minimum occurrences, interval regularity score)?
- Interaction with duplicate_review: a flagged duplicate must not create a phantom Schedule.

Resolution: detection algorithm, thresholds, and the surfacing spec.

## Decision (closed 2026-11-20)

The operator was grilled on four questions. They took the recommended option on evidence, amount
band, and surfacing, and chose **suggest-then-confirm** (Actual Budget style) over auto-declaring.
The numbers come from replaying a prototype detector over the 9-month export
(`/root/lab/work/kharcha-reconcile-csv-20261009/kharcha-transactions.csv`, 1,661 parsed rows,
1,582 after removing ≤30-min double-notifies).

### Input

- Ledger rows whose status is `auto` or `review`. Rows marked `ignored`, `merged` or
  `duplicate_review` are excluded. A pending duplicate pair counts once, as its earlier row
  (WF-5 hand-off), so a double-notify can't create or double a Schedule hit.
- Ordered by body timestamp (map rule), falling back to received time.
- **Series key = (payee group, `account_id`, `direction`).**
  - Payee group = the effective payee (`COALESCE(payee_override_id, payee_id)`, WF-1). Named
    payees that share an identical display name (case-insensitive, trimmed) form one group.
  - The group rule matters on real data. The bank changed the merchant string for Google
    Workspace three times (`…Cybs Si`, `Google Workspace`, `…Cybs`). Without it, one
    subscription shows as a lapsed series plus a new one. After the user names all three
    "Google Workspace", it becomes one 22-hit monthly series.
  - Rows with no payee key ("Unknown merchant" with no counterparty) never form a series.
- Each account side is its own series. The ₹47,000 HDFC `*3391` → PNB `*7712` transfer shows
  as two Schedules (a debit on one account, a credit on the other). Pairing own-account
  transfers is not specified (see Hand-offs).

### Detection (runs after every scan, and after naming, merge, or unmerge)

1. **Amount clusters:** within a series key, the hits are split into clusters by amount. A
   row joins a cluster when it is within **±20% of the median of that cluster's last 3 hits**
   (rolling). A gradual price change, such as Workspace going from ₹325 to ₹368 to ₹383,
   stays one series. In the replay, both ±10% and ±15% split it into a lapsed old series and
   a new one. ±15% also cuts the ₹26k credit series short. ±15% reached WF-7 as an operator
   remark; this ticket's direct answer of ±20% supersedes it. (The replay used a
   whole-cluster median instead of the rolling last-3 median, so it approximates the spec on
   this point.)
2. **Interval classes (v1):** each has a nominal period P and a margin m.

   | class | P | margin m |
   |---|---|---|
   | weekly | 7 d | ±1 d |
   | fortnightly | 14 d | ±2 d |
   | monthly | calendar month | ±4 d |
   | quarterly | 3 calendar months | ±7 d |

   Yearly is left out of v1, because 9 months of history can't show 3 yearly hits. Monthly
   and quarterly step by calendar month from an anchor day, which is the median day-of-month
   of the hits. They use Firefly's end-of-month clamp, so an anchor of 31 lands on Feb 28/29.
3. **A gap fits** when it equals k·P within the margin m·√k, for k = 1 or 2. This means one
   skipped period is tolerated per gap (e.g. Rohan Kapoor's ₹24k credits with a 90-day gap).
   Classes are tried from shortest to longest, and the first that passes wins.
4. **Evidence gate (cold start):** all of the following must hold:
   - at least **3 hits** in the cluster;
   - at least **2 gaps at k = 1** (two genuinely consecutive periods);
   - at least **75% of gaps fit** the class;
   - **share gate:** the cluster holds at least **50%** of the payee group's rows on that
     account and direction between the cluster's first and last hit. This rejects frequent
     merchants whose purchases happen to line up. In the replay, Fresh Mart had 3 of its
     43 grocery buys fall about 91 days apart (share 0.11).
5. **Replay result:** 8 candidate series and 0 false positives found. Five are active:
   Google Play ₹299, Google Workspace (once named), the ₹47k transfer on each side, and
   9000054321@Upi ₹26k credit. Three are lapsed: Rohan Kapoor ₹24k, Paypal *Clientco, and
   Metro Broadband ₹2,360 quarterly. With a 4-hit gate the result drops to 6 and loses the
   last two of those; 3 hits was chosen.

### Suggest → confirm (operator's choice)

- A series that passes the gate becomes a **suggestion**, not a Schedule. Nothing is
  predicted for it until the user confirms.
- Suggestions surface in two places:
  - A *Suggested* section at the top of the Schedules screen. Each card reads "Looks monthly:
    Google Play · ₹299 · 16 times since Jul 2025", with **Track it** and **Not a schedule**.
  - The shared Home slot (WF-3/WF-5), one card at a time. Priority is pending duplicates,
    then the naming nudge, then a schedule suggestion. Naming first matters because names
    merge payee groups (above). Only suggestions whose last hit is within one period plus
    margin go to Home; lapsed candidates wait on the Schedules screen.
- **Track it** creates an `active` Schedule. Its interval, anchor day and amount band come
  from the series, and the user can edit the name (through the WF-3 sheet, which names the
  payee), interval and amount band before saving.
- **Manual creation (WF-7 hand-off):** the payee sheet and transaction detail get *Track as
  schedule*. It opens the same form prefilled from that row (interval monthly, anchor = the
  row's day, band = amount ±20%), so the user can track a bill before it has 3 hits.
- **Not a schedule** stores a `dismissed` row for the series key plus interval class. The
  same series is never suggested again. A different interval class or a new amount cluster
  on the same key is still eligible.
- Detection never edits a confirmed Schedule's terms. If observed hits drift outside the band
  for 2 consecutive periods, the Schedule shows "Amount changed: ₹368 → ₹383, update?"
  instead.

### Matching and states (confirmed Schedules only)

- **Expected date** = the next anchor step after `last_paid_at`. The **window** is the
  expected date ± m.
- A row **matches** when it has the Schedule's series key, an amount inside
  `[amount_min, amount_max]`, and a date inside the open window. Matching happens on read,
  with no stored link, consistent with WF-1 and WF-4. Each window takes at most one match,
  the closest to the expected date. A match advances `last_paid_at` (the Firefly watermark),
  and the window moves on (Actual's advance-on-match).
- **States:**
  - *Upcoming*: the window is in the future.
  - *Due*: today is inside the window and nothing has matched yet.
  - *Paid*: the current window has matched.
  - *Overdue*: the window has passed with no match. The Schedule stays Overdue until the next
    window closes.
  - *Lapsed*: 2 consecutive windows have been missed. The Schedule is never deleted, and a
    later match revives it to *Paid*.
- The user can *Stop tracking* a Schedule (`status='ended'`). An ended Schedule keeps its
  history and is never re-suggested.

### What the UI claims

- The Schedules screen has two sections:
  - *Suggested*.
  - *Tracking*, sorted by next expected date. Each row shows the payee display name, account,
    "₹299 · monthly", a state chip, and "next around 5 Nov". The word *around* plus the window
    is the only precision claimed, and there is no confidence score. Tapping a row shows its
    matched history.
- The **Home strip "Upcoming this week"** lists confirmed Schedules whose window opens within
  7 days, plus any that are Due or Overdue (e.g. "Google Play ₹299 · around Thu"). The strip
  is hidden when it's empty. It's separate from the one-card Home slot.
- **Payee row badge** on transaction detail and the Payees list: "Monthly · ₹299" for a
  tracked Schedule.
- **No push or local notifications in v1.**

### Schema amendment

```sql
CREATE TABLE schedules (
  id            TEXT PRIMARY KEY,
  payee_id      TEXT NOT NULL REFERENCES payees(id),   -- representative; group resolved on read
  account_id    TEXT REFERENCES accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  interval      TEXT NOT NULL CHECK (interval IN ('weekly','fortnightly','monthly','quarterly')),
  anchor_day    INTEGER NOT NULL,     -- day-of-month (monthly/quarterly) or weekday 0-6
  anchor_month  INTEGER,              -- quarterly phase (1-3); NULL otherwise
  amount_min    INTEGER NOT NULL,     -- paise
  amount_max    INTEGER NOT NULL,
  last_paid_at  INTEGER,              -- watermark; advanced by matches on read
  status        TEXT NOT NULL CHECK (status IN ('active','ended','dismissed')),
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER NOT NULL
);
```

- Suggestions are not stored. They're recomputed after each scan and filtered against
  `schedules` rows on the same series key and interval, whatever their status.
- Upcoming, Due, Paid, Overdue and Lapsed are derived on read, not stored.
- The migration only creates the table. Nothing is backfilled, and the first scan after
  upgrade produces the suggestions.
- The detector is a pure function, `detectSeries(rows, payeeGroups) → candidates[]`, in
  `lib/schedules.ts`. The replay export is its fixture: expect the 8 series above and no
  Fresh Mart.

### Hand-offs

- WF-7 (closed in parallel, now reconciled): the payee-group rule matches WF-7's grouping
  key, `COALESCE(override.name, payee.name)` case-folded, else `payee_id`. The matcher exposes
  `matchSchedules(rows, schedules) → Map<rowId, scheduleId>` and is memoized in the
  LedgerProvider. `detectHabits` consumes it, and only rows matched to a confirmed `active`
  or `ended` Schedule leave Habit counting. Unconfirmed suggestions don't remove rows, so a
  subscription can show as a Habit until it's tracked. WF-7's "can also be created by the
  user" is covered by *Track as schedule*.
- WF-8: Home has two elements: the single card slot (duplicates > naming > schedule
  suggestion) and the Upcoming strip. Detection must re-run on naming, merge and unmerge.
- WF-9: verify on device that the first scan suggests Google Play and the ₹47k transfer.
  Track one, then check it reads *Paid* this month and the Upcoming strip shows the next
  date. Dismiss one and confirm it doesn't come back after a rescan. Name the three
  Workspace payees identically and confirm they collapse into one suggestion.
- Not specified (add to map): pairing own-account transfers, so the ₹47k debit and credit
  show as one Schedule instead of two.
