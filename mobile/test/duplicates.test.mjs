import assert from 'node:assert/strict';
import test from 'node:test';
import { flagDuplicates } from '../src/lib/duplicates.ts';

// Transaction shape is enforced by the production code; tests build plain objects.
function txn(over = {}) {
  return {
    id: over.id ?? crypto.randomUUID(), sourceHash: null, sender: 'BANK', rawBody: 'x',
    occurredAt: over.occurredAt ?? 0, merchant: 'Unknown merchant', amountPaise: over.amountPaise ?? 100,
    direction: over.direction ?? 'credit', category: 'Transfers', status: over.status ?? 'auto',
    accountLast4: null, counterpartyMasked: null, counterpartyLast4: null, reference: null,
    confidence: 0.95, createdAt: over.createdAt ?? 0, updatedAt: 0,
  };
}

function epoch(iso) { return new Date(iso).getTime(); }

test('sibling-sender double notify: the later credit is flagged, not dropped', () => {
  const first = txn({ amountPaise: 2842065, direction: 'credit', occurredAt: epoch('2026-09-02T02:41:00Z'), sender: 'AD-HDFCBK-S' });
  const second = txn({ amountPaise: 2842065, direction: 'credit', occurredAt: epoch('2026-09-02T02:41:20Z'), sender: 'AD-SBIUPI-S' });
  const [a, b] = flagDuplicates([first, second]);
  assert.equal(a.status, 'auto');
  assert.equal(b.status, 'duplicate_review');
  assert.notEqual(a.id, b.id); // both rows survive; the user merges
});

test('premium-style update-plus-alert pair inside 24h flags the later one', () => {
  const update = txn({ amountPaise: 4000000, direction: 'debit', occurredAt: epoch('2026-06-17T10:56:00Z') });
  const alert = txn({ amountPaise: 4000000, direction: 'debit', occurredAt: epoch('2026-06-18T08:53:00Z') });
  assert.equal(flagDuplicates([update, alert])[1].status, 'duplicate_review');
  // outside the window: both stay untouched
  const far = txn({ amountPaise: 4000000, direction: 'debit', occurredAt: epoch('2026-06-18T11:30:00Z'), id: 'far' });
  assert.equal(flagDuplicates([update, far])[1].status, 'auto');
});

test('repeats against the existing ledger are flagged, earlier rows untouched', () => {
  const stored = txn({ amountPaise: 210, direction: 'credit', occurredAt: epoch('2026-03-20T19:20:00Z') });
  const incoming = txn({ amountPaise: 210, direction: 'credit', occurredAt: epoch('2026-03-20T19:24:01Z') });
  const [flagged] = flagDuplicates([incoming], [stored]);
  assert.equal(flagged.status, 'duplicate_review');
  assert.equal(stored.status, 'auto'); // existing rows are never mutated here
});

test('opposite directions and long gaps are not duplicates', () => {
  const debit = txn({ amountPaise: 1840211, direction: 'debit', occurredAt: epoch('2026-01-30T12:00:00Z') });
  const credit = txn({ amountPaise: 1840211, direction: 'credit', occurredAt: epoch('2026-01-30T12:10:00Z') });
  assert.equal(flagDuplicates([debit, credit]).every(t => t.status === 'auto'), true);
  const later = txn({ amountPaise: 99900, direction: 'debit', occurredAt: epoch('2026-02-15T12:00:00Z') });
  assert.equal(flagDuplicates([txn({ amountPaise: 99900, direction: 'debit', occurredAt: epoch('2026-01-08T12:00:00Z') }), later]).every(t => t.status === 'auto'), true);
});
