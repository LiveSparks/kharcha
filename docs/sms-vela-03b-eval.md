# Vela-2.0-0.3B as the SMS classifier: zero-shot, Hinglish, and fine-tune probe

Sibling of `sms-gliner-small-eval.md` (same harness, same 83-row silver eval set,
same scorer, same regex baseline). Eval date 2026-10-09 host aidev LXC, 4 vCPUs,
PyTorch 2.14.1+cpu, fp32 torch backend per the model card's own parity note.
Checkpoint `vllm-sr/Vela-2.0-0.3B` (0.3B, 22-layer ModernBERT-style encoder, 17
languages, Apache 2.0). Harness and artifacts in
`/root/lab/work/kharcha-gliner-eval-20261008/` (vela_eval.py, vela_hinglish.py,
vela_train.py, vela_ft_heads.pt).

Verdict: **the hybrid architecture is now the measured winner, with a twist.** The
regex parser stays primary for amount/account extraction. A heads-only fine-tuned
Vela 0.3B beats the regex transaction gate (96.4% vs 92.8%) and matches it on
direction. Zero-shot it does not clear the bar. Payee stays open in both model
families; neither model beats regex on amount/account and only fine-tuned (not yet
measured on spans) paths could close payee.

## Latency (batch of 1, 4 threads, same protocol as the gliner round)

| | gliner2.5-small | Vela 0.3B zero-shot | regex |
|---|---|---|---|
| cold load | 4.1-4.2s | 1.6s | none |
| per-SMS full schema mean/p50/p95 | 81/72/137ms | **531/519/616ms** | 0.005ms |
| cls-only mean | 69ms | 431ms | - |
| tokens per SMS (model vocab) | 61 | 411 | - |

The expected 2-4x slowdown became 7x. The full request encodes the SMS once per
question group; the three heads plus span question cost 411 input units against
gliner's 61. n=249 timed calls (3 repeats over 83 rows, repeat walls 44.9/43.7/43.5s,
drift under 4%). That is 521ms/SMS steady state on this host. On phone-class silicon
this is a candidate for the ONNX fp16 export the repo ships, not for torch fp32.
Latency is not the blocker; accuracy is (below).

## Accuracy (83 silver rows, 39 true transactions)

| metric | regex | gliner2.5-small | Vela zero-shot | Vela fine-tuned heads |
|---|---|---|---|---|
| is_bank | n/a | 74.7% | 84.3% | **97.6%** (0 bank FPs) |
| kind exact 5-way | n/a | 59.0% | 80.7% | **83.1%** |
| transaction detect | 92.8% | 77.1% | 94.0% | **96.4%** |
| direction (txn rows) | **92.3%** | 41.0% | 53.8% | **92.3%** |
| direction (all rows) | 91.6% | 56.6% | 73.5% | **95.2%** |
| amount | **94.9%** | 92.3% | 0% | 2.6% |
| payee | 12.8% | **43.6%** | 7.7% (28.2% via PII-label variant) | 7.7% (span head untrained) |
| account hint | **87.2%** | 2.6% | 1/39 | 5.1% |

Fine-tune probe: 2090 train + 233 dev weak-labeled rows (weak labels distilled from
the parser's own verb/sender logic, 90.4% kind agreement with the silver labels,
measured by running the labeler on the 83 silver rows), encoder frozen, 2.2M
trainable head parameters, AdamW 1e-4, 3 epochs in 42.9 minutes on 4 vCPUs inside a
self-imposed 45-minute wall cap. The 83-row eval set was excluded from training.
Epoch 1 already gave is_bank 96.4 / direction 91.6; epoch 3 finished at 97.6 / 94.0.
Span/record extraction was NOT fine-tuned in this probe and stayed at its zero-shot
level (2.6-7.7%): the record is not yet model-grade.

## Hinglish verdict (30-row slice from the real export, 30 distinct Hindi families)

Zero-shot Vela reads the Hindi correctly but gates it badly on rupee mentions:
is_bank 63.3%, kind 70.0%, and 11 of the 30 bank FPs are electricity bills, property
tax notices, and a CITYCORP payment acknowledgment calling themselves bank messages.
The one true payment row (ru 3262.42 paid to CITYCORP) got kind=transaction but
direction=credit (wrong, user paid out). The code-mixed scam ("aabet account kholne
ka time hai, random bonus...") was caught as promotional correctly. Hinglish SMS in
this inbox are concentrated in exactly the categories a ledger does not need
(bills, notices, promos), so the miss is cheaper there than on transactions, but the
is_bank head needs Hindi-heavy training rows before trust.

## Failures worth recording

1. Zero-shot span extraction with custom open-label criteria is unusable: offsets
   come back but label-to-content association scrambles (payee label on the user's
   own account line, amount label on a dot, one empty record in four).
2. The trained PII entity path (ORGANIZATION/PERSON) extracts real counterparties
   (confidence 0.93-1.0) but best-prob selection picks the user's own bank line; an
   own-bank exclusion rule did not recover more payee hits (both 11/39).
3. Fine-tuning fixed the classification plane entirely (bank FPs went 12 -> 0 on the
   silver set) with only heads trainable. Direction gained 40pp with no
   architecture change. Fine-tune, don't prompt.

## Recommendation for Kharcha

1. **Regex stays the primary record extractor** (amount 94.9%, account 87.2%) and
   the fallback path (0.005ms).
2. **The fine-tuned Vela 0.3B heads are now a better transaction gate than regex**
   (96.4% vs 92.8%, direction parity on transactions, 95.2% all-rows direction) and
   beat it on the kind hierarchy. Suggested production shape: fine-tuned heads as
   the SMS gate and spam/OTP/suppress filter, regex for the record, low-confidence
   rows to a review queue.
3. Deployable only after: fine-tune the span head on the same weak labels (the
   missing lever for payee/account), validate on Hindi rows, and export ONNX fp16
   (repo ships the graph and PARITY.md; torch fp32 at 531ms/SMS is a host number,
   not a phone number).
4. Cross-provider dedupe remains parked.

## Rerun

```
cd /root/lab/work/kharcha-gliner-eval-20261008
.venv/bin/python vela_eval.py        # zero-shot latency + vela_preds.jsonl
python3 score.py vela_preds.jsonl
.venv/bin/python vela_hinglish.py    # Hinglish slice
python3 build_train_v2.py            # weak-label training split
.venv/bin/python vela_train.py       # 45-min capped heads fine-tune
python3 score.py vela_ft_preds.jsonl
node /tmp/baseline-eval.mjs          # regex preds -> baseline_preds.json
```
