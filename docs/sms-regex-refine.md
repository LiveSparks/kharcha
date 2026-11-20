# SMS regex parser refinement — corpus report (2026-10-08)

Regex agent work on `mobile/src/lib/parser.ts`, branch `feat/regex-refine`.

Corpus: the operator's real export `All Conversations 2026-10-08 11:39:44.csv`
(4,639 usable rows: HDFC 2,067, ICICI 257, PNB 82, SBI/RCS-other 92, rest is
OTP/promo/service noise). Adjudicated labels: `eval_final.jsonl` (83 rows) from the
model-agent eval round; `vela_train.jsonl` (2,090 rows) treated as provisional and
re-adjudicated against the raw corpus.

## Rerun commands

```bash
# unit tests (38 green: 9 existing + 29 corpus-shape pins)
cd mobile && npm test

# corpus verification harness (shape oracles vs parser on all corpus rows) and
# label agreement on the adjudicated eval set + provisional vela_train set
cd /root/lab/work/kharcha-regex-refine-20261008
node --experimental-strip-types verify.mjs        # 1,622/1,624 fully ok (2 skip = USD spends)
node --experimental-strip-types agree.mjs eval_final.jsonl   # 83/83 = 100%
node --experimental-strip-types agree.mjs vela_train.jsonl   # 1,885/2,090 = 90.2% (see below)
```

## Results

| Metric | Before | After |
|---|---|---|
| eval_final.jsonl (83 adjudicated rows) | partial (direction only, known payee bug) | **100%** (direction, amount, payee, account) |
| corpus bank-transaction rows | — | 1,622/1,624 fully parsed (2 foreign-currency skips, documented) |
| vela_train agreement | 90.4% label agreement (old parser) | 90.2% field agreement — every remaining disagreement is a documented vela error (see "Adjudications") |

Per-shape corpus coverage (rows / fully correct / why a row can differ):

| Shape (bank) | Rows | OK | Notes |
|---|---|---|---|
| Sent Rs UPI debit (HDFC) | 1,115 | 1,115 | payee only from the declared `To` section; the `SMS BLOCK UPI to 7308080808` tail can never win |
| Credit Alert! UPI credit (HDFC) | 119 | 119 | payer = VPA |
| ICICI card spend | 86 | 86 | USD spends skip (no INR amount in message) |
| Spent At card debit (HDFC, cards x8812/x5529) | 69 | 69 | |
| Toll Paid / Alert Paid toll / Paid: At: (HDFC FASTag) | 58 | 58 | payee null (toll plaza ≠ merchant); on high-traffic days wallet balance is ignored |
| Update! deposited NEFT/RTGS/TPT (HDFC) | 30 | 30 | payer mapped from narration (rail/IFSC strip, TPT remitter, interest → null) |
| HDFC Bank:Rs debited to a/c (UPI) | 27 | 27 | masked payee account → payee null |
| ICICI card bill payment received | 21 | 21 | adjudicated: debit toward the card |
| AutoPay (E-mandate) Success | 21 | 21 | |
| PNB credited (UPI) | 19 | 19 | |
| PNB debited with / Dt thru UPI | 14 | 14 | |
| Update! INR debited (HDFC) | 6 | 6 | |
| subsidy credits (HDFC) | 6 | 6 | |
| Received! IMPS credit (HDFC) | 5 | 5 | |
| FASTag wallet recharge | 5 | 5 | adjudicated: debit from bank account into wallet, despite "credited to FASTag" wording |
| ICICI reversal/refund credits | 7 | 7 | |
| ATM withdrawals | 4 | 4 | adjudicated: payee null (ATM location ≠ merchant, matches eval gold) |
| ICICI SI payment processed | 2 | 2 | |
| Amt Deducted / Payment Successful / Transaction Reversed / NEFT beneficiary credit / Received Chq# / Debit Alert / Money Received / PNB PPF credit | 9 | 9 | |
| **Total** | **1,624** | **1,622** | 2 USD ICICI spends skip |

Everything else (OTP, promos, bill reminders, statement summaries, mandate notices,
declined/failed attempts, merchant acknowledgements, Annual Pass trip log) is rejected
by the gates; the corpus sweep confirms zero false positives outside genuine bank credits
(the only OTHER-family parses left are a real SBI carrier-routed credit, a real Canara
credit, and a PNB subsidy credit delivered from a phone-number sender — sender filtering
is a sender-rules concern, not a body concern).

## Parser changes

1. **Sent-shape payee bug (known weakness #1)** — the multiline
   `Sent Rs.220.00 | From HDFC Bank A/C *4620 | To SUNITA | ... SMS BLOCK UPI to 7308080808`
   body previously let the trailing `to 7308080808` phone number win the payee
   (`$` in the old merchant lookahead matched end-of-string, across newlines). The Sent
   shape now reads the payee only from the declared `To` section (line- and `|`-bounded)
   and requires it before any "Not You?" tail.
2. **Direction from money context (known weakness #2)** — re-derived cleanly: every
   corpus amount is tokenised with Rs/INR/₹ context; balance/limit/due-context amounts
   (Avl bal, Bal Rs, Wallet Bal, Avl Lmt, "Interest paid") are excluded; a direction verb
   (debited/spent/withdrawn/paid/sent vs credited/received/refunded/deposited/reversal)
   must sit within ~30 chars (before) or ~45 chars (after) of the amount. If no amount
   is verb-adjacent, the whole-body wording decides, still refusing mixed movement
   (`debited and then credited` → null). Phrases like *"we have sent you an email"*
   never anchor because `sent` is only a debit anchor when directly followed by a currency.
3. **Pending/failed gate (known weakness #2)** — collected from corpus evidence:
   approval requests (`has requested money`, `on approval`, `once approved`),
   future mandates (`will be debited/credited/deducted`, `to be debited`, `will change to`),
   reminders (`overdue`, `ignore if paid`, `amount to be paid`, `needs to be paid`, `opt for`),
   failures (`declined`, `failed`, `failure`, `not processed`, `insufficient funds/balance`),
   and merchant-side acknowledgements (`we have received (a) payment`, `payment received`,
   `thank you for booking`, `your order … processed`, `your main account balance`) — the
   same money already lands through the bank's own debit SMS.
4. **Shape-first parsing** — 29 ordered shape parsers (per bank family) own direction,
   amount, payee, account hint, and reference for their bodies; a hard-adjudicated
   generic path handles everything else. Incoming RCS bodies are NFKC-normalised first,
   which restores PNB/SBI Mathematical Sans-Serif routing variants (`𝖣𝖾𝖻𝗂𝗍𝖾𝖉` → `Debited`).
5. **Gate fixes** — OTP detection no longer fires on legitimate `without PIN/OTP`
   wording in card-spend alerts; promo keywords cover the corpus's spam shapes
   (`cashback`, `voucher`, `claim`, `off your bill`, `bit.ly`, …).

## Adjudications (corpus decisions that override vela_train's provisional labels)

These are the reason vela agreement is capped at ~90%: vela was distilled from the old
parser's logic, so its errors mirror old-parser bugs. Every case is auditable in
`mismatch_*.txt` and `vela_disagreements.txt` in the work dir.

| Corpus evidence | vela said | Adjudication |
|---|---|---|
| `Annual Pass Trip! … crossed …` (35 rows, no money) | transaction/debit | **not a transaction** — no money moved, pure trip log |
| `has requested money/₹ … will be debited on approval` (7) | transaction/debit | **pending** — needs user approval |
| `to be debited … is due by` SI mandate notices (1) | transaction/debit | **pending** |
| `Payment Failed / SI FAILED / declined` (4) | mixed | **not transactions** — money did not move |
| `Spent Rs / Spent From Card / Toll Paid` (14) | service_update | **transaction debit** — real card/FASTag charges |
| `INR 3.67 deposited … towards subsidy` (2) | service_update | **transaction credit** — money to the bank account |
| `credited/refunded with Rs` / `Reversal of Rs … credited` (1) | service_update | **transaction credit** — refund to card |
| `Payment of Rs … received on your ICICI Card via BBPS` (4) | service_update | **transaction debit** — card-bill payment leaves the bank account |
| `Payment Successful! Rs … to ICICI BANK CREDIT CA` (1) | service_update | **transaction debit** |
| `NEFT transfer … credited to ACME TOUR AND TRAVEL` (1) | transaction/credit | **transaction debit** — "credited to" refers to the beneficiary; the user paid |
| `Airtel: we have received payment of Rs` (3) | not_bank (and transaction/debit elsewhere) | **not a transaction for a bank-SMS parser** — merchant-side acknowledgement; the same money arrives via the bank's own debit SMS (e.g. PNB `debited INR 3780.25 Dt` == the Airtel bill) |

## Cannot be parsed (documented exceptions)

| Rows | Message | Reason |
|---|---|---|
| 2 | `USD 82.59 / USD 100.00 spent using ICICI Bank Card XX6119 …` | no INR amount in the message (only the limit is in INR); skip rather than guess a rate |
| ~6 | PNB/SBI RCS bodies truncated mid-surrogate (`…𝖣𝗈𝗐\ud835`) in the export | the carrier clip is truncated in the source data; NFKC recovers the rest, tail noise is harmless |

Everything else in the corpus either parses fully or is, by adjudication, not a
 transaction.

## Branch state

- `feat/regex-refine`: 3 small commits — parser rework, corpus adjudication pass, test pins.
  `fix/sms-retrieval` and `main` untouched; nothing rebased or pushed.
- The CSV export stays untracked at the repo root (operator data, not for git).
