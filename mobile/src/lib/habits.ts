import { UNKNOWN_MERCHANT } from './identity.ts';
import { effectivePayeeId, isLive, payeeGroupKey, payeeLabel } from './resolve.ts';
import type { ScheduleMatches } from './schedules.ts';
import type { Account, Payee, Transaction } from './model';

// Habits (WF-7, app-modification spec §5.5): repeated spending at one payee, with no
// amount or interval rule. Pure and computed on read; nothing is stored except the
// user's *Not a habit* (payees.habit_hidden). A Habit never carries a date, a range or
// due wording: it is a description of the past, not a prediction.

const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

export const HABIT_WINDOW_DAYS = 365;
export const MIN_SPENDS = 4;
export const MIN_MONTHS = 3;
export const ACTIVE_DAYS = 60;
export const RANK_DAYS = 90;
// Self-transfer pairing: a debit and a same-amount credit on a different own account,
// the credit landing up to 30 minutes after (2 minutes before, for SMS clock skew).
export const TRANSFER_AFTER_MS = 30 * 60_000;
export const TRANSFER_BEFORE_MS = 2 * 60_000;
export const SELF_PAYEE_MIN_PAIRED = 2;

export type HabitState = 'active' | 'faded';

export interface Habit {
  groupKey: string;
  label: string;
  // Most-used payee in the group (for navigation); payeeIds lists every member seen.
  payeeId: string;
  payeeIds: string[];
  // Within the trailing 365 days.
  count: number;
  since: number;
  perMonthPaise: number;
  lastAt: number;
  state: HabitState;
  // Trailing-90-day spend: the Active list's sort key.
  recentPaise: number;
}

// IST calendar month index (year * 12 + month), independent of the host time zone.
function monthIndex(t: number): number {
  const d = new Date(t + IST_MS);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function fold(s: string): string { return s.trim().normalize('NFKC').toLocaleLowerCase(); }

// Payees that are never a Habit, whatever their rows: the parser's unknown fallback,
// the user's own accounts (self-transfers and card bills, by masked last4 or by an
// account's name), and groups the user marked *Not a habit*.
export function habitExclusions(payees: ReadonlyMap<string, Payee>, accounts: readonly Account[]): (payee: Payee) => boolean {
  const ownLast4 = new Set(accounts.map(a => a.last4));
  const accountNames = new Set(accounts.flatMap(a => a.name ? [fold(a.name)] : []));
  const hiddenGroups = new Set<string>();
  for (const p of payees.values()) if (p.habitHidden) hiddenGroups.add(payeeGroupKey(p));
  return payee => {
    const group = payeeGroupKey(payee);
    if (hiddenGroups.has(group)) return true;
    if (!payee.name && payee.kind === 'merchant' && fold(payee.key.replace(/#\d+$/, '')) === fold(UNKNOWN_MERCHANT)) return true;
    // A masked counterparty carries only its last 4, and the bank of the other side is
    // not in the SMS; a match on one of the user's own accounts is a transfer to self or
    // a card bill (credit_card accounts are among them).
    if (payee.kind === 'masked' && ownLast4.has(payee.key.replace(/#\d+$/, ''))) return true;
    if (accountNames.has(fold(payeeLabel(payee)))) return true;
    return false;
  };
}

// Debits that are one side of a transfer between the user's own accounts: a Live credit
// of the same amount on a different account lands within the pairing window. Each
// credit pairs once, with the nearest debit. Catches UPI handles and names that carry
// no last4 (to self), and card bills paid through an app (the card's credit SMS).
export function ownTransferDebits(rows: readonly Transaction[]): Set<string> {
  const debits = rows.filter(t => isLive(t) && t.direction === 'debit' && t.accountId).sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  const credits = rows.filter(t => isLive(t) && t.direction === 'credit' && t.accountId).sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const paired = new Set<string>();
  for (const d of debits) {
    let best: Transaction | null = null;
    for (const c of credits) {
      if (c.occurredAt > d.occurredAt + TRANSFER_AFTER_MS) break;
      if (c.occurredAt < d.occurredAt - TRANSFER_BEFORE_MS || used.has(c.id) || c.amountPaise !== d.amountPaise || c.accountId === d.accountId) continue;
      if (!best || Math.abs(c.occurredAt - d.occurredAt) < Math.abs(best.occurredAt - d.occurredAt)) best = c;
    }
    if (best) { used.add(best.id); paired.add(d.id); }
  }
  return paired;
}

// Payees that are mostly the sending side of own-account transfers (≥2 paired, and at
// least half their Live debits): all their rows are self-transfers, including the ones
// whose receiving SMS never arrived.
export function selfTransferPayees(rows: readonly Transaction[], paired: ReadonlySet<string>): Set<string> {
  const counts = new Map<string, { debits: number; paired: number }>();
  for (const t of rows) {
    if (!isLive(t) || t.direction !== 'debit') continue;
    const id = effectivePayeeId(t);
    if (!id) continue;
    const c = counts.get(id) ?? { debits: 0, paired: 0 };
    c.debits++;
    if (paired.has(t.id)) c.paired++;
    counts.set(id, c);
  }
  return new Set([...counts].filter(([, c]) => c.paired >= SELF_PAYEE_MIN_PAIRED && c.paired * 2 >= c.debits).map(([id]) => id));
}

// detectHabits (spec §5.5). Input: Detection input debit rows (Live; a pending duplicate
// pair already counts once, as its earlier row), minus rows a confirmed Schedule matched.
export function detectHabits(rows: readonly Transaction[], scheduleMatches: Pick<ScheduleMatches, 'matches'>, payees: ReadonlyMap<string, Payee>, accounts: readonly Account[], now: number): Habit[] {
  const excluded = habitExclusions(payees, accounts);
  const paired = ownTransferDebits(rows);
  const selfPayees = selfTransferPayees(rows, paired);
  const from = now - HABIT_WINDOW_DAYS * DAY_MS;
  const groups = new Map<string, { rows: Transaction[]; members: Map<string, number> }>();
  for (const t of rows) {
    if (!isLive(t) || t.direction !== 'debit' || t.occurredAt < from || t.occurredAt > now) continue;
    if (scheduleMatches.matches.has(t.id) || paired.has(t.id)) continue;
    // No payee covers the parser's unknown fallback: identity never makes a merchant
    // payee for it (a masked counterparty gets a masked payee instead).
    const id = effectivePayeeId(t);
    const payee = id ? payees.get(id) : undefined;
    if (!payee || excluded(payee) || selfPayees.has(payee.id)) continue;
    const key = payeeGroupKey(payee);
    const g = groups.get(key) ?? { rows: [] as Transaction[], members: new Map<string, number>() };
    g.rows.push(t);
    g.members.set(payee.id, (g.members.get(payee.id) ?? 0) + 1);
    groups.set(key, g);
  }
  const habits: Habit[] = [];
  for (const [groupKey, g] of groups) {
    if (g.rows.length < MIN_SPENDS) continue;
    const months = new Set(g.rows.map(t => monthIndex(t.occurredAt)));
    if (months.size < MIN_MONTHS) continue;
    const since = Math.min(...g.rows.map(t => t.occurredAt));
    const lastAt = Math.max(...g.rows.map(t => t.occurredAt));
    const total = g.rows.reduce((n, t) => n + t.amountPaise, 0);
    const span = monthIndex(lastAt) - monthIndex(since) + 1;
    const recentFrom = now - RANK_DAYS * DAY_MS;
    const [payeeId] = [...g.members].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    habits.push({
      groupKey, label: payeeLabel(payees.get(payeeId)!), payeeId, payeeIds: [...g.members.keys()].sort(),
      count: g.rows.length, since, perMonthPaise: Math.round(total / span), lastAt,
      state: now - lastAt <= ACTIVE_DAYS * DAY_MS ? 'active' : 'faded',
      recentPaise: g.rows.filter(t => t.occurredAt >= recentFrom).reduce((n, t) => n + t.amountPaise, 0),
    });
  }
  return habits.sort((a, b) => a.state === b.state
    ? (a.state === 'active' ? b.recentPaise - a.recentPaise : b.lastAt - a.lastAt) || a.label.localeCompare(b.label)
    : a.state === 'active' ? -1 : 1);
}

// The Habit (if any) a payee's group is in; the chip shows only for Active ones.
export function habitFor(payee: Payee, habits: readonly Habit[]): Habit | null {
  const key = payeeGroupKey(payee);
  return habits.find(h => h.groupKey === key) ?? null;
}

// Payees sharing this payee's display identity: *Not a habit* applies to all of them,
// so a variant string can't keep the Habit alive.
export function groupMembers(payee: Payee, payees: Iterable<Payee>): string[] {
  const key = payeeGroupKey(payee);
  return [...payees].filter(p => payeeGroupKey(p) === key).map(p => p.id).sort();
}

export function isHabitHidden(payee: Payee, payees: Iterable<Payee>): boolean {
  const key = payeeGroupKey(payee);
  for (const p of payees) if (p.habitHidden && payeeGroupKey(p) === key) return true;
  return false;
}

// Rows behind a Habit row's tap-through: the group's Live debits, newest first.
export function groupRows(groupKey: string, rows: readonly Transaction[], payees: ReadonlyMap<string, Payee>): Transaction[] {
  return rows.filter(t => {
    if (!isLive(t) || t.direction !== 'debit') return false;
    const id = effectivePayeeId(t);
    const p = id ? payees.get(id) : undefined;
    return !!p && payeeGroupKey(p) === groupKey;
  }).sort((a, b) => b.occurredAt - a.occurredAt);
}

// "~₹1.4k": a rough figure, never an exact amount or a range.
export function roughRupees(paise: number): string {
  const rs = paise / 100;
  if (rs >= 100_000) return `~₹${trim(rs / 100_000)}L`;
  if (rs >= 1_000) return `~₹${trim(rs / 1_000)}k`;
  return `~₹${Math.round(rs)}`;
}
function trim(n: number): string { return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toString(); }

export function lastSpendLabel(lastAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - lastAt) / DAY_MS));
  if (days === 0) return 'last today';
  if (days === 1) return 'last yesterday';
  if (days < 60) return `last ${days} days ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `last ${months} months ago` : `last over a year ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthYear(t: number): string { const m = monthIndex(t); return `${MONTHS[m % 12]} ${Math.floor(m / 12)}`; }

// "Blinkit · 35 spends since Mar 2025 · ~₹1.4k/month · last 3 days ago" (WF-7).
export function habitDetail(h: Habit, now: number): string {
  return `${h.count} spends since ${monthYear(h.since)} · ${roughRupees(h.perMonthPaise)}/month · ${lastSpendLabel(h.lastAt, now)}`;
}
