# Verification gate: proving each phase on the real device

status: **operator-approved rules** (WF-9, 2026-11-20). Each phase's checklist is signed at that phase's gate.
applies to: [app-modification.md](app-modification.md), phases P1–P6

**Pseudonyms.** Account digits, payee and person names, and personal amounts in these
docs are invented stand-ins. The key mapping them to real values is kept privately at
`/root/lab/work/kharcha-pseudonyms.md` (never committed). Gate sessions read it when a
checklist item names an account or amount.

A phase counts as done only when all three of these hold:

1. **CI-side checks are green:** `npm run lint`, `npm run typecheck` and `npm test` in `mobile/`.
2. **The local replay hits its numbers:** the phase's numeric targets on the fixed 9-month corpus (§3).
3. **The device checklist is signed:** the operator performs or observes each step, and the
   session captures evidence (§4).

The next phase doesn't start until the previous one is signed.

---

## 1. Rules (operator decisions)

| Topic | Rule |
|---|---|
| **Harness** | CI runs **synthetic** fixtures only. The real corpus replay is a **local** script, gated on env vars that point outside the repo. The real export, statements and anything derived from them are never committed. `origin` is the public upstream repo. |
| **Cadence** | There's a device gate after **every** phase (P1–P5). P6 is a final full regression on a release-mode build. |
| **Evidence** | The operator ticks each step. The session captures adb screenshots and pulls the SQLite database to assert stored state. Evidence stays outside the repo. |
| **Pass bars** | Exact numbers are asserted on the **fixed-corpus replay**. Device checks are **behavioral**, plus sanity bounds against figures the operator reads from the bank app. The device inbox has SMS newer than the export, so its counts aren't expected to match the replay. |

## 2. Build and connect

None of P1–P5 change the Kotlin SMS module (`modules/kharcha-sms`), so the native build
happens once:

- **One-time (start of P1):** `npx expo prebuild --platform android --no-install`, then
  `cd android && nohup ./gradlew assembleDebug > <evidence>/gradle.log 2>&1 &` and poll the
  log. The first build takes about 18 minutes. Afterwards, `adb install -r
  app/build/outputs/apk/debug/app-debug.apk`.
  - Rebuild only if `package.json` native dependencies, `app.json` plugins/permissions, or
    `modules/` change. Any phase that does so has to say so in its session brief.
- **Each gate:** `npx expo start`, then `adb reverse tcp:8081 tcp:8081`, then reload the
  app.
- **Connect:** re-enable Wireless debugging on the phone. Pairing persists, so `adb connect
  <ip>:<port>` is enough (last seen at `<phone-ip>:<port>`, but the port changes on
  every enable). The operator reads the current port from the phone.
- **P6 only:** `./gradlew assembleRelease`, which uses the Expo template's debug signing.
  This is the build that proves the bundled JS works with no Metro.

### Database safety (every gate, before installing or reloading new code)

Migrations are one-way, and the device holds the real ledger. So, before the new code
first runs at each gate:

```
adb shell am force-stop dev.kharcha.app
for f in kharcha.db kharcha.db-wal kharcha.db-shm; do
  adb exec-out run-as dev.kharcha.app cat files/SQLite/$f > <evidence>/pre-<phase>-$f 2>/dev/null
done
```

The database runs in WAL mode, so the `-wal` file can hold committed rows. All three
files are pulled together, and opening the copy on the host with `sqlite3` checkpoints
it. expo-sqlite keeps its databases under `files/SQLite/`. The P1 session confirms the
path with `run-as … ls` on the first pull and corrects this line if it differs.

`pre-P1.db` is the baseline on the v1 schema and is kept until P6 signs. If a migration goes
wrong, the recovery is to push the pulled copy back with `run-as` (debug build) and
reinstall the previous APK/JS.

## 3. Local replay harness (built in P1, extended each phase)

- `mobile/scripts/replay.mjs`, run with `npm run replay`. It reads:
  - `KHARCHA_CORPUS`: the raw SMS export CSV (today
    `/root/projects/kharcha/All Conversations 2026-10-08 11:39:44.csv`, which is untracked
    and must stay that way).
  - `KHARCHA_REPLAY_OUT`: an output directory outside the repo.
  - It exits 0 with a "skipped" message when `KHARCHA_CORPUS` is unset, so CI never needs
    the corpus.
- It runs the same pipeline as the app: parse, then build an in-memory `node:sqlite` ledger
  through the real migrations and ingest path, then run each pure detector. It prints a
  JSON summary and fails on any target miss.
- **Reconciliation:** `/root/lab/work/kharcha-reconcile-csv-20261009/reconcile3.py` is
  re-run against the replay's transaction export. The bar is **≥ 608 / 646** matched
  statement rows, i.e. no regression from today's baseline.
- **Baselines:** the first run of each new metric writes `<out>/baseline-<phase>.json`.
  Later phases assert they don't regress against those baselines, so a parser change
  shows up as a number moving.

### CI-side synthetic fixtures (committed)

- Each rule gets a hand-written fixture that uses invented banks, payees, digits and
  amounts that keep only the *shape* of real messages. Examples: a double-notify pair
  6 min apart from sibling senders, a payee-only pair 18h apart that must *not* flag, an
  anchor sequence with a planted gap, a 3-hit monthly series with an end-of-month anchor
  on the 31st, a busy grocery-style frequent merchant whose 3 purchases line up but fail the
  share gate, and three Workspace-style variant strings that merge once named.
- Every migration step is tested on a synthetic v1 database.

## 4. Evidence and sign-off

- Evidence directory: `/root/lab/work/kharcha-gate-<phase>-<yyyymmdd>/`. It holds
  `pre-<phase>.db`, `post-<phase>.db`, `replay.json`, the screenshots (`adb exec-out
  screencap -p > NN-<step>.png`), and `checklist.md`.
- `checklist.md` is the copy of the phase checklist below. Each item records `[x]`, the
  evidence file(s), and any observed value. A **DB assertion** is a SQL query run on
  `post-<phase>.db`, stored with its output.
- **Sign-off:** the operator types "P<n> signed" in the session. The session then appends
  the date and that line to `checklist.md`, and records the phase close in its commit
  message. The commit includes no evidence files.
- A failed item blocks the gate. The fix happens in the same phase session, and the gate
  re-runs only the failed items, plus the full checklist if the fix touched migrations.

---

## 5. Checklists

Notation: **R** = replay target (numeric, fixed corpus) · **D** = device step (operator) ·
**DB** = assertion on the pulled database.

### P1: Identity and naming

- **R** Every parsed row with a last4 has `account_id`, and every row with a merchant or
  counterparty has `payee_id`. The row count is unchanged by the migration.
- **R** The set of accounts equals the distinct `(bank family, last4)` pairs in the corpus
  (written to the baseline).
- **R** `counterparty_masked` is non-null on exactly the rows where the parser emits it.
- **DB** On `post-P1.db`: `PRAGMA user_version` = 2, the transaction count equals
  `pre-P1.db`'s, and no row's `merchant` differs from `pre-P1.db`.
- **D** Open a masked-transfer row (e.g. to `a/c **5280`). The payee row shows the default
  label. Name it. Every past row for that payee shows the name (spot-check 3 in the
  history), and the reach line said "Applies to N" with N matching the DB count.
- **D** Clear that name. The default label comes back everywhere.
- **D** Give a payee a default category. A row with a hand-set category keeps it, and the
  others adopt the default.
- **D** *Move this one* on a single row changes only that row.
- **D** On the Accounts screen, the ••8812 debit-card suggestion appears. Link it to ••3391.
- **D** Home naming card: it appears for an unnamed payee with ≥3 rows. Choosing *Not now*
  means it doesn't return for that payee after an app restart.
- **D** Do a fresh scan (open the app after a new bank SMS arrives). The new row gets the
  existing payee's name with no action.

### P2: Duplicate review

- **R** **86** flags on the corpus, 11 of them > 30 min apart. 0 flags on the Highway Fuels
  / Suresh Kumar Rao ₹50 pair (and none on any different-payee pair > 30 min apart).
  *Amended 2026-11-21 (operator-approved):* WF-5's estimate was 92/13, but it was measured
  on an earlier parse (its old-rule count was 116; the current parse gives 120). Under the
  rule as written, both the upgrade relink and scan ingest flag the same 86 pairs, and every
  legacy flag the rule drops fails its account or payee test.
- **R** The Couldn't-read set: every row has an amount and a transaction verb, none matches
  the promo exclusions, and the count is ≤ 100 (baseline recorded).
- **DB** `user_version` = 3. Every `duplicate_review` row has `duplicate_of` set, and no
  legacy flag is orphaned.
- **D** **Cross-scan double-notify:** wait for (or trigger, e.g. with a small UPI payment) a
  transaction that HDFC notifies from two senders. Scan after the first SMS and again
  after the second. The second gets flagged.
- **D** Merge a pair: the totals on Home drop by one copy, and the survivor shows "1 merged
  copy". Unmerge it: the totals come back.
- **D** *Keep the other* swaps the survivor (check which body remains in the ledger).
- **D** *Keep both*, then rescan: the pair never re-flags.
- **D** The Home duplicate card outranks the naming card and disappears at 0 pending.
- **D** Couldn't read: *Add as transaction* prefills the amount and time and links the row.
  *Dismiss* removes it, and the DB shows its `raw_body` blanked.

### P3: Balances

- **R** Anchor counts match WF-4: PNB ••7712 at 15/17 debits, ••8812 at 42/88, ••3391 at
  31/177, and ICICI ••6119 limits on its spends.
- **R** Per-account gap count and |Σgap| are recorded in the baseline. Any gap > 5% of the
  balance or > ₹5,000 is listed for review, as possible missed SMS.
- **DB** `user_version` = 4. `reported_balance_paise` is non-null on the anchor rows.
- **D** **Sanity bound:** ••3391's balance on the Accounts screen equals the HDFC app's
  current balance, apart from anything that shows in the account history as an
  unexplained-difference row. The operator reads both figures.
- **D** The same check for PNB ••7712.
- **D** ICICI ••6119: enter the credit limit. The outstanding equals the ICICI app's
  outstanding to within transactions not yet notified.
- **D** Unlink ••8812, and the ••3391 balance ignores the card-side anchors. Re-link it, and
  they apply again.
- **D** Tap a gap row and log it as "Interest". The gap shrinks by that amount.
- **D** The Home **Net** line equals Σ bank − Σ card outstanding on the Accounts screen.

### P4: Schedules

- **R** **8** candidates (5 active, 3 lapsed), no Fresh Mart. With the three Workspace
  payees named identically, one 22-hit monthly series.
- **DB** `user_version` = 5.
- **D** The first scan after upgrade suggests **Google Play ₹299** and the **₹47,000
  HDFC→PNB** transfer (two suggestions, one per side, as designed).
- **D** Track Google Play: it reads *Paid* this month (or *Due*/*Upcoming*, matching the
  calendar), and the Home **Upcoming this week** strip shows it when its window opens
  within 7 days.
- **D** *Not a schedule* on one suggestion, then rescan: it doesn't return.
- **D** Name the three Workspace payees "Google Workspace": they collapse into one
  suggestion.
- **D** *Track as schedule* from a single bill row creates an active Schedule right away.
- **D** No notification fires at any point.

### P5: Habits

- **R** Habit groups over the trailing 180 days are recorded in the baseline. They include
  Fresh Mart and Blinkit, and exclude UNKNOWN MERCHANT, self-transfers and the ICICI
  card bill. A tracked Schedule's matched rows aren't counted.
- **DB** `user_version` = 6.
- **D** Insights → Habits lists Active habits with no date, range or due wording.
- **D** Rename two Zomato variant payees to "Zomato": one Habit, right away.
- **D** *Not a habit* on a payee removes it, and that survives a rescan and an app restart.
- **D** Tracking a Schedule for a payee removes those rows from its Habit count.

### P6: Final regression (release build)

- **R** The full replay passes all P1–P5 targets, with no baseline regression, and
  reconciliation stays **≥ 608 / 646**.
- **CI** It's green on synthetic fixtures with `KHARCHA_CORPUS` unset, which proves CI
  doesn't depend on the corpus.
- **D** Upgrade path: install the release APK over the P5 build. The app opens on the
  existing ledger with names, links, merges and Schedules intact, and no Metro running.
- **D** **Upgrade from v1:** this runs on the debug build *before* the release install.
  Push `pre-P1.db` and launch: the migrations go v1→v6 in one go. Then check
  names/payees/accounts exist for all rows and re-run the P2–P5 **R**-style counts on the
  pulled result. Afterwards, restore the current ledger by pushing `post-P5.db` back.
- **D** **Backup round trip** (only if backup is configured): *Back up now*, then restore
  on the same device. Names, links, merges, Schedules and dismissals all survive (this is
  snapshot schema 2). A pre-P1 schema-1 backup, if one exists, restores and migrates
  forward.
- **D** A fresh-install onboarding plus the first (whole-inbox) scan works. This runs only if the
  operator accepts clearing app data, after a pull and a backup. It's optional.
- **D** Spot-check the P1–P5 device items once more on the release build: one per phase.

## 6. Hand-offs and findings

- **Real SMS text is already committed in `mobile/test/parser-corpus.test.mjs`.** Its 36
  cases come from the operator corpus (real account digits, refs, VPAs and personal names).
  The branch isn't pushed yet (25 local commits ahead of `origin/main`). Under the
  synthetic-CI rule, these cases should be re-synthesized (same shapes, invented values)
  before anything is pushed or proposed upstream. History rewriting is a separate decision.
- The replay harness (`scripts/replay.mjs`) and the synthetic fixture set are P1
  deliverables. App-modification spec §8 is updated to point here.
