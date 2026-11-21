// Synthetic ledger fixtures: invented banks' digits, payees, refs and amounts that keep
// only the *shape* of real bank SMS (verification-gate §3). No real message text.
import { parseBankSms, occurredAtFrom } from '../../src/lib/parser.ts';
import { V1_SCHEMA } from '../../src/lib/migrations.ts';

const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 2, 1, 4, 30); // 1 Mar 2026, 10:00 IST

const sent = (amount, payee, day, ref) =>
  `Sent Rs.${amount}\nFrom HDFC Bank A/C *9012\nTo ${payee}\nOn ${String(day).padStart(2, '0')}/03/26\nRef ${ref}\nNot You?\nCall 18000000000/SMS BLOCK UPI to 7000000000`;

// [sender, body, day offset]
export const MESSAGES = [
  ['VM-HDFCBK-S', sent('120.00', 'FRESH BASKET', 2, '600000000001'), 1],
  ['VM-HDFCBK-S', sent('86.00', 'FRESH BASKET', 5, '600000000002'), 4],
  ['VM-HDFCBK-S', sent('240.50', 'Fresh  Basket', 9, '600000000003'), 8],
  ['VM-HDFCBK-S', 'HDFC Bank:Rs. 1250.00 debited from a/c *9012 on 05/03/26 to a/c **7788 (UPI Ref No. 600000000123)', 4],
  ['AD-HDFCBK-T', 'HDFC Bank:Rs. 1250.00 debited from a/c *9012 on 12/03/26 to a/c **7788 (UPI Ref No. 600000000124)', 11],
  ['VM-HDFCBK-S', 'ALERT:Rs.299.00 spent via HDFC BANK Debit Card xx4455 at CLOUDSUITE on 2026-03-06:10:00:00 Avl bal: INR 1000.00', 5],
  ['VM-HDFCBK-S', 'Spent Rs.99.5 From HDFC Bank Card x4455 At CLOUDSUITE On 2026-03-09:11:00:00 Bal Rs.900', 8],
  ['AX-ICICIT-S', 'INR 450.00 spent using ICICI Bank Card XX6611 on 07-Mar-26 on BOOKNOOK. Avl Limit: INR 1,00,000.00. If not you, call 1800 000 0000.', 6],
  ['AX-ICICIT-S', 'Payment of Rs 4,500.00 has been received on your ICICI Bank Credit Card Account XX6611 on 10-Mar-26. Thank you.', 9],
  ['JD-PNBSMS-S', 'Your a/c XX3344 is credited for INR 5000.00 on 08-03-26 10:00:00 by UPI ref 600000000777.-PNB', 7],
  ['VM-HDFCBK-S', 'Update! INR 2,000.00 deposited in HDFC Bank A/c XX9012 on 11-MAR-26 for XXXXXXXXXX5566-TPT-Rent share-ANITA. Avl bal INR 9,000.00', 10],
];

// The transaction a v1 install would have stored for a message (counterparty_masked
// was dropped by v1, so it isn't here).
export function v1Row([sender, body, day], i) {
  const p = parseBankSms(body);
  if (!p) throw new Error(`fixture ${i} does not parse`);
  const receivedAt = T0 + day * DAY;
  return {
    id: `t${String(i).padStart(3, '0')}`, source_hash: `hash-${i}`, sender, raw_body: body,
    occurred_at: occurredAtFrom(body, receivedAt) ?? receivedAt, merchant: p.merchant,
    amount_paise: p.amountPaise, direction: p.direction, category: p.category,
    status: p.confidence >= 0.9 ? 'auto' : 'review', account_last4: p.accountLast4,
    counterparty_last4: p.counterpartyLast4, reference: p.reference, confidence: p.confidence,
    created_at: receivedAt + 1000, updated_at: receivedAt + 1000,
  };
}

export const MANUAL_ROW = {
  id: 'm001', source_hash: null, sender: null, raw_body: null, occurred_at: T0 + 3 * DAY, merchant: 'Corner Chai',
  amount_paise: 3000, direction: 'debit', category: 'Food & dining', status: 'manual', account_last4: null,
  counterparty_last4: null, reference: null, confidence: 1, created_at: T0 + 3 * DAY, updated_at: T0 + 3 * DAY,
};

export function v1Rows() { return [...MESSAGES.map(v1Row), MANUAL_ROW]; }

export async function seedV1(db, rows = v1Rows()) {
  await db.execAsync(V1_SCHEMA);
  for (const row of rows) {
    const keys = Object.keys(row);
    await db.runAsync(`INSERT INTO transactions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]));
  }
  await db.runAsync("INSERT INTO budgets VALUES ('Groceries', 500000)");
  await db.runAsync("INSERT INTO senders VALUES ('HDFCBK', 'HDFC Bank', 1)");
  await db.runAsync("INSERT INTO preferences VALUES ('autoAdd', 'true')");
}

// A freshly read SMS as readBankSms hands it to addTransaction.
export function smsTransaction(sender, body, receivedAt, id) {
  const p = parseBankSms(body);
  return {
    id, sourceHash: `hash-${id}`, sender, rawBody: body, occurredAt: occurredAtFrom(body, receivedAt) ?? receivedAt,
    merchant: p.merchant, amountPaise: p.amountPaise, direction: p.direction, category: p.category,
    status: p.confidence >= 0.9 ? 'auto' : 'review', accountLast4: p.accountLast4, reference: p.reference,
    counterpartyMasked: p.counterpartyMasked, counterpartyLast4: p.counterpartyLast4, confidence: p.confidence,
    createdAt: receivedAt, updatedAt: receivedAt, accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false, duplicateOf: null, preFlagStatus: null, duplicateCleared: false, reportedBalancePaise: p.reportedBalancePaise ?? null, reportedAvlLimitPaise: p.reportedAvlLimitPaise ?? null,
  };
}
