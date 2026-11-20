# GLiNER2.5-small as on-device SMS classifier: eval results and no-go

Checkpoint under test: `fastino/gliner2.5-small-v1` (74M, DeBERTa-v3-xsmall encoder,
Apache 2.0, boundary architecture). Test date 2026-10-08, host aidev LXC, 4 vCPUs,
PyTorch 2.14.1+cpu, Python 3.13, gliner2 2.0.0. Eval harness and label file live in
`/root/lab/work/kharcha-gliner-eval-20261008/` (see its README.md for the rerun command).

Verdict: **no-go for on-device deployment with the base checkpoint.** It loses to the
existing regex parser on most fields the app needs, and its per-classification-head
accuracy is too low to gate the ledger safely. Latency is fine. Accuracy is the blocker.

## Method

- Real SMS export (`All Conversations 2026-10-08 11:39:44.csv`, 4640 rows, received
  inbox rows: 4517) replaced the earlier 908-row adb window as the corpus. The eval set
  is 83 received rows covering 40+ sender families: HDFC (Sent/credit/FASTag/AutoPay/
  withdrawal/OTP/service/promo), PNB, SBI UPI, ICICI card, OTP senders, billers,
  govt advisories, Hinglish spam, personal texts, RBM/MMS bodies.
- Labels are LLM-assigned silver labels (cross-checked during build against the regex
  parser's output), committed at `eval_final.jsonl` + `labels` field in the harness dir.
  They are not human gold; ambiguity notes are in the build script.
- Schema: three classification heads (is_bank, kind, direction) plus a `txn` structure
  (amount, payee_or_payer, account_hint), run in one `extract()` call, batch of 1,
  4 torch threads. Model input: SMS body only (same input the regex parser gets).
- Label-set variants tested and rejected or reported separately: descriptions on every
  label (flat), sender header prepended to the body (is_bank 74.7→79.5%), money-flow
  phrasing for direction/direction-kind (direction on true transactions 41→82% but
  non-transaction gating collapses). Metrics below are the frozen primary config.

## Latency (batch of 1, 4 threads)

- Cold model load from HF cache: 4.1s and 4.2s across two loads (first run includes
  tokenizer normalization, negligible).
- Full schema (3 heads + txn structure): mean 81ms, p50 72ms, p95 137ms per SMS
  (n=249 = 3 repeats over 83 rows; repeat walls 6.93/6.78/6.56s, drift <6%).
- Classification-only schema: mean 69ms, p50 60ms, p95 125ms.
- Tokens per SMS (DeBERTa vocab): mean 61, median 50, max 392.
- Limiter: single DeBERTa encoder forward (~88% of wall, dominated by nn.linear).
  One forward per extract call. The regex parser costs 0.005ms per SMS for scale.

## Accuracy vs regex baseline (83 rows, 39 true transactions)

| metric | GLiNER base checkpoint | regex `parseBankSms` |
|---|---|---|
| is_bank | 74.7% (16 bank FPs, 5 FNs) | n/a (no head) |
| kind exact 5-way | 59.0% | n/a |
| transaction detect (binary) | 77.1% | **92.8%** |
| direction on true txns | 41.0% | **92.3%** |
| direction on all rows | 56.6% | **91.6%** |
| amount exact | 92.3% | **94.9%** |
| payee_or_payer | **43.6%** | 12.8% |
| account hint | 2.6% | **87.2%** |

Kind confusion (true→pred): 38/39 transactions kept; the 15 errors come from
money-mention non-transactions being called `transaction` (6 of 8 promos, 7 of 19
service rows), plus 7 service rows read as OTP. is_bank FPs concentrate on
investment spam with cashback wording, loan pre-approvals, utility
bills, and merch SMS with rupee amounts.

## Failure analysis (what shapes it gets wrong and why)

1. **HDFC UPI debit direction blindness.** The most common real shard
   (`Sent Rs.X | From HDFC Bank A/C *NNNN | To P | On D | Ref R`, 187 of 241
   reach-rows in the older window) has its debit captured by the amount and payee
   record but the `direction` head answers `not_a_transaction` for most `Sent`
   shapes. `sent` is presumably trained as a neutral word. 15 of 39 txn rows lose
   direction here.
2. **Money-mention promos claim transactions.** Loan offers ("pre-approved ... 500,000"),
   recharge offers ("Get 2GB at Rs33"), cashback spam ("You received Rs.23,283
   cashback"), Bata point reminders: all produce a `txn` record with an amount and
   often `debit`/`credit`. Extractor needs post-filtering, or never trusts kind=txn
   from words alone.
3. **Pending and failed payments read as transactions.** SBI collect request
   ("money will be debited frm ur a/c"), Blinkit Google-Pay request, failed SI —
   all recorded as debit transactions.
4. **OTP-with-amount shapes.** ICICI transaction OTPs ("One-Time Password for INR
   2103.00 transaction towards AMAZON") FP as transactions with a full record. This
   is exactly the shape where wrong ledger rows do damage.
5. **Utility/govt service bodies in Hindi** (UHBVNL bills) get `bank_sms` + debit.
   Hinglish spam bodies ("aabet account kholne ka time hai") are classified
   promotional correctly but with bank-ish confidence signals elsewhere.
6. **account_hint is mostly null** (1/39): the record decoder rarely emits the
   masked-digits span; the regex account patterns win decisively.

## Recommendations

- Keep the regex parser as the production path. It beats the checkpoint on every
  field except payee, at ~4 orders of magnitude less compute.
- Payee extraction is the one field where the checkpoint beats the regex baseline
  (44% vs 13%) and its amount exact extraction is close. A hybrid (regex primary +
  model only as an offline payee/categorization aid) is the only shape where the
  checkpoint earns its place today.
- If the pattern-free classifier is still wanted, the path is a fine-tune of this
  same checkpoint on labeled real SMS, not more prompting: label-set experiments on
  this harness moved direction accuracy by ±40pp across variants, which shows prompt
  sensitivity rather than capability. Park until a labeled corpus (a few hundred
  bank + noise SMS) exists; rerun this harness against the fine-tuned checkpoint.
- Cross-provider transaction dedupe stays parked per the standing instruction.

## Rerun

```
cd /root/lab/work/kharcha-gliner-eval-20261008
python3 -m venv .venv
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install "gliner2[local]" sentencepiece protobuf
python3 build_evalset_v2.py     # rebuild eval_final.jsonl from the repo CSV
.venv/bin/python eval_model.py  # latency + model_preds.jsonl
node /tmp/baseline-eval.mjs     # regex preds -> baseline_preds.json
python3 score.py                # tables
```
