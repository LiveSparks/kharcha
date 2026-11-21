import assert from 'node:assert/strict';
import test from 'node:test';
import { accountKindFrom, bankFamily, mergeAccountKind } from '../src/lib/banks.ts';
import { identityFor, normalizeMerchant, overrideKey } from '../src/lib/identity.ts';
import {
  accountLabel, balanceAccount, byId, debitCardSuggestions, effectiveCategory, namingNudge, payeeGroupKey,
  payeeLabel, payeeList, payeeStats, unnamedCount, validateName,
} from '../src/lib/resolve.ts';
import { DEFAULT_SENDERS } from '../src/lib/model.ts';

const DAY = 86_400_000;
let seq = 0;
function txn(over = {}) {
  seq++;
  return {
    id: `x${seq}`, sourceHash: null, sender: 'VM-HDFCBK', rawBody: 'x', occurredAt: over.occurredAt ?? seq * 1000,
    merchant: 'Unknown merchant', amountPaise: 1000, direction: 'debit', category: 'Transfers', status: 'auto',
    accountLast4: null, counterpartyMasked: null, counterpartyLast4: null, reference: null, confidence: 0.95,
    createdAt: seq, updatedAt: seq, accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false, duplicateOf: null, preFlagStatus: null, duplicateCleared: false, ...over,
  };
}
const payee = over => ({ id: 'p', kind: 'merchant', bank: '', key: 'k', masked: null, name: null, category: null, nudgedAt: null, createdAt: 0, ...over });
const account = over => ({ id: 'a', bank: 'HDFC', last4: '0000', kind: 'bank', fundedBy: null, name: null, createdAt: 0, ...over });

test('bank family from sender, routing prefix and suffix stripped', () => {
  assert.equal(bankFamily('VM-HDFCBK-S'), 'HDFC');
  assert.equal(bankFamily('HDFCBK'), 'HDFC');
  assert.equal(bankFamily('AX-ICICIT-T'), 'ICICI');
  assert.equal(bankFamily('JD-SBIUPI'), 'SBI');
  assert.equal(bankFamily('PNBSMS'), 'PNB');
  assert.equal(bankFamily('punjab_national_bank_zz00zz00_agent@rbm.goog'), 'PNB');
  assert.equal(bankFamily('VM-KOTAKB-S'), 'KOTAKB');
  assert.equal(bankFamily(null), '');
});

test('PNB is a default sender for new installs', () => {
  assert.ok(DEFAULT_SENDERS.some(s => s.address === 'PNBSMS' && s.enabled));
});

test('account kind is read from the words right before the account digits', () => {
  assert.equal(accountKindFrom('spent via HDFC BANK Debit Card xx1111 at SHOP', '1111'), 'debit_card');
  assert.equal(accountKindFrom('Spent Rs.5 From HDFC Bank Card x1111 At SHOP', '1111'), 'unknown');
  assert.equal(accountKindFrom('received on your ICICI Bank Credit Card XX2222 on', '2222'), 'credit_card');
  assert.equal(accountKindFrom('received on your ICICI Bank Credit Card Account XX2222', '2222'), 'credit_card');
  assert.equal(accountKindFrom('Sent Rs.1\nFrom HDFC Bank A/C *3333\nTo X', '3333'), 'bank');
  assert.equal(accountKindFrom('deposited to HDFC Bank A/C No XXXXXXXXXX3333 towards', '3333'), 'bank');
  assert.equal(accountKindFrom('Ac XXXXXXXX99993333 Debited with Rs.1', '3333'), 'bank');
  // An amount ending in the same digits is not the account.
  assert.equal(accountKindFrom('Rs.3333.00 paid. Debit Card xx3333', '3333'), 'debit_card');
  assert.equal(accountKindFrom(null, '3333'), 'unknown');
});

test('ingest only sharpens an account kind', () => {
  assert.equal(mergeAccountKind('unknown', 'debit_card'), 'debit_card');
  assert.equal(mergeAccountKind('bank', 'credit_card'), 'credit_card');
  assert.equal(mergeAccountKind('debit_card', 'unknown'), 'debit_card');
  assert.equal(mergeAccountKind('debit_card', 'bank'), 'debit_card');
  assert.equal(mergeAccountKind('credit_card', 'debit_card'), 'credit_card');
});

test('identity: merchant payee, masked payee, or none', () => {
  const merchant = identityFor({ sender: 'VM-HDFCBK', rawBody: 'From HDFC Bank A/C *1234', merchant: 'Fresh  Basket', accountLast4: '1234', counterpartyMasked: null, counterpartyLast4: null });
  assert.equal(merchant.account.id, 'acct:HDFC:1234');
  assert.deepEqual(merchant.payee, { id: 'payee:merchant::fresh basket', kind: 'merchant', bank: '', key: 'fresh basket', masked: 'Fresh  Basket' });
  const masked = identityFor({ sender: 'VM-HDFCBK', rawBody: '', merchant: 'Unknown merchant', accountLast4: '1234', counterpartyMasked: '**9876', counterpartyLast4: '9876' });
  assert.equal(masked.payee.id, 'payee:masked:HDFC:9876');
  const none = identityFor({ sender: 'VM-HDFCBK', rawBody: '', merchant: 'Unknown merchant', accountLast4: null, counterpartyMasked: null, counterpartyLast4: null });
  assert.deepEqual(none, { account: null, payee: null });
  const manual = identityFor({ sender: null, rawBody: null, merchant: 'Corner Chai', accountLast4: null, counterpartyMasked: null, counterpartyLast4: null });
  assert.equal(manual.account, null);
  assert.equal(manual.payee.key, 'corner chai');
  assert.equal(normalizeMerchant(' A  B '), 'a b');
  assert.equal(overrideKey('9876', ['9876#1', '9876#3']), '9876#2');
});

test('default labels and resolver rules from spec §3.3', () => {
  assert.equal(payeeLabel(payee({ kind: 'masked', bank: 'HDFC', key: '9876', masked: '**9876' })), 'a/c **9876 · HDFC');
  assert.equal(payeeLabel(payee({ masked: 'Fresh Basket', key: 'fresh basket' })), 'Fresh Basket');
  assert.equal(payeeLabel(payee({ masked: 'Fresh Basket', name: 'Sabzi' })), 'Sabzi');
  assert.equal(accountLabel(account({ last4: '1234' })), 'HDFC ••1234');
  assert.equal(accountLabel(account({ bank: 'ICICI', kind: 'credit_card', last4: '5678' })), 'ICICI card ••5678');
  assert.equal(accountLabel(account({ name: 'Salary' })), 'Salary');
  assert.equal(payeeGroupKey(payee({ id: 'p1', name: ' Google  Suite ' })), 'google  suite');
  assert.equal(payeeGroupKey(payee({ id: 'p1' })), 'p1');
  assert.equal(balanceAccount(account({ id: 'c', kind: 'debit_card', fundedBy: 'b' })), 'b');
  assert.equal(balanceAccount(account({ id: 'c', kind: 'unknown', fundedBy: 'b' })), 'c');
  const payees = byId([payee({ id: 'p1', category: 'Groceries' })]);
  assert.equal(effectiveCategory(txn({ payeeId: 'p1' }), payees), 'Groceries');
  assert.equal(effectiveCategory(txn({ payeeId: 'p1', category: 'Health', categoryByUser: true }), payees), 'Health');
  assert.equal(effectiveCategory(txn({ payeeId: 'p2' }), payees), 'Transfers');
  assert.equal(effectiveCategory(txn({ payeeId: 'p2', payeeOverrideId: 'p1' }), payees), 'Groceries');
});

test('payee list: unnamed by spend, then named A–Z; only Live rows count', () => {
  const payees = [payee({ id: 'small' }), payee({ id: 'big' }), payee({ id: 'zed', name: 'Zed' }), payee({ id: 'amy', name: 'Amy' }), payee({ id: 'gone' })];
  const rows = [
    txn({ payeeId: 'small', amountPaise: 100 }), txn({ payeeId: 'big', amountPaise: 9000 }),
    txn({ payeeId: 'zed' }), txn({ payeeId: 'amy' }), txn({ payeeId: 'gone', status: 'ignored' }),
    txn({ payeeId: 'big', amountPaise: 1, status: 'duplicate_review' }),
  ];
  const stats = payeeStats(rows);
  assert.deepEqual(payeeList(payees, stats).map(e => e.payee.id), ['big', 'small', 'amy', 'zed']);
  assert.equal(stats.get('big').count, 1);
  assert.equal(unnamedCount(payees, stats), 2);
});

test('naming nudge: unnamed, ≥3 Live rows, not yet answered, highest spend', () => {
  const payees = [payee({ id: 'a' }), payee({ id: 'b' }), payee({ id: 'c', nudgedAt: 5 }), payee({ id: 'd', name: 'Named' })];
  const rows = [
    ...[1, 2, 3].map(() => txn({ payeeId: 'a', amountPaise: 100 })),
    ...[1, 2].map(() => txn({ payeeId: 'b', amountPaise: 100000 })), txn({ payeeId: 'b', status: 'ignored', amountPaise: 1 }),
    ...[1, 2, 3].map(() => txn({ payeeId: 'c', amountPaise: 900000 })),
    ...[1, 2, 3].map(() => txn({ payeeId: 'd', amountPaise: 900000 })),
  ];
  assert.equal(namingNudge(payees, payeeStats(rows)).payee.id, 'a');
  // Moved rows count for the payee they were moved to.
  rows.push(txn({ payeeId: 'a', payeeOverrideId: 'b', amountPaise: 5 }));
  assert.equal(namingNudge(payees, payeeStats(rows)).payee.id, 'b');
  assert.equal(namingNudge([payee({ id: 'a', nudgedAt: 1 })], payeeStats(rows)), null);
});

test('debit-card suggestion: a card whose spends have no matching bank-account SMS', () => {
  const accounts = [
    account({ id: 'bank', last4: '1111' }), account({ id: 'other', last4: '2222' }),
    account({ id: 'card', last4: '3333', kind: 'debit_card' }), account({ id: 'twin', last4: '4444', kind: 'unknown' }),
    account({ id: 'cc', bank: 'ICICI', last4: '5555', kind: 'credit_card' }),
    account({ id: 'lonely', bank: 'KOTAKB', last4: '6666', kind: 'debit_card' }),
  ];
  const rows = [
    ...[1, 2, 3].map(i => txn({ accountId: 'bank', amountPaise: 777, occurredAt: i * DAY })),
    txn({ accountId: 'other' }),
    ...[1, 2].map(i => txn({ accountId: 'card', amountPaise: 1000 + i, occurredAt: i * DAY })),
    // The twin's spends are each echoed by a bank-account SMS: it isn't drawing silently.
    ...[1, 2, 3].map(i => txn({ accountId: 'twin', amountPaise: 777, occurredAt: i * DAY + 60_000 })),
    txn({ accountId: 'cc' }), txn({ accountId: 'lonely' }),
  ];
  const suggestions = debitCardSuggestions(accounts, rows);
  assert.deepEqual(suggestions.map(s => [s.card.id, s.bank.id, s.unmatched, s.cardSpends]), [['card', 'bank', 2, 2]]);
  assert.deepEqual(debitCardSuggestions(accounts.map(a => a.id === 'card' ? { ...a, fundedBy: 'bank' } : a), rows), []);
});

test('names are trimmed, 1–40 characters, and empty clears', () => {
  assert.equal(validateName('  Landlord  '), 'Landlord');
  assert.equal(validateName('   '), null);
  assert.equal(validateName('x'.repeat(40)).length, 40);
  assert.throws(() => validateName('x'.repeat(41)));
});
