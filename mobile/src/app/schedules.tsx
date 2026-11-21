import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Caption, EmptyState, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { SuggestionCard, TrackingRow } from '@/ui/Schedules';
import { trackingOrder } from '@/lib/schedules';
import { useLedger } from '@/state/LedgerProvider';
import { usePalette } from '@/ui/theme';

// Schedules (WF-6): Suggested on top (nothing is predicted until the user confirms),
// then Tracking by next expected date. Stopped Schedules keep their history below.
export default function Schedules() {
  const p = usePalette();
  const { suggestions, scheduleMatches } = useLedger();
  const [showEnded, setShowEnded] = useState(false);
  const tracking = useMemo(() => trackingOrder(scheduleMatches.state.values()), [scheduleMatches]);
  const ended = useMemo(() => [...scheduleMatches.state.values()].filter(v => v.schedule.status === 'ended'), [scheduleMatches]);
  const active = suggestions.filter(c => !c.lapsed);
  const lapsed = suggestions.filter(c => c.lapsed);
  return <Screen><ScreenHead title="Schedules" back />
    {!suggestions.length && !tracking.length ? <EmptyState title="Nothing repeating yet" detail="When a payment shows up at a regular interval at least three times, it is suggested here. You can also track a bill from its transaction." /> : null}
    {suggestions.length ? <View style={{ marginBottom: 28 }}>
      <SectionTitle>Suggested · {suggestions.length}</SectionTitle>
      <Caption style={{ marginTop: 3, marginBottom: 10 }}>Track one to see when it is next due. Nothing is predicted until you do.</Caption>
      {active.map(c => <SuggestionCard key={`${c.seriesKey}|${c.interval}|${c.firstHitAt}`} candidate={c} />)}
      {lapsed.length ? <Caption style={{ marginTop: 8, marginBottom: 8 }}>Not seen lately</Caption> : null}
      {lapsed.map(c => <SuggestionCard key={`${c.seriesKey}|${c.interval}|${c.firstHitAt}`} candidate={c} />)}
    </View> : null}
    {tracking.length ? <View style={{ marginBottom: 28 }}>
      <SectionTitle>Tracking · {tracking.length}</SectionTitle>
      <View style={{ marginTop: 6 }}>{tracking.map(v => <TrackingRow key={v.schedule.id} view={v} />)}</View>
    </View> : null}
    {ended.length ? <Pressable accessibilityRole="button" onPress={() => setShowEnded(x => !x)} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: p.line }}>
      <Caption>{showEnded ? 'Hide' : 'Show'} stopped ({ended.length})</Caption>
    </Pressable> : null}
    {showEnded ? ended.map(v => <TrackingRow key={v.schedule.id} view={v} />) : null}
  </Screen>;
}
