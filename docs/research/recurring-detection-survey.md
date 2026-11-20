# Recurring-transaction detection survey (WF-2)

Date: 2026-10-09. Method: primary sources — Firefly III source (sparse clone in
/root/lab/work/wf2-recurring-survey-20261009/), Actual Budget source (raw.githubusercontent),
ParsePay repo (surveyed 2026-10-08 during the classifier research round). Where a tool could
not be verified from source, it is marked as such.

## Firefly III (bills / subscriptions)

Verified from source:
- `app/Support/Models/BillDateCalculator.php` — `getPayDates(earliest, latest, billStart,
  period, skip, lastPaid)` generates expected pay dates by stepping the bill's period from its
  start date, with explicit edge handling for February/leap years (`daysUntilEndOfMonth < 4`
  → subtract the diff) and a `lastPaid` watermark so an already-paid period never double-counts.
- `app/Repositories/Bill/BillRepository.php` — bills store `amount_min` / `amount_max` and
  `expectedAmount = (amount_min + amount_max) / 2`; a transaction matches a bill when its
  amount falls in the min/max band and its date lands on a generated pay date (`automatch`
  flag controls auto-linking; manual `LinkToBill` rule action exists).
- Key property: **the schedule is user-declared**; Firefly predicts from the declared rule and
  links observed transactions into it. There is no discovery from raw history.

Borrowable: amount band (min/max instead of equality), the `lastPaid` watermark, and the
end-of-month clamping logic (the 30th-of-month in a 28-day February).

## Actual Budget (schedules)

Verified from source (`packages/loot-core/src/server/schedules/app.ts`):
- A schedule is a stored rule whose conditions are payee, account, amount, and a recurring
  date condition. `discoveredSchedules` indexes these paths into
  `schedules_json_paths (schedule_id, payee, account, amount, date)` for fast lookup.
- Next-date computation (`getNextDate` / `getNextDateAfter`) walks the recurring rule forward;
  the app tracks `local_next_date` vs `base_next_date` and posts a "paid" status when a
  matching transaction lands inside the expected window.
- Key property: same as Firefly — **declared schedule + matcher**, with a discovery helper
  that *suggests* candidates from transactions sharing payee+amount+cadence, but the schedule
  only becomes real when the user saves it.

Borrowable: candidate discovery as a suggestion (not auto-creation); the "paid within window →
advance the schedule" state machine.

## ParsePay (SMS-ledger, closest analogue)

From the repo survey (2026-10-08): rule-based extraction of amount/merchant/type with a
scikit-learn transaction classifier and spaCy NER as the ML layer, falling back to rules on
low confidence. No true recurring-detection engine observed — detection stops at
transaction-vs-not. Confirms Kharcha's Schedule/Pattern layer is the missing piece in this
class of tools, not a solved problem to copy wholesale.

## Maybe

No recurring-detection engine found in its docs/source worth borrowing (rules are manual).
Noted as a gap in the ecosystem rather than a source.

## Recommendations for Kharcha

**Schedule detector** (regular interval ± few-day margin):
1. Discover candidate series from the ledger: group by (payee key, direction, account), sort
   by body-timestamp, and look for N ≥ 3 consecutive gaps clustering around one interval
   (weekly 7 / fortnightly 14 / monthly ~30 / quarterly ~91 days, ±margin).
2. Tolerance as a function of interval, not fixed days: ±2 days on weekly, ±4 on monthly
   (monthly-bill senders drift 1-3 days), ±5 on quarterly. Mirror Firefly's EOM clamp for
   month-end payees (28th-31st).
3. Amount: min/max band per series (Firefly's model), seeded from observed amounts ± the
   smallest rounding bucket (₹10), widened only deliberately.
4. Cold start: declare a Schedule only at 3 occurrences (2 gaps). The known-real SI series
   (₹47,000 monthly HDFC→PNB, 12+ occurrences in the corpus) is the fixture.
5. Adopt Actual's state machine: expected-next date advances only when a transaction lands in
   the window; a missed window marks the Schedule "lapsed", never deletes it.
6. Duplicate_review rows are excluded from Schedule evidence (per the map's standing rule).

**Pattern detector** (same payee, similar amounts, irregular):
1. Same grouping key as Schedule, but no interval regularity requirement — instead require
   ≥ 4 occurrences across ≥ 3 distinct months within the ledger's span.
2. Amount band ±15% of the median, or rounded-to-₹100 buckets — both surfaced, matching is
   on either.
3. Display as habit statements with counts and ranges ("Amazon Pay: 6 spends, ₹686–₹2,652,
   over 3 months"), never a predicted next date. A group qualifies as Schedule only if step
   1 of the Schedule detector passes; the two labels are exclusive per series.
4. Payee key: alias if it exists, else raw merchant, else counterpartyLast4 — and re-key
   existing series when an alias is created (retroactive grouping follows the alias decision
   in WF-1).
