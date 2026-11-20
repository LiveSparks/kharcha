# SMS import: symptom, root cause, fix, and how to reproduce the evidence

Branch `fix/sms-retrieval`, two commits on top of `main` (`8c5c388`):

- `ac60583` Match bank sender rules embedded in carrier routing variants (native filter)
- `4b37c05` Parse the Sent Rs amount shape for bank UPI debits (parser + tests)

`mobile/` npm test: 9/9 (7 baseline + 2 added).

## Symptom

No SMS ever imports. Historical import produces nothing, and foreground
re-scans add nothing either. On a device with READ_SMS granted and real
bank traffic in the inbox, the ledger stays empty with no error.

## Root causes (two, both backed by device evidence)

Test surface: OnePlus 7 Pro, Android 11, app `dev.kharcha.app` debug build,
wireless adb, provider corpus read directly through `content://sms/inbox`.

1. **Sender matching required exact equality.**
   `KharchaSmsModule.kt` normalized both sides with `uppercase()` plus a strip
   of `^[A-Z]{2}-`, then compared with set membership. Carriers route one bank
   header in several shapes: `HDFCBK`, `VM-HDFCBK`, `VMHDFCBKS` (prefix attached,
   channel letter appended). The device inbox holds 3012 rows; not one address
   equals a default rule after normalization, so the reader returned an empty
   list with no error. A/B on the same window and same since: default rules →
   native output 0 rows; adding the three real headers (`VMHDFCBKS`,
   `ADHDFCBKS`, `CPHDFCBNP`) → 386 rows, exactly 240+141+5.

2. **The parser dropped the bank's most common debit shape.**
   HDFC Bank UPI debits arrive as
   `Sent Rs.220.00 | From HDFC Bank A/C *4620 | To SUNITA | On 22/12/25 | Ref 611100000002`.
   Neither the debit keyword set (`debit`, `spend`, `paid`, `purchase`,
   `withdrawn`) nor the credit set matched, so `direction` was null and the
   parser returned null. With matching fixed, the default rules reach 241
   in-window rows and 187 of them are this shape; parse count before 18, after
   209, 105 unique after source-hash dedupe. The debit keyword is anchored to
   the money context (`sent` followed by an amount currency) so "we have sent
   you an email" wording stays out; the merchant reads the declared `To`
   section only within this shape because `from` there names the user's own bank.

Ruled out with evidence, not assumption: the date-range filter. `scanStart`
(full = now−90d, incremental = lastScanAt−120s) is correct against the
provider; the test device simply holds no newer SMS than 2025-12-22 while
its clock matched real time (2026-10-08), so the 90-day window had nothing
to return. This was demonstrated by shifting the device clock into the SMS
era (see runbook), where the window covered 908 rows.

## On-device verification (after both fixes)

- Fresh install, onboarding scan, default rules: Home shows 22 entries this
  month, 12 review entries, and the previously-dropped UPI debits (−₹220,
  −₹260, −₹50 at `··4620`/`··4471`) in Latest. Inbox rows keep the source
  message beside the parsed entry.
- Foreground re-activation (incremental scan): last-scan stamp advances
  (`Read Thu, 25 Dec` after `Read Mon, 22 Dec`), entry count and totals
  unchanged, no error banner: re-scans are idempotent, dedupe holds.
- Clock restored to real time: scan runs, imports 0 (provider genuinely has
  nothing in the last 90 days at real time), ledger keeps its entries.

## Rerun recipe

Environment notes: `LOCAL.md` at the repo root (adb path, build recipe,
no-foreground-command gotcha). The verifier artifacts referenced below live
in `/tmp` of the aidev host: `parse-audit.mjs`, `count-reach.mjs`,
`verify-sms.sh`, `kharcha-decisions.tsv` (decision log).

```
# 1. provider ground truth (adb must reach the phone over wireless debugging)
adb -s <ip:port> shell "content query --uri content://sms/inbox \
  --projection address:date:body --where 'date >= <now-90d-epoch-ms>'" > /tmp/inbox-window.raw

# 2. corpus through the real parser
node /tmp/parse-audit.mjs /tmp/inbox-window.raw
node /tmp/count-reach.mjs           # rows within default-rule reach, parsed, unique

# 3. end-to-end on the app surface (drives onboarding, permission dialog, home evidence)
S=<ip:port> bash /tmp/verify-sms.sh
```

If the device's SMS are older than 90 days at real time, shift the device
clock into the SMS era first (`settings put global auto_time 0`, then
`cmd alarm set-time <epoch-ms>`), and restore both afterwards.
