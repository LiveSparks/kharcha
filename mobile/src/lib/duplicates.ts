import type { Transaction } from './model';

// Operator rule: when the same transaction shows up twice within a short window
// (same amount and direction, e.g. the HDFC credit alert plus the SBI credit SMS
// for one inward transfer), the LATER copy is flagged for review, never dropped.
// Copies may differ in body or sender; the user merges or keeps them.
export function flagDuplicates(
  candidates: Transaction[],
  existing: Transaction[] = [],
  windowMs: number = 24 * 60 * 60 * 1000,
): Transaction[] {
  const candidateIds = new Set(candidates.map(t => t.id));
  const ordered = [...existing, ...candidates]
    .filter(t => t.status !== 'ignored')
    .sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt);
  const lastSeen = new Map<string, Transaction>();
  const flagged = new Set<string>();
  for (const t of ordered) {
    const key = `${t.amountPaise}|${t.direction}`;
    const previous = lastSeen.get(key);
    if (previous && candidateIds.has(t.id) && t.occurredAt - previous.occurredAt <= windowMs) {
      flagged.add(t.id);
    }
    lastSeen.set(key, t);
  }
  return candidates.map(t => flagged.has(t.id) ? { ...t, status: 'duplicate_review' as const } : t);
}
