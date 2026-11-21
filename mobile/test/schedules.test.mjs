// Schedules (WF-6, spec §5.4) on synthetic rows: invented payees, accounts and amounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAY_MS, amountClusters, anchorsFor, bandFor, classify, detectSeries, draftFromCandidate, draftFromRow, matchSchedules,
  nearestAnchor, scheduleFor, stepAnchor, suggestionsFrom, upcomingThisWeek, validateTerms,
} from '../src/lib/schedules.ts';
import { byId } from '../src/lib/resolve.ts';

// 10:00 IST on a calendar day.
const at = (y, m, d, h = 10) => Date.UTC(y, m - 1, d, h) - 330 * 60_000;
let seq = 0;
function txn(over = {}) {
  seq++;
  return {
    id: over.id ?? `x${String(seq).padStart(4, '0')}`, sourceHash: null, sender: 'VM-HDFCBK', rawBody: 'x', occurredAt: 0,
    merchant: 'm', amountPaise: 29900, direction: 'debit', category: 'Bills', status: 'auto',
    accountLast4: '9012', counterpartyMasked: null, counterpartyLast4: null, reference: null, confidence: 0.95,
    createdAt: seq, updatedAt: seq, accountId: 'acct:HDFC:9012', payeeId: 'p-cloud', payeeOverrideId: null, categoryByUser: false,
    duplicateOf: null, preFlagStatus: null, duplicateCleared: false, ...over,
  };
}
const payee = (id, name = null) => ({ id, kind: 'merchant', bank: '', key: id, masked: id, name, category: null, nudgedAt: null, createdAt: 0 });
const PAYEES = byId([payee('p-cloud'), payee('p-grocer'), payee('p-gym'), payee('p-isp'), payee('p-rent'), payee('p-ws1'), payee('p-ws2'), payee('p-ws3')]);

const monthly = (payeeId, amounts, startMonth, day, over = {}) => amounts.map((amountPaise, i) => {
  const n = startMonth - 1 + i;
  return txn({ payeeId, amountPaise, occurredAt: at(2025 + Math.floor(n / 12), n % 12 + 1, day), ...over });
});

test('IST calendar: anchors clamp to the month end and step by calendar month', () => {
  const terms = { interval: 'monthly', anchorDay: 31, anchorMonth: null };
  const jan = nearestAnchor(terms, at(2026, 1, 30));
  assert.equal(new Date(jan + 5.5 * 3600e3).toISOString().slice(0, 10), '2026-01-31');
  const feb = stepAnchor(terms, jan);
  assert.equal(new Date(feb + 5.5 * 3600e3).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(stepAnchor(terms, feb) + 5.5 * 3600e3).toISOString().slice(0, 10), '2026-03-31');
  // A payment slipped to the 2nd is still the period anchored on the 31st before it.
  assert.equal(nearestAnchor(terms, at(2026, 3, 2)), feb);
  // 00:30 IST on 1 Feb is still 31 Jan in UTC: the IST day wins.
  assert.deepEqual(anchorsFor('monthly', Date.UTC(2026, 0, 31, 19, 0)), { anchorDay: 1, anchorMonth: null });
  assert.deepEqual(anchorsFor('quarterly', at(2026, 5, 7)), { anchorDay: 7, anchorMonth: 2 });
  assert.deepEqual(anchorsFor('weekly', at(2026, 11, 19)), { anchorDay: 4, anchorMonth: null }); // a Thursday
});

test('amount clusters follow a gradual price change (rolling last-3 median, ±20%)', () => {
  const rows = monthly('p-cloud', [32500, 32500, 32500, 36800, 36800, 36800, 38300, 38300, 99900], 1, 3);
  const clusters = amountClusters(rows);
  assert.deepEqual(clusters.map(c => c.length), [8, 1]);
});

test('a monthly series passes the gate and gets a ±20% band rounded out to the rupee', () => {
  const rows = monthly('p-cloud', Array(6).fill(29900), 4, 5);
  rows[2].occurredAt = at(2025, 6, 8); // 3 days late, inside the ±4 margin
  const [c, ...rest] = detectSeries(rows, PAYEES, at(2025, 9, 20));
  assert.equal(rest.length, 0);
  assert.equal(c.interval, 'monthly');
  assert.equal(c.anchorDay, 5);
  assert.equal(c.hits.length, 6);
  assert.deepEqual([c.amountMin, c.amountMax], [23900, 35900]);
  assert.equal(c.typicalPaise, 29900);
  assert.equal(c.lapsed, false);
  assert.deepEqual(bandFor(32500, 38300), { amountMin: 26000, amountMax: 46000 });
});

test('evidence gate: 2 hits, no consecutive pair, or scattered gaps are not a schedule', () => {
  assert.equal(detectSeries(monthly('p-cloud', [29900, 29900], 1, 5), PAYEES, at(2025, 3, 1)).length, 0);
  // Every gap skips a month: fits at k=2 but never two consecutive periods.
  const skipping = [1, 3, 5, 7].map(m => txn({ occurredAt: at(2025, m, 5) }));
  assert.equal(classify(skipping), null);
  const scattered = [[1, 5], [2, 5], [3, 5], [3, 20], [5, 1], [6, 25]].map(([m, d]) => txn({ occurredAt: at(2025, m, d) }));
  assert.equal(classify(scattered), null);
  // One skipped month per gap is tolerated.
  const oneSkip = [[1, 5], [2, 5], [3, 5], [5, 6], [6, 5]].map(([m, d]) => txn({ occurredAt: at(2025, m, d) }));
  assert.equal(classify(oneSkip)?.interval, 'monthly');
});

test('monthly fit is measured against the anchor day: jitter around it fits, drift does not', () => {
  // Around the 5th: +0, +2, −3, +0 days. Each hit is near its anchor.
  const jitter = [[7, 5], [8, 7], [9, 2], [10, 5]].map(([m, d]) => txn({ occurredAt: at(2025, m, d) }));
  assert.equal(classify(jitter)?.interval, 'monthly');
  // 9th, 16th, 14th: gaps of 38 and 26 days; the first hit is 5 days off the anchor (14).
  const drift = [[1, 9], [2, 16], [3, 14]].map(([m, d]) => txn({ occurredAt: at(2025, m, d) }));
  assert.equal(classify(drift), null);
  // A stray mid-month hit inside the cluster breaks two gaps.
  const stray = [[3, 12], [4, 11], [5, 11], [5, 28], [8, 10]].map(([m, d]) => txn({ occurredAt: at(2025, m, d) }));
  assert.equal(classify(stray), null);
});

test('share gate: a frequent merchant whose same-amount buys line up is not a schedule', () => {
  const buys = [];
  for (let d = 0; d < 120; d += 3) buys.push(txn({ payeeId: 'p-grocer', amountPaise: 41000 + (d % 7) * 9000, occurredAt: at(2025, 1, 1) + d * DAY_MS }));
  for (const m of [1, 2, 3, 4]) buys.push(txn({ payeeId: 'p-grocer', amountPaise: 150000, occurredAt: at(2025, m, 10) }));
  const big = buys.filter(t => t.amountPaise === 150000);
  assert.equal(detectSeries(big, PAYEES, at(2025, 5, 1)).length, 1, 'alone, the 4 big buys are a monthly series');
  assert.equal(detectSeries(buys, PAYEES, at(2025, 5, 1)).length, 0, 'among ~30 other buys they hold < 50% of the span');
});

test('weekly, fortnightly and quarterly classes, tried shortest first', () => {
  const weekly = Array.from({ length: 6 }, (_, i) => txn({ payeeId: 'p-gym', amountPaise: 50000, occurredAt: at(2025, 3, 3) + i * 7 * DAY_MS }));
  assert.equal(classify(weekly).interval, 'weekly');
  const fortnightly = Array.from({ length: 5 }, (_, i) => txn({ payeeId: 'p-gym', amountPaise: 50000, occurredAt: at(2025, 3, 3) + i * 14 * DAY_MS + (i % 2) * DAY_MS }));
  assert.equal(classify(fortnightly).interval, 'fortnightly');
  const quarterly = [[1, 12], [4, 10], [7, 14], [10, 12]].map(([m, d]) => txn({ payeeId: 'p-isp', amountPaise: 236000, occurredAt: at(2025, m, d) }));
  const [q] = detectSeries(quarterly, PAYEES, at(2025, 11, 1));
  assert.equal(q.interval, 'quarterly');
  assert.equal(q.anchorDay, 12);
  assert.equal(q.anchorMonth, 1);
});

test('detection input: ignored, merged and flagged rows never form or extend a series', () => {
  const rows = monthly('p-cloud', [29900, 29900, 29900], 1, 5);
  rows[1].status = 'ignored';
  assert.equal(detectSeries(rows, PAYEES, at(2025, 3, 20)).length, 0);
  const pair = monthly('p-cloud', [29900, 29900, 29900], 1, 5);
  const copies = pair.map(t => txn({ ...t, id: `${t.id}-copy`, occurredAt: t.occurredAt + 60_000, status: 'duplicate_review', duplicateOf: t.id }));
  const [c] = detectSeries([...pair, ...copies], PAYEES, at(2025, 3, 20));
  assert.equal(c.hits.length, 3, 'a pending pair counts once, as its earlier row');
  const noPayee = monthly(null, [29900, 29900, 29900], 1, 5);
  assert.equal(detectSeries(noPayee, PAYEES, at(2025, 3, 20)).length, 0);
});

test('each account side and direction is its own series', () => {
  const out = monthly('p-rent', [4700000, 4700000, 4700000], 1, 1);
  const into = monthly('p-rent', [4700000, 4700000, 4700000], 1, 1, { accountId: 'acct:PNB:3344', direction: 'credit' });
  const keys = detectSeries([...out, ...into], PAYEES, at(2025, 3, 10)).map(c => `${c.accountId}:${c.direction}`).sort();
  assert.deepEqual(keys, ['acct:HDFC:9012:debit', 'acct:PNB:3344:credit']);
});

test('naming payees identically merges their rows into one series', () => {
  const rows = [
    ...monthly('p-ws1', [32500, 32500, 32500], 1, 3),
    ...monthly('p-ws2', [36800, 36800, 36800], 4, 3),
    ...monthly('p-ws3', [38300, 38300], 7, 3),
  ];
  const now = at(2025, 8, 20);
  const unnamed = detectSeries(rows, PAYEES, now);
  assert.deepEqual(unnamed.map(c => c.hits.length).sort(), [3, 3]);
  assert.equal(unnamed.find(c => c.hits.length === 3 && c.firstHitAt === rows[0].occurredAt).lapsed, true);
  const named = byId([...PAYEES.values()].map(p => p.id.startsWith('p-ws') ? { ...p, name: p.id === 'p-ws2' ? ' cloud Workspace ' : 'Cloud Workspace' } : p));
  const merged = detectSeries(rows, named, now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].hits.length, 8);
  assert.equal(merged[0].payeeId, 'p-ws3');
});

test('lapsed: the window after the last hit has closed with nothing in it', () => {
  const rows = monthly('p-cloud', [29900, 29900, 29900], 1, 5);
  assert.equal(detectSeries(rows, PAYEES, at(2025, 4, 9, 23)).at(0).lapsed, false); // window 1–9 Apr still open
  assert.equal(detectSeries(rows, PAYEES, at(2025, 4, 10, 1)).at(0).lapsed, true);
});

const schedule = over => ({
  id: 's1', payeeId: 'p-cloud', accountId: 'acct:HDFC:9012', direction: 'debit', interval: 'monthly', anchorDay: 5, anchorMonth: null,
  amountMin: 23900, amountMax: 35900, lastPaidAt: at(2025, 1, 5), status: 'active', createdAt: at(2025, 6, 1), decidedAt: at(2025, 6, 1), ...over,
});

test('suggestions leave out stored rows on the same key and interval with an overlapping band', () => {
  const rows = monthly('p-cloud', Array(4).fill(29900), 1, 5);
  const candidates = detectSeries(rows, PAYEES, at(2025, 4, 20));
  assert.equal(suggestionsFrom(candidates, [], PAYEES).length, 1);
  for (const status of ['active', 'ended', 'dismissed']) {
    assert.equal(suggestionsFrom(candidates, [schedule({ status })], PAYEES).length, 0, status);
  }
  assert.equal(suggestionsFrom(candidates, [schedule({ status: 'dismissed', interval: 'weekly' })], PAYEES).length, 1, 'another interval');
  assert.equal(suggestionsFrom(candidates, [schedule({ status: 'dismissed', amountMin: 7900, amountMax: 12000 })], PAYEES).length, 1, 'another amount cluster');
  assert.equal(suggestionsFrom(candidates, [schedule({ status: 'dismissed', accountId: 'acct:PNB:3344' })], PAYEES).length, 1, 'another account');
});

test('matcher: Paid after a match, then Due, Overdue and Lapsed as windows pass; a later match revives it', () => {
  const rows = monthly('p-cloud', Array(5).fill(29900), 1, 5); // Jan–May
  const s = schedule();
  const view = now => matchSchedules(rows, [s], PAYEES, now).state.get('s1');
  const may = view(at(2025, 5, 20));
  assert.equal(may.state, 'paid');
  assert.equal(may.history.length, 5);
  assert.equal(may.lastPaidAt, rows[4].occurredAt);
  assert.equal(new Date(may.expectedAt + 5.5 * 3600e3).toISOString().slice(0, 10), '2025-06-05');
  assert.equal(view(at(2025, 6, 3)).state, 'due');
  const overdue = view(at(2025, 6, 12));
  assert.equal(overdue.state, 'overdue');
  const ist = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
  assert.equal(ist(overdue.missedAt), '2025-06-05', 'the missed window, not the next one');
  assert.equal(ist(overdue.expectedAt), '2025-07-05');
  assert.equal(may.missedAt, null);
  assert.equal(view(at(2025, 7, 7)).state, 'overdue', 'stays overdue until the next window closes');
  assert.equal(view(at(2025, 7, 12)).state, 'lapsed');
  const revived = matchSchedules([...rows, txn({ amountPaise: 29900, occurredAt: at(2025, 8, 4) })], [s], PAYEES, at(2025, 8, 20)).state.get('s1');
  assert.equal(revived.state, 'paid');
  assert.equal(revived.history.length, 6);
});

test('matcher: one match per window, the closest to the expected date, inside the band', () => {
  const rows = [
    txn({ id: 'early', occurredAt: at(2025, 3, 2) }),
    txn({ id: 'close', occurredAt: at(2025, 3, 6) }),
    txn({ id: 'big', amountPaise: 99900, occurredAt: at(2025, 3, 5) }),
    txn({ id: 'other-account', accountId: 'acct:PNB:3344', occurredAt: at(2025, 3, 5) }),
  ];
  const { matches } = matchSchedules(rows, [schedule({ lastPaidAt: at(2025, 3, 5) })], PAYEES, at(2025, 3, 20));
  assert.deepEqual([...matches.keys()], ['close']);
});

test('matcher: two periods outside the band prompt "Amount changed", and never change the terms', () => {
  const rows = [...monthly('p-cloud', [29900, 29900, 29900], 1, 5), ...monthly('p-cloud', [44900, 44900], 4, 5)];
  const s = schedule();
  const v = matchSchedules(rows, [s], PAYEES, at(2025, 5, 20)).state.get('s1');
  assert.deepEqual(v.drift, { fromPaise: 29900, toPaise: 44900 });
  assert.equal(s.amountMax, 35900);
  const one = matchSchedules(rows.slice(0, 4), [s], PAYEES, at(2025, 4, 20)).state.get('s1');
  assert.equal(one.drift, null);
});

test('matcher: a row goes to one Schedule; ended Schedules stop claiming when ended; dismissed never match', () => {
  const rows = monthly('p-cloud', Array(4).fill(29900), 1, 5);
  const ended = schedule({ id: 'a', status: 'ended', createdAt: 1, decidedAt: at(2025, 2, 20) });
  const active = schedule({ id: 'b', createdAt: 2 });
  const dismissed = schedule({ id: 'c', status: 'dismissed', createdAt: 0 });
  const { matches } = matchSchedules(rows, [active, ended, dismissed], PAYEES, at(2025, 4, 20));
  assert.deepEqual([...matches.values()], ['a', 'a', 'b', 'b']);
});

test('Home strip: window opening within 7 days, or Due/Overdue; badge on the payee group', () => {
  const rows = monthly('p-cloud', Array(3).fill(29900), 1, 5);
  const { state } = matchSchedules(rows, [schedule()], PAYEES, at(2025, 3, 20));
  assert.equal(upcomingThisWeek(state.values(), at(2025, 3, 20)).length, 0, 'next window opens 1 Apr, 12 days out');
  assert.equal(upcomingThisWeek(matchSchedules(rows, [schedule()], PAYEES, at(2025, 3, 26)).state.values(), at(2025, 3, 26)).length, 1);
  assert.equal(upcomingThisWeek(matchSchedules(rows, [schedule()], PAYEES, at(2025, 4, 12)).state.values(), at(2025, 4, 12))[0].state, 'overdue');
  const named = byId([payee('p-cloud', 'Cloud'), payee('p-ws1', 'cloud')]);
  assert.equal(scheduleFor(named.get('p-ws1'), state.values(), named)?.schedule.id, 's1');
  assert.equal(scheduleFor(PAYEES.get('p-gym'), state.values(), PAYEES), null);
});

test('Track it and Track as schedule drafts; the first walk reads Paid for the tracked row', () => {
  const rows = monthly('p-cloud', Array(4).fill(29900), 1, 5);
  const [c] = detectSeries(rows, PAYEES, at(2025, 4, 20));
  const fromCandidate = { ...draftFromCandidate(c), id: 's', status: 'active', createdAt: at(2025, 4, 20), decidedAt: at(2025, 4, 20) };
  const v = matchSchedules(rows, [fromCandidate], PAYEES, at(2025, 4, 20)).state.get('s');
  assert.equal(v.state, 'paid');
  assert.equal(v.history.length, 4);
  const bill = txn({ payeeId: 'p-isp', amountPaise: 118000, occurredAt: at(2025, 4, 17) });
  const draft = draftFromRow(bill);
  assert.deepEqual({ interval: draft.interval, anchorDay: draft.anchorDay, amountMin: draft.amountMin, amountMax: draft.amountMax },
    { interval: 'monthly', anchorDay: 17, amountMin: 94400, amountMax: 141600 });
  const manual = { ...draft, id: 'm', status: 'active', createdAt: at(2025, 4, 20), decidedAt: at(2025, 4, 20) };
  assert.equal(matchSchedules([bill], [manual], PAYEES, at(2025, 4, 20)).state.get('m').state, 'paid');
  assert.equal(draftFromRow(txn({ payeeId: null })), null);
});

test('terms validation', () => {
  assert.doesNotThrow(() => validateTerms({ interval: 'weekly', anchorDay: 0, anchorMonth: null, amountMin: 100, amountMax: 100 }));
  assert.throws(() => validateTerms({ interval: 'weekly', anchorDay: 7, anchorMonth: null, amountMin: 100, amountMax: 100 }));
  assert.throws(() => validateTerms({ interval: 'monthly', anchorDay: 0, anchorMonth: null, amountMin: 100, amountMax: 100 }));
  assert.throws(() => validateTerms({ interval: 'quarterly', anchorDay: 5, anchorMonth: null, amountMin: 100, amountMax: 100 }));
  assert.throws(() => validateTerms({ interval: 'monthly', anchorDay: 5, anchorMonth: null, amountMin: 200, amountMax: 100 }));
});
