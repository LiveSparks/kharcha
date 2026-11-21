import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Caption, Label, SectionTitle } from './Kit';
import { Icon } from './Icon';
import { fonts, usePalette } from './theme';
import type { Palette } from './theme';
import { showMessage } from './dialog';
import { money } from '@/lib/format';
import { accountLabel, payeeLabel } from '@/lib/resolve';
import { INTERVAL_LABEL, STATE_LABEL, scheduleFor, upcomingThisWeek } from '@/lib/schedules';
import type { ScheduleState, ScheduleView, SeriesCandidate } from '@/lib/schedules';
import type { Payee } from '@/lib/model';
import { useLedger } from '@/state/LedgerProvider';

// Schedules UI pieces (spec §5.4): the suggestion card, the state chip, the Home strip
// and the payee badge. "around" plus the window is the only precision claimed.

const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const weekdayName = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });
const monthYear = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' });

export function aroundLabel(t: number): string { return shortDate.format(new Date(t)); }
export function sinceLabel(t: number): string { return monthYear.format(new Date(t)); }

// Router param that names one candidate.
export function candidateKey(c: Pick<SeriesCandidate, 'seriesKey' | 'interval' | 'firstHitAt'>): string {
  return `${c.seriesKey}\u001e${c.interval}\u001e${c.firstHitAt}`;
}

export function suggestionText(c: SeriesCandidate, payees: ReadonlyMap<string, Payee>): string {
  const payee = payees.get(c.payeeId);
  return `Looks ${INTERVAL_LABEL[c.interval].toLowerCase()}: ${payee ? payeeLabel(payee) : 'this payee'} · ${money(c.typicalPaise)} · ${c.hits.length} times since ${sinceLabel(c.firstHitAt)}`;
}

function chipColors(state: ScheduleState, p: Palette): { bg: string; fg: string } {
  switch (state) {
    case 'paid': return { bg: p.leaf, fg: p.onLeaf };
    case 'due': return { bg: p.marigoldSoft, fg: p.ink };
    case 'overdue': return { bg: p.debitSoft, fg: p.debit };
    case 'lapsed': return { bg: p.sunk, fg: p.muted };
    default: return { bg: p.creditSoft, fg: p.credit };
  }
}

export function StateChip({ state }: { state: ScheduleState }) {
  const p = usePalette();
  const { bg, fg } = chipColors(state, p);
  return <View style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, backgroundColor: bg }}>
    <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 12, color: fg }}>{STATE_LABEL[state]}</Text>
  </View>;
}

// Track it / Not a schedule. Track it opens the form, prefilled from the series.
export function SuggestionCard({ candidate, compact = false }: { candidate: SeriesCandidate; compact?: boolean }) {
  const p = usePalette();
  const { payeesById, dismissSuggestion } = useLedger();
  const [busy, setBusy] = useState(false);
  async function dismiss() {
    setBusy(true);
    try { await dismissSuggestion(candidate); }
    catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }
  return <View style={{ backgroundColor: p.surface, borderRadius: 14, borderWidth: 1, borderColor: p.line, padding: 15, marginBottom: compact ? 16 : 10, gap: 12 }}>
    <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink, fontSize: 15 }}>{suggestionText(candidate, payeesById)}</Text>
    {candidate.lapsed ? <Caption>Last seen {aroundLabel(candidate.lastHitAt)}</Caption> : null}
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Action compact variant="leaf" title="Track it" disabled={busy} onPress={() => router.push({ pathname: '/schedule', params: { candidate: candidateKey(candidate) } })} />
      <Action compact variant="ghost" title="Not a schedule" disabled={busy} onPress={() => void dismiss()} />
    </View>
  </View>;
}

export function scheduleTitle(v: ScheduleView, payees: ReadonlyMap<string, Payee>): string {
  const payee = payees.get(v.schedule.payeeId);
  return payee ? payeeLabel(payee) : 'Unknown payee';
}

// Home "Upcoming this week": separate from the one-card slot; hidden when empty.
export function UpcomingStrip({ now }: { now: number }) {
  const p = usePalette();
  const { scheduleMatches, payeesById } = useLedger();
  const items = upcomingThisWeek(scheduleMatches.state.values(), now);
  if (!items.length) return null;
  return <View style={{ marginBottom: 16 }}>
    <Pressable accessibilityRole="button" onPress={() => router.push('/schedules')} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <SectionTitle>Upcoming this week</SectionTitle><Icon name="chevron" color={p.muted} size={16} />
    </Pressable>
    {items.map(v => <Pressable key={v.schedule.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/schedule', params: { id: v.schedule.id } })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: p.line }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{scheduleTitle(v, payeesById)} {money(v.typicalPaise)}</Text>
        <Caption>{v.state === 'overdue' && v.missedAt != null ? `was due around ${aroundLabel(v.missedAt)}` : `around ${weekdayName.format(new Date(v.expectedAt))} ${aroundLabel(v.expectedAt)}`}</Caption>
      </View>
      {v.state !== 'upcoming' ? <StateChip state={v.state} /> : null}
    </Pressable>)}
  </View>;
}

export function badgeText(v: ScheduleView): string { return `${INTERVAL_LABEL[v.schedule.interval]} · ${money(v.typicalPaise)}`; }

// "Monthly · ₹299" on the payee row and the Payees list.
export function ScheduleBadge({ payee }: { payee: Payee }) {
  const p = usePalette();
  const { scheduleMatches, payeesById } = useLedger();
  const v = scheduleFor(payee, scheduleMatches.state.values(), payeesById);
  if (!v) return null;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Schedule: ${badgeText(v)}`} onPress={() => router.push({ pathname: '/schedule', params: { id: v.schedule.id } })}
    style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, backgroundColor: p.creditSoft, marginTop: 5 }}>
    <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 12, color: p.credit }}>{badgeText(v)}</Text>
  </Pressable>;
}

export function TrackingRow({ view: v }: { view: ScheduleView }) {
  const p = usePalette();
  const { payeesById, accountsById } = useLedger();
  const account = v.schedule.accountId ? accountsById.get(v.schedule.accountId) : undefined;
  return <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/schedule', params: { id: v.schedule.id } })}
    style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Label><Text numberOfLines={1}>{scheduleTitle(v, payeesById)}</Text></Label>
      <Caption numberOfLines={1}>{account ? `${accountLabel(account)} · ` : ''}{money(v.typicalPaise)} · {INTERVAL_LABEL[v.schedule.interval].toLowerCase()}</Caption>
      <Caption>next around {aroundLabel(v.expectedAt)}</Caption>
    </View>
    <StateChip state={v.state} />
  </Pressable>;
}
