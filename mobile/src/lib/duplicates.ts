import { occurredAtFrom } from './parser.ts';
import { effectivePayeeId } from './resolve.ts';
import type { RestorableStatus, Transaction, TransactionStatus } from './model';

// Duplicate review (WF-5, app-modification spec §5.2). Pure: detection flags, scoring
// suggests, and the merge/keep/unmerge decisions are returned as row patches that the
// SQLite ledger and the web preview both apply. Nothing here drops a row.

export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Inside this gap, two same-amount rows on compatible accounts pair even when their
// payees differ (sibling senders word the same transfer differently).
export const CLOSE_GAP_MS = 30 * 60 * 1000;

type Row = Pick<Transaction, 'id' | 'occurredAt' | 'createdAt' | 'amountPaise' | 'direction' | 'status' | 'accountId' | 'payeeId' | 'payeeOverrideId'>;

export function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }
export function pairIds(a: string, b: string): [string, string] { return a < b ? [a, b] : [b, a]; }

function earlier(a: Row, b: Row): number {
  return a.occurredAt - b.occurredAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Rows a new copy may pair with: Live rows and rows still waiting for review.
const PARTNER_STATUS: ReadonlySet<TransactionStatus> = new Set(['auto', 'review', 'manual', 'duplicate_review']);

export function isPairable(candidate: Row, partner: Row, dismissed: ReadonlySet<string>, windowMs = DUPLICATE_WINDOW_MS): boolean {
  if (partner.id === candidate.id || !PARTNER_STATUS.has(partner.status)) return false;
  if (partner.amountPaise !== candidate.amountPaise || partner.direction !== candidate.direction) return false;
  if (earlier(partner, candidate) >= 0) return false;
  const gap = candidate.occurredAt - partner.occurredAt;
  if (gap > windowMs) return false;
  if (candidate.accountId && partner.accountId && candidate.accountId !== partner.accountId) return false;
  const a = effectivePayeeId(candidate), b = effectivePayeeId(partner);
  if (a && b && a !== b && gap > CLOSE_GAP_MS) return false;
  return !dismissed.has(pairKey(candidate.id, partner.id));
}

// The earliest qualifying earlier row, or null.
export function findPartner<T extends Row>(candidate: Row, pool: readonly T[], dismissed: ReadonlySet<string> = new Set(), windowMs = DUPLICATE_WINDOW_MS): T | null {
  let best: T | null = null;
  for (const row of pool) if (isPairable(candidate, row, dismissed, windowMs) && (!best || earlier(row, best) < 0)) best = row;
  return best;
}

function restorable(status: TransactionStatus): RestorableStatus {
  return status === 'auto' || status === 'manual' ? status : 'review';
}

// Flag new rows against earlier ledger rows and earlier rows of the same batch.
// `existing` is the ledger from 24h before the batch onward (Live and pending rows);
// candidates must already carry their account and payee ids. A flagged row keeps its
// would-be status in preFlagStatus and points at its partner.
export function flagDuplicates(
  candidates: readonly Transaction[],
  existing: readonly Transaction[] = [],
  dismissed: ReadonlySet<string> = new Set(),
  windowMs: number = DUPLICATE_WINDOW_MS,
): Transaction[] {
  const byKey = new Map<string, Transaction[]>();
  const add = (t: Transaction) => {
    const key = `${t.amountPaise}|${t.direction}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  };
  for (const t of existing) add(t);
  const result = new Map<string, Transaction>();
  for (const c of [...candidates].sort(earlier)) {
    const partner = findPartner(c, byKey.get(`${c.amountPaise}|${c.direction}`) ?? [], dismissed, windowMs);
    const out: Transaction = partner
      ? { ...c, status: 'duplicate_review', duplicateOf: partner.id, preFlagStatus: restorable(c.status) }
      : c;
    result.set(c.id, out);
    add(out);
  }
  return candidates.map(c => result.get(c.id)!);
}

// --- Survivor ---------------------------------------------------------------------

// One point each for an account, a known payee, a reference and a body timestamp.
// The body date is checked against when the message arrived (createdAt).
export function survivorScore(t: Pick<Transaction, 'accountId' | 'payeeId' | 'payeeOverrideId' | 'reference' | 'rawBody' | 'createdAt'>): number {
  return Number(!!t.accountId) + Number(!!effectivePayeeId(t)) + Number(!!t.reference)
    + Number(!!t.rawBody && occurredAtFrom(t.rawBody, t.createdAt) !== null);
}

// The fuller parse; ties go to the earlier row.
export function defaultSurvivor<T extends Transaction>(a: T, b: T): T {
  const [first, second] = earlier(a, b) <= 0 ? [a, b] : [b, a];
  return survivorScore(second) > survivorScore(first) ? second : first;
}

export interface DuplicatePair {
  flagged: Transaction;
  partner: Transaction;
  survivorId: string;
  gapMs: number;
}

// Pending pairs, newest first. A flag whose partner is missing is left out (it can't
// be shown side by side); the v3 migration leaves none.
export function duplicatePairs(transactions: readonly Transaction[]): DuplicatePair[] {
  const byIdMap = new Map(transactions.map(t => [t.id, t]));
  const pairs: DuplicatePair[] = [];
  for (const t of transactions) {
    if (t.status !== 'duplicate_review' || !t.duplicateOf) continue;
    const partner = byIdMap.get(t.duplicateOf);
    if (!partner) continue;
    pairs.push({ flagged: t, partner, survivorId: defaultSurvivor(t, partner).id, gapMs: Math.abs(t.occurredAt - partner.occurredAt) });
  }
  return pairs.sort((x, y) => y.flagged.occurredAt - x.flagged.occurredAt);
}

// Merged copies kept under a survivor ("1 merged copy").
export function mergedCopies(survivorId: string, transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter(t => t.status === 'merged' && t.duplicateOf === survivorId);
}

export function gapLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'Same minute';
  if (min < 60) return `${min} min apart`;
  const h = Math.round(min / 60);
  return `${h} ${h === 1 ? 'hour' : 'hours'} apart`;
}

// --- Decisions --------------------------------------------------------------------

export interface RowPatch {
  id: string;
  status: TransactionStatus;
  duplicateOf: string | null;
  preFlagStatus: RestorableStatus | null;
  duplicateCleared?: boolean;
}

export interface DuplicateDecision { patches: RowPatch[]; dismiss: [string, string] | null }

function need(rows: ReadonlyMap<string, Transaction>, id: string | null): Transaction {
  const row = id ? rows.get(id) : undefined;
  if (!row) throw new Error('Entry not found.');
  return row;
}

// Merge a pending pair. `rows` must hold the flagged row, its partner and every row
// whose duplicateOf points at the partner (they follow a flipped survivor).
export function mergeDecision(rows: ReadonlyMap<string, Transaction>, flaggedId: string, survivorId: string): DuplicateDecision {
  const flagged = need(rows, flaggedId);
  if (flagged.status !== 'duplicate_review' || !flagged.duplicateOf) throw new Error('This entry is not waiting for duplicate review.');
  const partner = need(rows, flagged.duplicateOf);
  if (survivorId === partner.id) {
    return { patches: [{ id: flagged.id, status: 'merged', duplicateOf: partner.id, preFlagStatus: flagged.preFlagStatus }], dismiss: null };
  }
  if (survivorId !== flagged.id) throw new Error('Pick one of the two entries to keep.');
  if (partner.status === 'merged' || partner.status === 'ignored') throw new Error('The other entry is no longer in the ledger.');
  // Keep the other: the flagged row becomes the survivor, the partner is merged into it.
  const partnerRestore = partner.status === 'duplicate_review' ? partner.preFlagStatus : restorable(partner.status);
  const patches: RowPatch[] = [
    { id: flagged.id, status: flagged.preFlagStatus ?? 'review', duplicateOf: null, preFlagStatus: null },
    { id: partner.id, status: 'merged', duplicateOf: flagged.id, preFlagStatus: partnerRestore },
  ];
  // Copies merged into (or waiting on) the old survivor move to the new one, so no chain forms.
  for (const row of rows.values()) {
    if (row.id === flagged.id || row.id === partner.id || row.duplicateOf !== partner.id) continue;
    if (row.status === 'merged' || row.status === 'duplicate_review') {
      patches.push({ id: row.id, status: row.status, duplicateOf: flagged.id, preFlagStatus: row.preFlagStatus });
    }
  }
  return { patches, dismiss: null };
}

// Not a duplicate: restore the flagged row and remember the pair.
export function keepBothDecision(rows: ReadonlyMap<string, Transaction>, id: string): DuplicateDecision {
  const row = need(rows, id);
  if (row.status !== 'duplicate_review') throw new Error('This entry is not waiting for duplicate review.');
  return release(row);
}

// Undo a merge: the copy comes back with its pre-flag status and the pair is remembered.
export function unmergeDecision(rows: ReadonlyMap<string, Transaction>, id: string): DuplicateDecision {
  const row = need(rows, id);
  if (row.status !== 'merged') throw new Error('This entry was not merged.');
  return release(row);
}

function release(row: Transaction): DuplicateDecision {
  return {
    patches: [{ id: row.id, status: row.preFlagStatus ?? 'review', duplicateOf: null, preFlagStatus: null, duplicateCleared: true }],
    dismiss: row.duplicateOf ? pairIds(row.id, row.duplicateOf) : null,
  };
}

export function applyPatch(t: Transaction, patch: RowPatch, now: number): Transaction {
  return {
    ...t, status: patch.status, duplicateOf: patch.duplicateOf, preFlagStatus: patch.preFlagStatus,
    duplicateCleared: patch.duplicateCleared ?? t.duplicateCleared, updatedAt: now,
  };
}

// --- v2 → v3 (spec §4.2 step 3) -------------------------------------------------------

// Legacy duplicate_review rows carry no partner. Re-run the tightened detection over the
// prior 24h; a row with a partner is linked, one without returns to its unflagged status
// (auto when confident and auto-add is on, else review).
export function relinkLegacyFlags(transactions: readonly Transaction[], autoAdd: boolean): RowPatch[] {
  const patches: RowPatch[] = [];
  const legacy = transactions.filter(t => t.status === 'duplicate_review' && !t.duplicateOf);
  for (const row of legacy) {
    const wouldBe: RestorableStatus = autoAdd && row.confidence >= 0.9 ? 'auto' : 'review';
    const partner = findPartner(row, transactions);
    patches.push(partner
      ? { id: row.id, status: 'duplicate_review', duplicateOf: partner.id, preFlagStatus: wouldBe }
      : { id: row.id, status: wouldBe, duplicateOf: null, preFlagStatus: null });
  }
  return patches;
}
