import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBankSms } from '../src/lib/parser.ts';

test('parses a debit while keeping source fields for review', () => {
  assert.deepEqual(parseBankSms('A/C X3381 debited by INR 2,480.00 to VPA zomato@pay Ref 123456789012 on 04-10-2026'), {
    merchant: 'Zomato@Pay', amountPaise: 248000, direction: 'debit', category: 'Food & dining',
    accountLast4: '3381', reference: '123456789012', counterpartyMasked: null, counterpartyLast4: null, reportedBalancePaise: null, reportedAvlLimitPaise: null,
    confidence: 0.95,
  });
});

test('leaves uncertain transaction for review', () => {
  const result = parseBankSms('Rs. 92.50 was spent on your card');
  assert.equal(result?.direction, 'debit');
  assert.equal(result?.amountPaise, 9250);
  assert.equal(result?.confidence, 0.45);
});

test('rejects OTP, marketing, and ambiguous movement', () => {
  assert.equal(parseBankSms('Your OTP is 482991 for a Rs 900 transaction. Do not share.'), null);
  assert.equal(parseBankSms('Rs 500 cashback offer. Shop now and save.'), null);
  assert.equal(parseBankSms('Rs 500 debited and then credited to your account.'), null);
});

test('rejects invalid and oversized amounts', () => {
  assert.equal(parseBankSms('INR 0 debited from your account.'), null);
  assert.equal(parseBankSms('INR 999999999 debited from your account.'), null);
});

test('uses the transaction amount instead of the available balance', () => {
  const result = parseBankSms('Avl bal INR 8,000. A/C X3381 debited by INR 200.00 to VPA cafe@upi Ref 123456789012');
  assert.equal(result?.amountPaise, 20000);
  assert.equal(result?.confidence, 0.95);
});

test('stops the merchant before payment rail wording', () => {
  const result = parseBankSms('Rs. 499.00 debited from A/c XX1234 at Book Mart via UPI. Ref 9876543210. Avl bal Rs. 12000.');
  assert.equal(result?.merchant, 'Book Mart');
  assert.equal(result?.category, 'Shopping');
  assert.equal(result?.amountPaise, 49900);
});

test('parses the UPI sent shape that banks send for every UPI debit', () => {
  const body = 'Sent Rs.220.00 | From HDFC Bank A/C *4620 | To SUNITA | On 22/12/25 | Ref 611100000002 | Not You? | Call 18002586161/SMS BLOCK UPI to 7308080808';
  assert.deepEqual(parseBankSms(body), {
    merchant: 'Sunita', amountPaise: 22000, direction: 'debit', category: 'Transfers',
    accountLast4: '4620', reference: '611100000002', counterpartyMasked: null, counterpartyLast4: null, reportedBalancePaise: null, reportedAvlLimitPaise: null,
    confidence: 0.95,
  });
  // both confidence assertions in this test cover the direct-amount contexts
  const retail = parseBankSms('Sent Rs.260.00 | From HDFC Bank A/C *4471 | To Blinkit | On 18/12/25 | Ref 611100000012 | Not You? | Call 18002586161/SMS BLOCK UPI to 7308080808');
  assert.equal(retail?.merchant, 'Blinkit');
  assert.equal(retail?.category, 'Groceries');
});

test('sent without a money context stays non-transactional', () => {
  assert.equal(parseBankSms('We have sent you an email with your statement. INR 100 late fee may apply.'), null);
});

test('scores credit messages and caps confidence without a contextual amount', () => {
  const contextual = parseBankSms('A/C X3381 credited by INR 500.00 from ACME Ref 123456789012');
  assert.equal(contextual?.direction, 'credit');
  assert.equal(contextual?.confidence, 0.95);
  const fallback = parseBankSms('Credited to A/C X3381 from ACME. Ref 123456789012. INR 500.00');
  assert.equal(fallback?.confidence, 0.68);
});

test('a card spend without a reference number still clears the auto-add bar', () => {
  const result = parseBankSms('Rs 1,250.00 spent on ICICI Bank Card XX4321 on 05-Nov-26 at BLUE TOKAI COFFEE. Avl Lmt: Rs 40,000.00. To dispute, call 18001080.');
  assert.equal(result?.reference, null);
  assert.equal(result?.accountLast4, '4321');
  assert.ok(result && result.confidence >= 0.9);
});
