import { effectivePayeeId, isLive, payeeGroupKey } from './resolve.ts';
import type { Direction, Payee, Schedule, ScheduleInterval, Transaction } from './model';

// Schedules (WF-6, app-modification spec §5.4). Pure: detection proposes series, the
// user confirms them, and matching walks the history on every read. Nothing here writes.
//
// Calendar arithmetic is done in IST (the app reads Indian bank SMS, and the phone's
// local time is IST), with a fixed offset so the result doesn't depend on the host's
// time zone (tests and the replay run in UTC).

export const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

interface Civil { y: number; m: number; d: number; wd: number }
function civil(t: number): Civil {
  const x = new Date(t + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay() };
}
// Start of an IST day; month may overflow either way.
function dayAt(y: number, m: number, d: number): number { return Date.UTC(y, m, d) - IST_MS; }
function daysIn(y: number, m: number): number { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
export function dayStart(t: number): number { const c = civil(t); return dayAt(c.y, c.m, c.d); }
// The anchor day in month (y, m), with Firefly's end-of-month clamp (31 → 28/29/30).
function monthAnchor(y: number, m: number, day: number): number {
  const n = y * 12 + m;
  const yy = Math.floor(n / 12), mm = n - yy * 12;
  return dayAt(yy, mm, Math.min(day, daysIn(yy, mm)));
}
export function dayOfMonth(t: number): number { return civil(t).d; }
export function weekday(t: number): number { return civil(t).wd; }
// Quarterly phase of a month: Jan/Apr/Jul/Oct = 1, Feb/May/Aug/Nov = 2, Mar/Jun/Sep/Dec = 3.
export function quarterPhase(t: number): number { return civil(t).m % 3 + 1; }

interface IntervalClass { interval: ScheduleInterval; days?: number; months?: number; margin: number }
// v1 classes, shortest first (WF-6 table).
export const INTERVALS: readonly IntervalClass[] = [
  { interval: 'weekly', days: 7, margin: 1 },
  { interval: 'fortnightly', days: 14, margin: 2 },
  { interval: 'monthly', months: 1, margin: 4 },
  { interval: 'quarterly', months: 3, margin: 7 },
];
const CLASS = new Map(INTERVALS.map(c => [c.interval, c]));
export function marginDays(interval: ScheduleInterval): number { return CLASS.get(interval)!.margin; }

export const INTERVAL_LABEL: Record<ScheduleInterval, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly' };

// Detection thresholds (WF-6).
export const CLUSTER_BAND = 0.2;
export const MIN_HITS = 3;
export const MIN_CONSECUTIVE_GAPS = 2;
export const MIN_FIT_SHARE = 0.75;
export const MIN_GROUP_SHARE = 0.5;

// --- Series keys -------------------------------------------------------------------

const SEP = '\u001f';
export function seriesKey(groupKey: string, accountId: string | null, direction: Direction): string {
  return [groupKey, accountId ?? '', direction].join(SEP);
}

// A row's key: (payee group, account, direction). Rows with no payee never form a series.
export function rowSeriesKey(t: Transaction, payees: ReadonlyMap<string, Payee>): string | null {
  const id = effectivePayeeId(t);
  const payee = id ? payees.get(id) : undefined;
  return payee ? seriesKey(payeeGroupKey(payee), t.accountId, t.direction) : null;
}

// A stored Schedule's key, resolved through its representative payee's current group.
export function scheduleSeriesKey(s: Pick<Schedule, 'payeeId' | 'accountId' | 'direction'>, payees: ReadonlyMap<string, Payee>): string | null {
  const payee = payees.get(s.payeeId);
  return payee ? seriesKey(payeeGroupKey(payee), s.accountId, s.direction) : null;
}

// Detection input (spec §1): Live rows. The later row of a pending duplicate pair is
// `duplicate_review`, so the pair already counts once, as its earlier row.
function seriesRows(rows: readonly Transaction[], payees: ReadonlyMap<string, Payee>): Map<string, Transaction[]> {
  const byKey = new Map<string, Transaction[]>();
  for (const t of rows) {
    if (!isLive(t)) continue;
    const key = rowSeriesKey(t, payees);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return byKey;
}

// --- Anchors and steps -------------------------------------------------------------

export interface Terms { interval: ScheduleInterval; anchorDay: number; anchorMonth: number | null }

// The anchor occurrence nearest to t: the period t was paid for.
export function nearestAnchor(terms: Terms, t: number): number {
  const c = CLASS.get(terms.interval)!;
  if (c.days) {
    const delta = ((terms.anchorDay - civil(t).wd + 7 + 3) % 7) - 3;
    return dayStart(t) + delta * DAY_MS;
  }
  const { y, m } = civil(t);
  let best = Number.NaN;
  for (let dm = -2; dm <= 2; dm++) {
    const month = ((m + dm) % 12 + 12) % 12;
    if (terms.interval === 'quarterly' && terms.anchorMonth != null && month % 3 + 1 !== terms.anchorMonth) continue;
    if (terms.interval === 'monthly' && Math.abs(dm) > 1) continue;
    const a = monthAnchor(y, m + dm, terms.anchorDay);
    if (Number.isNaN(best) || Math.abs(a - t) < Math.abs(best - t)) best = a;
  }
  return best;
}

// k periods after an anchor occurrence.
export function stepAnchor(terms: Terms, anchor: number, k = 1): number {
  const c = CLASS.get(terms.interval)!;
  if (c.days) return anchor + k * c.days * DAY_MS;
  const { y, m } = civil(anchor);
  return monthAnchor(y, m + k * c.months!, terms.anchorDay);
}

export interface Window { expectedAt: number; windowStart: number; windowEnd: number }
// The window around an expected date: ±margin days, whole days, end exclusive.
export function windowAt(interval: ScheduleInterval, expectedAt: number): Window {
  const m = marginDays(interval);
  return { expectedAt, windowStart: expectedAt - m * DAY_MS, windowEnd: expectedAt + (m + 1) * DAY_MS };
}

// Anchor fields for an interval, taken from one date (the Track form and manual entry).
export function anchorsFor(interval: ScheduleInterval, at: number): { anchorDay: number; anchorMonth: number | null } {
  if (CLASS.get(interval)!.days) return { anchorDay: weekday(at), anchorMonth: null };
  return { anchorDay: dayOfMonth(at), anchorMonth: interval === 'quarterly' ? quarterPhase(at) : null };
}

// --- Detection ---------------------------------------------------------------------

export interface SeriesCandidate {
  seriesKey: string;
  // The most recent hit's payee: what Track it stores as the representative.
  payeeId: string;
  accountId: string | null;
  direction: Direction;
  interval: ScheduleInterval;
  anchorDay: number;
  anchorMonth: number | null;
  // Track-it band: [min × 0.8, max × 1.2], rounded out to the rupee.
  amountMin: number;
  amountMax: number;
  // Median of the last 3 hits ("₹299").
  typicalPaise: number;
  hits: Transaction[];
  firstHitAt: number;
  lastHitAt: number;
  // The window after the last hit has closed with nothing in it: Schedules screen only.
  lapsed: boolean;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const rolling = (hits: readonly Transaction[]) => median(hits.slice(-3).map(t => t.amountPaise));

// Amount clusters: a row joins the cluster whose rolling median (last 3 hits) is within
// ±20% of it and nearest; otherwise it starts a new cluster.
export function amountClusters(rows: readonly Transaction[]): Transaction[][] {
  const clusters: Transaction[][] = [];
  for (const t of rows) {
    let best: Transaction[] | null = null;
    let bestDistance = Infinity;
    for (const c of clusters) {
      const med = rolling(c);
      const distance = Math.abs(t.amountPaise - med) / med;
      if (distance <= CLUSTER_BAND + 1e-9 && distance < bestDistance) { best = c; bestDistance = distance; }
    }
    if (best) best.push(t); else clusters.push([t]);
  }
  return clusters;
}

// Does the gap a → b fit k periods (k = 1 or 2) within margin·√k? Returns k, or 0.
// Weekly classes measure from a's own day. The month classes use the same model as the
// matcher: a must itself lie within the margin of its anchor occurrence (the median
// day-of-month), and b within margin·√k of the anchor k steps on. So a series that
// jitters around the 5th fits, while hits that drift (9th, 16th, 14th) or wander off
// the anchor don't.
function gapFit(c: IntervalClass, anchorDay: number, a: number, b: number): number {
  let from = dayStart(a);
  if (c.months) {
    from = nearestAnchor({ interval: 'monthly', anchorDay, anchorMonth: null }, a);
    if (Math.abs(dayStart(a) - from) / DAY_MS > c.margin + 1e-9) return 0;
  }
  for (const k of [1, 2]) {
    const expected = c.days ? from + k * c.days * DAY_MS : stepAnchor({ interval: c.interval, anchorDay, anchorMonth: null }, from, k);
    if (Math.abs(dayStart(b) - expected) / DAY_MS <= c.margin * Math.sqrt(k) + 1e-9) return k;
  }
  return 0;
}

export interface GapFit { interval: ScheduleInterval; anchorDay: number; fits: number; consecutive: number; gaps: number }

// The first class, shortest first, whose gaps pass the evidence gate.
export function classify(hits: readonly Transaction[]): GapFit | null {
  if (hits.length < MIN_HITS) return null;
  const dom = median(hits.map(t => dayOfMonth(t.occurredAt)));
  for (const c of INTERVALS) {
    const anchorDay = c.days ? weekday(hits[hits.length - 1].occurredAt) : dom;
    let fits = 0, consecutive = 0;
    for (let i = 1; i < hits.length; i++) {
      const k = gapFit(c, dom, hits[i - 1].occurredAt, hits[i].occurredAt);
      if (k) fits++;
      if (k === 1) consecutive++;
    }
    const gaps = hits.length - 1;
    if (consecutive >= MIN_CONSECUTIVE_GAPS && fits >= MIN_FIT_SHARE * gaps - 1e-9) return { interval: c.interval, anchorDay, fits, consecutive, gaps };
  }
  return null;
}

export function bandFor(minPaise: number, maxPaise: number): { amountMin: number; amountMax: number } {
  return { amountMin: Math.floor(minPaise * (1 - CLUSTER_BAND) / 100) * 100, amountMax: Math.ceil(maxPaise * (1 + CLUSTER_BAND) / 100) * 100 };
}

// detectSeries (spec §5.4): every series that passes the gate, whether or not it has been
// tracked or dismissed (see suggestionsFrom).
export function detectSeries(rows: readonly Transaction[], payees: ReadonlyMap<string, Payee>, now: number): SeriesCandidate[] {
  const out: SeriesCandidate[] = [];
  for (const [key, group] of seriesRows(rows, payees)) {
    if (group.length < MIN_HITS) continue;
    for (const hits of amountClusters(group)) {
      const fit = classify(hits);
      if (!fit) continue;
      const first = hits[0].occurredAt, last = hits[hits.length - 1].occurredAt;
      const span = group.filter(t => t.occurredAt >= first && t.occurredAt <= last).length;
      if (hits.length < MIN_GROUP_SHARE * span - 1e-9) continue;
      const lastHit = hits[hits.length - 1];
      const terms: Terms = { interval: fit.interval, anchorDay: fit.anchorDay, anchorMonth: fit.interval === 'quarterly' ? quarterPhase(nearestAnchor({ interval: 'monthly', anchorDay: fit.anchorDay, anchorMonth: null }, last)) : null };
      const next = windowAt(fit.interval, stepAnchor(terms, nearestAnchor(terms, last)));
      const amounts = hits.map(t => t.amountPaise);
      out.push({
        seriesKey: key, payeeId: effectivePayeeId(lastHit)!, accountId: lastHit.accountId, direction: lastHit.direction,
        ...terms, ...bandFor(Math.min(...amounts), Math.max(...amounts)), typicalPaise: rolling(hits),
        hits, firstHitAt: first, lastHitAt: last, lapsed: now >= next.windowEnd,
      });
    }
  }
  return out.sort((a, b) => b.lastHitAt - a.lastHitAt || b.hits.length - a.hits.length);
}

// Suggestions = candidates minus any stored row (any status) on the same series key and
// interval whose band overlaps the candidate's. The band check keeps WF-6's "a new
// amount cluster on the same key is still eligible".
export function suggestionsFrom(candidates: readonly SeriesCandidate[], schedules: readonly Schedule[], payees: ReadonlyMap<string, Payee>): SeriesCandidate[] {
  const stored = schedules.map(s => ({ s, key: scheduleSeriesKey(s, payees) }));
  return candidates.filter(c => !stored.some(({ s, key }) => key === c.seriesKey && s.interval === c.interval
    && s.amountMin <= c.amountMax && c.amountMin <= s.amountMax));
}

// --- Matching and states -------------------------------------------------------------

export type ScheduleState = 'upcoming' | 'due' | 'paid' | 'overdue' | 'lapsed';
export const STATE_LABEL: Record<ScheduleState, string> = { upcoming: 'Upcoming', due: 'Due', paid: 'Paid', overdue: 'Overdue', lapsed: 'Lapsed' };

export interface ScheduleView extends Window {
  schedule: Schedule;
  state: ScheduleState;
  // Latest matched row, from the walk (never written back).
  lastPaidAt: number | null;
  // Expected date of the most recent window that closed with no match (null once a later
  // window matches): what an Overdue or Lapsed Schedule "was due around".
  missedAt: number | null;
  // Matched rows, newest first.
  history: Transaction[];
  // 2 consecutive periods with a same-key row in the window but outside the band.
  drift: { fromPaise: number; toPaise: number } | null;
  typicalPaise: number;
}

export interface ScheduleMatches { matches: Map<string, string>; state: Map<string, ScheduleView> }

const MAX_WINDOWS = 2000;

// matchSchedules (spec §5.4). Walks each confirmed Schedule from its stored starting
// point: each window takes at most one row (the closest to the expected date) and a
// match moves the watermark on. Active and ended Schedules both claim rows (P5 needs
// them); an ended Schedule's walk stops when it was ended.
export function matchSchedules(rows: readonly Transaction[], schedules: readonly Schedule[], payees: ReadonlyMap<string, Payee>, now: number): ScheduleMatches {
  const byKey = seriesRows(rows, payees);
  const matches = new Map<string, string>();
  const state = new Map<string, ScheduleView>();
  const confirmed = schedules.filter(s => s.status !== 'dismissed').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const s of confirmed) {
    const key = scheduleSeriesKey(s, payees);
    const series = key ? byKey.get(key) ?? [] : [];
    const stopAt = s.status === 'ended' ? Math.min(now, s.decidedAt) : now;
    const fallbackTypical = Math.round((s.amountMin + s.amountMax) / 2);
    let expected = nearestAnchor(s, s.lastPaidAt ?? s.createdAt);
    let misses = 0, driftRun = 0, driftTo = 0;
    let missedAt: number | null = null;
    let lastPaidAt: number | null = null, lastAmount: number | null = null;
    let last: { matched: boolean; open: boolean } | null = null;
    const history: Transaction[] = [];
    for (let n = 0; n < MAX_WINDOWS; n++) {
      const w = windowAt(s.interval, expected);
      if (w.windowStart > stopAt) break;
      const inWindow = series.filter(t => t.occurredAt >= w.windowStart && t.occurredAt < w.windowEnd && t.occurredAt <= stopAt && !matches.has(t.id));
      const closest = (list: Transaction[]) => list.reduce<Transaction | null>((best, t) =>
        !best || Math.abs(t.occurredAt - expected) < Math.abs(best.occurredAt - expected) ? t : best, null);
      const hit = closest(inWindow.filter(t => t.amountPaise >= s.amountMin && t.amountPaise <= s.amountMax));
      const open = w.windowEnd > stopAt;
      if (hit) {
        matches.set(hit.id, s.id);
        history.push(hit);
        lastPaidAt = hit.occurredAt;
        lastAmount = hit.amountPaise;
        misses = 0;
        missedAt = null;
        driftRun = 0;
      } else {
        if (!open) { misses++; missedAt = expected; }
        const off = closest(inWindow);
        if (off) { driftRun++; driftTo = off.amountPaise; } else if (!open) driftRun = 0;
      }
      last = { matched: !!hit, open };
      if (open) break;
      expected = stepAnchor(s, expected);
    }
    let current = windowAt(s.interval, expected);
    let st: ScheduleState;
    if (!last) st = 'upcoming';
    else if (last.matched) {
      st = 'paid';
      if (last.open) current = windowAt(s.interval, stepAnchor(s, expected));
    } else if (misses >= 2) st = 'lapsed';
    else if (misses === 1) st = 'overdue';
    else st = 'due';
    state.set(s.id, {
      schedule: s, state: st, ...current, lastPaidAt, missedAt, history: history.reverse(),
      drift: driftRun >= 2 ? { fromPaise: lastAmount ?? fallbackTypical, toPaise: driftTo } : null,
      typicalPaise: lastAmount ?? fallbackTypical,
    });
  }
  return { matches, state };
}

// Home strip "Upcoming this week": active Schedules whose next window opens within 7
// days, plus any that are Due or Overdue. Lapsed ones wait on the Schedules screen.
export function upcomingThisWeek(views: Iterable<ScheduleView>, now: number): ScheduleView[] {
  return [...views].filter(v => v.schedule.status === 'active' && v.state !== 'lapsed'
    && (v.state === 'due' || v.state === 'overdue' || v.windowStart <= now + 7 * DAY_MS))
    .sort((a, b) => a.expectedAt - b.expectedAt);
}

// Tracking section order: next expected date.
export function trackingOrder(views: Iterable<ScheduleView>): ScheduleView[] {
  return [...views].filter(v => v.schedule.status === 'active').sort((a, b) => a.expectedAt - b.expectedAt || a.schedule.id.localeCompare(b.schedule.id));
}

// Payee badge ("Monthly · ₹299"): an active Schedule on this payee's group.
export function scheduleFor(payee: Payee, views: Iterable<ScheduleView>, payees: ReadonlyMap<string, Payee>): ScheduleView | null {
  const group = payeeGroupKey(payee);
  for (const v of views) {
    if (v.schedule.status !== 'active') continue;
    const rep = payees.get(v.schedule.payeeId);
    if (rep && payeeGroupKey(rep) === group) return v;
  }
  return null;
}

// --- Track form drafts ---------------------------------------------------------------

export type ScheduleDraft = Omit<Schedule, 'id' | 'status' | 'createdAt' | 'decidedAt'>;

export function draftFromCandidate(c: SeriesCandidate): ScheduleDraft {
  return {
    payeeId: c.payeeId, accountId: c.accountId, direction: c.direction, interval: c.interval, anchorDay: c.anchorDay,
    anchorMonth: c.anchorMonth, amountMin: c.amountMin, amountMax: c.amountMax, lastPaidAt: c.firstHitAt,
  };
}

// Manual Track as schedule (WF-7 hand-off): monthly, anchored on the row's day, ±20%.
export function draftFromRow(t: Transaction): ScheduleDraft | null {
  const payeeIdValue = effectivePayeeId(t);
  if (!payeeIdValue) return null;
  return {
    payeeId: payeeIdValue, accountId: t.accountId, direction: t.direction, interval: 'monthly',
    ...anchorsFor('monthly', t.occurredAt), ...bandFor(t.amountPaise, t.amountPaise), lastPaidAt: t.occurredAt,
  };
}

export function validateTerms(d: Pick<Schedule, 'interval' | 'anchorDay' | 'anchorMonth' | 'amountMin' | 'amountMax'>): void {
  const weekly = !!CLASS.get(d.interval)?.days;
  if (!CLASS.has(d.interval)) throw new Error('Pick how often it repeats.');
  if (!Number.isInteger(d.anchorDay) || (weekly ? d.anchorDay < 0 || d.anchorDay > 6 : d.anchorDay < 1 || d.anchorDay > 31)) {
    throw new Error(weekly ? 'Pick a weekday.' : 'The day of the month must be between 1 and 31.');
  }
  if (d.interval === 'quarterly' && !(d.anchorMonth === 1 || d.anchorMonth === 2 || d.anchorMonth === 3)) throw new Error('Pick the quarter month.');
  if (!Number.isSafeInteger(d.amountMin) || !Number.isSafeInteger(d.amountMax) || d.amountMin <= 0 || d.amountMax < d.amountMin) {
    throw new Error('Enter an amount range with the lower figure first.');
  }
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
