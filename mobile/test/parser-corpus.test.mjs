import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBankSms, occurredAtFrom } from '../src/lib/parser.ts';

// Each case pins a real bank message *shape* the regex parser must handle. All values
// (accounts, references, names, places, amounts, balances) are invented: this suite is
// committed to a public repo, so it never carries operator data. The real-corpus check
// is the local `npm run replay` harness (docs/spec/verification-gate.md).

// --- HDFC UPI --------------------------------------------------------------

test('multiline Sent shape reads the payee only from the To section', () => {
  const body = 'Sent Rs.142.00\nFrom HDFC Bank A/C *3391\nTo FRESH MART\nOn 01/02/26\nRef 61462000001\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808';
  assert.deepEqual(parseBankSms(body), {
    merchant: 'Fresh Mart', amountPaise: 14200, direction: 'debit', category: 'Transfers',
    accountLast4: '3391', reference: '61462000001', counterpartyMasked: null, counterpartyLast4: null, reportedBalancePaise: null, reportedAvlLimitPaise: null,
    confidence: 0.95,
  });
});

test('the blocked-number tail of the Sent shape never becomes the payee', () => {
  const body = 'Sent Rs.220.00 | From HDFC Bank A/C *4620 | To SUNITA | On 22/12/25 | Ref 61462000002 | Not You? | Call 18002586161/SMS BLOCK UPI to 7308080808';
  assert.equal(parseBankSms(body)?.merchant, 'Sunita');
});

test('executed UPI mandate under the UPI Mandate header is a debit', () => {
  const body = 'UPI Mandate:\nSent Rs.299.00\nfrom HDFC Bank A/c 3391\nTo Google Play\n06/11/25\nRef 61462000003\nNot You? Call 18002586161/SMS BLOCK UPI to 7308080808';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'debit');
  assert.equal(parsed?.merchant, 'Google Play');
  assert.equal(parsed?.accountLast4, '3391');
});

test('Credit Alert reads the payer VPA and the UPI reference', () => {
  const body = 'Credit Alert!\nRs.38000.00 credited to HDFC Bank A/c XX3391 on 02-09-26 from VPA dev.patel77@axl (UPI 61462000004)';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'credit');
  assert.equal(parsed?.amountPaise, 3800000);
  assert.equal(parsed?.merchant, 'Dev.Patel77@Axl');
  assert.equal(parsed?.accountLast4, '3391');
  assert.equal(parsed?.reference, '61462000004');
});

test('account-to-account UPI debit keeps the masked payee out of the merchant', () => {
  const body = 'Rs. 7420.00 debited from a/c *3391 on 14/08/25 to a/c **5280 (UPI Ref No. 61462000005). Not you? Call on 18002586161 to report';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'debit');
  assert.equal(parsed?.amountPaise, 742000);
  assert.equal(parsed?.merchant, 'Unknown merchant');
  assert.equal(parsed?.reference, '61462000005');
});

test('between-accounts UPI debit exposes the masked counterparty as structured data', () => {
  const body = 'HDFC Bank:Rs. 7420.00 debited from a/c *3391 on 14/08/25 to a/c **5280 (UPI Ref No. 61462000005). Not you? Call on 18002586161 to report';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'debit');
  assert.equal(parsed?.amountPaise, 742000);
  assert.equal(parsed?.accountLast4, '3391');
  assert.equal(parsed?.merchant, 'Unknown merchant');
  assert.equal(parsed?.counterpartyMasked, '**5280');
  assert.equal(parsed?.counterpartyLast4, '5280');
});

test('TPT deposits expose the remitter masked account as the counterparty', () => {
  const body = 'Update! INR 15,000.00 deposited in HDFC Bank A/c XX3391 on 29-DEC-25 for XXXXXXXXXX5803-TPT-family-MEERA SINGH.Avl bal INR 18,402.10';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.counterpartyMasked, 'XXXXXXXXXX5803');
  assert.equal(parsed?.counterpartyLast4, '5803');
});

// --- HDFC card -------------------------------------------------------------

test('card spend keeps the merchant and drops the trailing balance', () => {
  const body = 'Spent Rs.325.68 From HDFC Bank Card x8812 At GOOGLE WORKSPACE CYBS SI On 2025-07-03:16:26:01 Bal Rs.18210.55 Not You? Call 18002586161/SMS BLOCK DC  8812 to 7308080808';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.merchant, 'Google Workspace Cybs Si');
  assert.equal(parsed?.amountPaise, 32568);
  assert.equal(parsed?.accountLast4, '8812');
  assert.equal(parsed?.direction, 'debit');
});

test('lowercase alert-style card spend parses the merchant', () => {
  const body = 'Rs.6120.75 spent on HDFC Bank Card x8812 at GITHUB, INC. on 2025-02-19:07:07:31 Avl bal: 20511.80.Not You? Call 18002586161 / SMS BLOCK DC 8812 to 7308080808';
  assert.equal(parseBankSms(body)?.merchant, 'Github, Inc.');
});

test('ATM withdrawals have no merchant even when an ATM name is present', () => {
  const body = 'Rs.4000 withdrawn from HDFC Bank Card x8812 at STATION ROAD on 2025-03-18:11:00:56 Avl bal: 33100.20.Not You? Call 18002586161/SMS BLOCK DC 8812 to 7308080808';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'debit');
  assert.equal(parsed?.merchant, 'Unknown merchant');
  assert.equal(parsed?.accountLast4, '8812');
});

test('executed AutoPay mandates are debits with the billed merchant', () => {
  const body = 'AutoPay (E-mandate) Success!\nFor Google Workspace \nTxn Amt:INR325.68\nDt:03/07/2025\nVia:HDFC Bank DC 8812\nSI Hub ID: AbCdEfGh12\nTnC';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.merchant, parsed?.accountLast4],
    ['debit', 32568, 'Google Workspace', '8812']);
});

test('card refunds come back as credits to the merchant', () => {
  const body = 'Transaction Reversed!On HDFC Bank DEBIT/ATM Card xx8812 Amt: Rs.75 By CANVA* PZZZZX9Y8WQRTUV On 2025-10-02:11:57:42';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.direction, 'credit');
  assert.equal(parsed?.merchant, 'Canva');
});

// --- HDFC credits ------------------------------------------------------------

test('interest, escrow, and TPT deposit narrations map to payers', () => {
  const escrow = parseBankSms('Update! INR 36,210.50 deposited in HDFC Bank A/c XX3391 on 28-MAY-25 for NEFT Cr-INDB0000006-Acme Escrow Inc-Arjun Mehta-INDBN52025052800000417.Avl bal INR 71,230.40. Cheque deposits in A/C are subject to clearing');
  assert.deepEqual([escrow?.direction, escrow?.merchant, escrow?.accountLast4], ['credit', 'Acme Escrow Inc-Arjun Mehta', '3391']);

  const tpt = parseBankSms('Update! INR 15,000.00 deposited in HDFC Bank A/c XX3391 on 29-DEC-25 for XXXXXXXXXX5803-TPT-family-MEERA SINGH.Avl bal INR 18,402.10');
  assert.equal(tpt?.merchant, 'Meera Singh');

  const interest = parseBankSms('Update! INR 2,148.00 deposited in HDFC Bank A/c XX7713 on 30-SEP-25 for Interest paid till 30-SEP-2025.Avl bal INR 5,12,300.00');
  assert.equal(interest?.merchant, 'Unknown merchant');
});

test('IMPS credits keep the remitter name', () => {
  const body = 'Received!\nINR 12,750.00 in HDFC Bank A/c xx9025\nOn 30-12-25\nFor IMPS -KARAN MALHOTRA- 61462000006\nAvl bal INR 4,120.75';
  const parsed = parseBankSms(body);
  assert.equal(parsed?.merchant, 'Karan Malhotra');
  assert.equal(parsed?.accountLast4, '9025');
  assert.equal(parsed?.reference, '61462000006');
});

test('outgoing NetBanking transfers debit the named beneficiary', () => {
  const body = 'Payment Successful!\nRs. 9310.40 from A/c XX7713 to ICICI BANK CREDIT CA via HDFC Bank NetBanking.\nNot you?Call 18002586161';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.merchant, parsed?.accountLast4],
    ['debit', 931040, 'Icici Bank Credit Ca', '7713']);
});

test('cheque clearance is a debit from the paying account', () => {
  const body = 'Received Chq# 000001 of INR 75,000.00 for payment on 21-AUG-25. Paid from your HDFC Bank A/c XX7713. Avl Bal INR 3,40,500.00. Not you? Call 18002586161';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.accountLast4],
    ['debit', 7500000, '7713']);
});

// --- FASTag / tolls ----------------------------------------------------------

test('toll debits keep the amount and stay merchant-free', () => {
  const tollPaid = parseBankSms('Toll Paid!\nRs.65 for XX00AB1234\nAt Northway Toll\nOn 11-Aug-2025\nWallet Bal: Rs.912\nNot you? Visit https://hdfcbk.io/HDFCBK/s/Abc12345\nHDFC Bank');
  assert.deepEqual([tollPaid?.direction, tollPaid?.amountPaise, tollPaid?.merchant, tollPaid?.category],
    ['debit', 6500, 'Unknown merchant', 'Travel']);

  const alertPaid = parseBankSms('Alert!\nPaid Rs.185 toll for XX00AB1234 at Riverside Toll Plaza on 2025-03-16 19:52:02.\nHDFC Bank NETC FASTag balance: Rs.640.');
  assert.equal(alertPaid?.amountPaise, 18500);

  const fastagPaid = parseBankSms('Paid: Rs.50 At: City Mall Lot On: 2025-05-28 16:41:12 Vehicle XX00AB1234   Via HDFC Bank NETC FASTag  Bal: Rs 777');
  assert.equal(fastagPaid?.amountPaise, 5000);
});

test('FASTag wallet recharges are debits even though the wallet was credited', () => {
  const body = 'Alert! Rs.1000 credited to HDFC Bank NETC FASTag 19000011112222 on 6/20/2025 8:44:11 AM.  Avl Bal:Rs.1250. Enable Auto-Recharge';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.merchant], ['debit', 100000, 'Unknown merchant']);
});

test('Annual Pass crossings without money never become transactions', () => {
  assert.equal(parseBankSms('Annual Pass Trip!  Vehicle XX00AB1234 crossed Northway Toll on 2025-08-26 06:39:41  Remaining Trips: 197  Not you? Call 18001201243  -HDFC Bank FASTag!'), null);
});

// --- gates -------------------------------------------------------------------

test('pending, failed, and reminder money never lands in the ledger', () => {
  assert.equal(parseBankSms('E-Mandate!\nRs.299.00 will be deducted on 06/10/26, 00:00:00\nFor Google Play mandate\nUMN 9f1c\nMaintain Balance\n-HDFC Bank'), null);
  assert.equal(parseBankSms('Alert:\nINR.368.58 will be debited on 03/08/2025 from HDFC Bank Card 8812 for Google Workspace\nID:AbCdEfGh12'), null);
  assert.equal(parseBankSms('Blinkit has requested money through Google-pay. On approval, Rs 175.00 will be debited from your Bank Account-ICICI Bank.'), null);
  assert.equal(parseBankSms('Airtel has requested Rs899.00 frm u on Google Pay app. Once approved, money will be debited frm ur a/c -SBI'), null);
  assert.equal(parseBankSms('Standing Instruction SI_D10000001 in A/c XXXXXXXX04417712 of 47000.00INR FAILED on 06-02-2025 06:45:15 as per particulars Insufficient Balance-PNB'), null);
  assert.equal(parseBankSms('Transaction Declined!\nRs.7310.20\nOn HDFC Bank Card 8812 by Visa\nReason: Non-Compliant transaction.\nKindly use Alternate mode.'), null);
  assert.equal(parseBankSms('Payment Failed: Due to INSUFFICIENT FUNDS! Payment of INR 40,000.00 for 10000001_LIFE_INST via AutoPay on HDFC Bank A/c XX3391.'), null);
  assert.equal(parseBankSms('New Bill Alert:\nYour Airtel Bill 9000012345 of Rs.1210.10 is due on 19-Feb-2026. To pay, login to HDFC Bank Net/Mobile Banking>BillPay\nT&C. Ignore if paid'), null);
  assert.equal(parseBankSms('Reminder!\nPay Your Airtel Bill 9000012345 of Rs. 899.00 due on 19-Aug-2025.\nTo pay, login to HDFC Bank Net/Mobile Banking>BillPay\nT&C'), null);
  assert.equal(parseBankSms('ICICI Bank Credit Card XX6119 Statement is sent to user@example.com. Total of Rs 1,240.00 or minimum of Rs 100.00 is due by 30-JUN-25.'), null);
  assert.equal(parseBankSms('Pay Total Due of Rs 22,410.00 or Minimum Due Rs 1,120.00 by 30-Dec-25 for ICICI Bank Credit Card XX6119. Delayed/No payments are reported to Credit Bureaus.'), null);
  assert.equal(parseBankSms('ICICI Bank Credit Card XX6119 payment Rs 6,100.00 overdue. Authorised Partner may contact. Ignore if paid'), null);
  assert.equal(parseBankSms('Hi, we have received a payment of Rs. 99.50 for your Airtel account. To download the payment receipt, click airtel.example'), null);
});

test('promotions never land even when they quote balances and credits', () => {
  assert.equal(parseBankSms('Airtel Warning: SPAM | Date:8 Oct Trading A/c: 9000012345 You received Rs.9,876 cashback. Current Balance: Rs.12,345. Click to View: bit.ly/xxxxxxx'), null);
  assert.equal(parseBankSms('Dear User: Rs.4,321 credited to account(900***345) successfully :MCXSELLFUTCOM Withdraw before 9PM @ bit.ly/yyyyyyy . --Capstocks.'), null);
});

// --- Unicode-defended bank routing -------------------------------------------

test('mathematical sans-serif PNB routing variants normalize before matching', () => {
  const body = 'Ac XXXXXXXX04417712 \u{1d5d7}\u{1d5f2}\u{1d5ef}\u{1d5f6}\u{1d601}\u{1d5f2}\u{1d5f1} with Rs.47000.00, 06-10-2026 10:06:27. Aval Bal 312.18 CR. Helpline 18001800/18002021';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.accountLast4],
    ['debit', 4700000, '7712']);
});

// --- PNB ---------------------------------------------------------------------

test('PNB debit keeps the account hint and ignores the CR balance', () => {
  const body = 'Ac XX7712 Debited with Rs.47000.00, 06-10-2026 10:06:27. Aval Bal 312.18 CR. Helpline 18001800/18002021-PNB';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.accountLast4],
    ['debit', 4700000, '7712']);
});

test('PNB residual micro-templates: credits, charges, and sans-serif routing', () => {
  const creditForms = [
    ['A/c XX7712 credited with INR 64.00 on 03-03-2026 09:00:00 through UPI.Available Bal INR 2210.45-PNB', 6400],
    ['Your a/c XX7712 has been credited with Rs.11.00 on 03-06-2026 towards interest-PNB', 1100],
  ];
  for (const [body, paise] of creditForms) {
    const parsed = parseBankSms(body);
    assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.accountLast4], ['credit', paise, '7712'], body.slice(0, 40));
  }

  const chargeForms = [
    ['A/c XX7712 debited for Rs.8.26 on 06-01-2026 towards bank charges-PNB', 826],
    ['Ac XX7712 debited towards Rs.2.95 on 04-10-2026 upi charges-PNB', 295],
  ];
  for (const [body, paise] of chargeForms) {
    const parsed = parseBankSms(body);
    assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.accountLast4], ['debit', paise, '7712'], body.slice(0, 40));
  }
});

test('PNB UPI credit picks up a remitter when the bank names one', () => {
  const named = parseBankSms('A/c X7712 credited for INR 47000.00 on 05-10-26 16:25:18 by ARJUN MEHTA thru UPI.AvlBal INR 47312.18(UPI:61462000007).-PNB');
  assert.deepEqual([named?.direction, named?.amountPaise, named?.merchant],
    ['credit', 4700000, 'Arjun Mehta']);

  const unnamed = parseBankSms('Your a/c XX7712 is credited for INR 47000.00  on 08-09-25 10:01:23 through UPI.Available Bal INR 58800.10 (UPI Ref ID 61462000008).Download PNB ONE-PNB');
  assert.deepEqual([unnamed?.direction, unnamed?.amountPaise, unnamed?.merchant], ['credit', 4700000, 'Unknown merchant']);
});

// --- ICICI -------------------------------------------------------------------

test('ICICI card spends keep the merchant and the masked card digits', () => {
  const body = 'Rs 4,318.60 spent on ICICI Bank Card XX6119 on 04-Oct-26 at CIRCUIT SUPPLY. Avl Lmt: Rs 48,200.00. To dispute, call 18002662/SMS BLOCK 6119 to 9215676766.';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.merchant, parsed?.accountLast4],
    ['debit', 431860, 'Circuit Supply', '6119']);
});

test('foreign-currency card spends without an INR amount stay out of the ledger', () => {
  assert.equal(parseBankSms('USD 61.20 spent using ICICI Bank Card XX6119 on 09-Mar-26 on XYZ*eStore. Avl Limit: INR 52,010.00. If not you, call 1800 2662.'), null);
});

test('ICICI refunds and reversals are credits', () => {
  const named = parseBankSms('AMAZON PAY IN E COMMERC refund of Rs 8,240.30 credited to your ICICI Bank Credit Card XX6119 on 31-JUL-26.');
  assert.deepEqual([named?.direction, named?.amountPaise, named?.merchant, named?.category],
    ['credit', 824030, 'Amazon Pay In E Commerc', 'Bills']);

  const unnamed = parseBankSms('Reversal of Rs 21.40 credited to ICICI Bank Credit Card XX6119 on 25-JUN-25. Revised total due Rs 0, minimum due Rs .00');
  assert.deepEqual([unnamed?.direction, unnamed?.amountPaise], ['credit', 2140]);

  const refunded = parseBankSms('ICICI Bank Credit Card XX6119 credited/refunded with Rs 9,100.00 on 31-JUL-26. To transfer, call Customer Care in 7 days');
  assert.equal(refunded?.direction, 'credit');
});

test('standing-instruction payment acknowledgements stay out of the ledger', () => {
  // Money already counted via the bank's own debit SMS; merchant acknowledgement only.
  const body = 'We have successfully processed payment of INR 1299.00 to Merchant Amazon, as per Standing Instruction QrStUvWx34 on 13/03/2026 for ICICI Bank Credit Card 6119.';
  assert.equal(parseBankSms(body), null);

  const alt = 'Dear Customer, we have successfully processed the payment of INR 1299.00 for Amazon, as per the Standing Instruction QrStUvWx34, on 13/03/2025 for your ICICI Bank Credit Card 6119.';
  assert.equal(parseBankSms(alt), null);
});

test('ICICI card bill-payment receipts are credits on the card account', () => {
  const bbps = 'Payment of Rs 3,610.45 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 16-JUL-26.';
  assert.deepEqual([parseBankSms(bbps)?.direction, parseBankSms(bbps)?.amountPaise, parseBankSms(bbps)?.merchant, parseBankSms(bbps)?.accountLast4],
    ['credit', 361045, 'Icici Bank Credit Card', '6119']);

  const upi = 'Dear Customer, Payment of INR 7,880.60 has been received towards your ICICI Bank Credit Card XX6119 on 13-AUG-26 through UPI. Thank you.';
  assert.deepEqual([parseBankSms(upi)?.direction, parseBankSms(upi)?.amountPaise, parseBankSms(upi)?.accountLast4],
    ['credit', 788060, '6119']);

  // further BBPS receipts across amount formats
  const amounts = [
    ['Payment of Rs 18,402.11 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 30-JAN-26.', 1840211],
    ['Payment of Rs 9,705.30 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 17-FEB-26.', 970530],
    ['Payment of Rs 14,226.08 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 14-MAR-26.', 1422608],
    ['Payment of Rs 6,100.00 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 03-MAY-26.', 610000],
    ['Payment of Rs 27,950.00 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 13-MAY-26.', 2795000],
    ['Payment of Rs 16,330.70 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 23-JUN-26.', 1633070],
    ['Payment of Rs 5,400.00 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 18-APR-25.', 540000],
  ];
  for (const [body, paise] of amounts.slice(0, 6)) {
    const parsed2 = parseBankSms(body);
    assert.deepEqual([parsed2?.direction, parsed2?.amountPaise, parsed2?.accountLast4], ['credit', paise, '6119'], body.slice(0, 40));
  }
});

// --- SBI ---------------------------------------------------------------------

test('SBI inward transfers carry remitter, reference, and account hint', () => {
  const body = 'Dear SBI User, your A/c X3391-credited by Rs.28420.65 on 02Sep26 transfer from PRIYAVERMA Ref No 01462000009 -SBI';
  const parsed = parseBankSms(body);
  assert.deepEqual([parsed?.direction, parsed?.amountPaise, parsed?.merchant, parsed?.accountLast4, parsed?.reference],
    ['credit', 2842065, 'Priyaverma', '3391', '01462000009']);
});

// --- body timestamp precedence -------------------------------------------------

test('body datetime wins over the SMS delivery timestamp', () => {
  const delivered = new Date('2025-12-22T14:05:00').getTime();
  const body = 'A/c XX7712 debited INR 3780.25 Dt 22-12-25 14:04:28 thru UPI:611100000010.Bal INR 9120.33';
  assert.equal(occurredAtFrom(body, delivered), new Date(2025, 11, 22, 14, 4, 28).getTime());

  const delivered2 = new Date('2026-03-10T08:30:00').getTime();
  const body2 = 'Ac XX7712 Debited with Rs.47000.00, 10-03-2026 06:31:25. Aval Bal 402.55 CR. Helpline 18001800/18002021-PNB';
  assert.equal(occurredAtFrom(body2, delivered2), new Date(2026, 2, 10, 6, 31, 25).getTime());

  const delivered3 = new Date('2026-10-05T16:25:18').getTime();
  const body3 = 'A/c X7712 credited for INR 47000.00 on 05-10-26 16:25:18 by ARJUN MEHTA thru UPI.AvlBal INR 47312.18(UPI:61462000007).-PNB';
  assert.equal(occurredAtFrom(body3, delivered3), new Date(2026, 9, 5, 16, 25, 18).getTime());
});

test('date-only bodies keep the SMS time of day', () => {
  const delivered = new Date('2026-09-02T08:11:27').getTime();
  const body = 'Dear SBI User, your A/c X3391-credited by Rs.28420.65 on 02Sep26 transfer from PRIYAVERMA Ref No 01462000009 -SBI';
  const sms = new Date(delivered);
  const expected = new Date(2026, 8, 2, sms.getHours(), sms.getMinutes(), sms.getSeconds()).getTime();
  assert.equal(occurredAtFrom(body, delivered), expected);

  const delivered2 = new Date('2026-02-17T09:40:00').getTime();
  const compact = 'Payment of Rs 9,705.30 has been received on your ICICI Bank Credit Card XX6119 through Bharat Bill Payment System on 17-FEB-26.';
  const sms2 = new Date(delivered2);
  assert.equal(occurredAtFrom(compact, delivered2), new Date(2026, 1, 17, sms2.getHours(), sms2.getMinutes(), sms2.getSeconds()).getTime());
});

test('HDFC card-spend ISO timestamps parse including their colon form', () => {
  const delivered = new Date('2026-03-03T19:48:40').getTime();
  const body = 'Spent Rs.383.5 From HDFC Bank Card x8812 At GOOGLE WORKSPACE CYBS On 2026-03-03:19:48:33 Bal Rs.15002.90';
  assert.equal(occurredAtFrom(body, delivered), new Date(2026, 2, 3, 19, 48, 33).getTime());
});

test('bodies without a usable date fall back to delivery, and junk dates are refused', () => {
  const delivered = new Date('2026-10-05T12:00:00').getTime();
  assert.equal(occurredAtFrom('Amt Deducted!\nRs.61,500.00 from your HDFC Bank A/c XX7713 for Money Transfer via HDFC Bank Online Banking', delivered), null);
  assert.equal(occurredAtFrom('Sent Rs.300.00 From HDFC Bank A/C *3391 To X On 13/02/99 Z Ref 1', delivered), null);
  // planned/expiry dates never become transaction times
  assert.equal(occurredAtFrom('Annual Pass issuance successful for Vehicle XX00AB1234 Expiry: 2027-04-08 Trips: 200 Paid: Rs.3000', delivered), null);
});

// --- generic path ------------------------------------------------------------

test('generic direction stays anchored to money context', () => {
  assert.equal(parseBankSms('We have sent you an email with your statement. INR 100 late fee may apply.'), null);
  assert.equal(parseBankSms('An amount of INR 1.00 has been CREDITED to your account XXXX4406 on 28/03/2025 towards interest. Total Avail.bal INR 120.00. - Canara Bank')?.direction, 'credit');
});
