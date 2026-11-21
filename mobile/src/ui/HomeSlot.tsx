import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action } from './Kit';
import { fonts, usePalette } from './theme';
import { namingNudge } from '@/lib/resolve';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from './dialog';

// Home card slot (spec §6): at most one card. Priority, highest first, as later phases
// add sources: pending duplicates (P2) > naming nudge (P1) > schedule suggestion (P4).
export function HomeSlot() {
  const p = usePalette();
  const { payees, stats, pairs, markPayeeNudged } = useLedger();
  const nudge = useMemo(() => namingNudge(payees, stats), [payees, stats]);
  // Pending duplicates distort totals, so they outrank naming (WF-5). No snooze.
  if (pairs.length) {
    const n = pairs.length;
    return <View style={{ backgroundColor: p.marigoldSoft, borderRadius: 14, padding: 15, marginBottom: 16, gap: 12 }}>
      <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink, fontSize: 15 }}>{n} possible {n === 1 ? 'duplicate' : 'duplicates'} to check</Text>
      <View style={{ flexDirection: 'row' }}><Action compact variant="leaf" title="Review" onPress={() => router.push({ pathname: '/(tabs)/inbox', params: { tab: 'duplicates' } })} /></View>
    </View>;
  }
  if (!nudge) return null;
  // Either answer stamps nudged_at, so the card never returns for this payee.
  async function answer(name: boolean) {
    if (!nudge) return;
    try {
      await markPayeeNudged(nudge.payee.id);
      if (name) router.push({ pathname: '/name', params: { kind: 'payee', id: nudge.payee.id } });
    } catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
  }
  return <View style={{ backgroundColor: p.surface, borderRadius: 14, borderWidth: 1, borderColor: p.line, padding: 15, marginBottom: 16, gap: 12 }}>
    <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink, fontSize: 15 }}>{(stats.get(nudge.payee.id)?.spentPaise ?? 0) > 0 ? <>You&apos;ve paid {nudge.label} {nudge.count} times.</> : <>{nudge.label} has paid you {nudge.count} times.</>} Name it?</Text>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Action compact variant="leaf" title="Name" onPress={() => void answer(true)} />
      <Action compact variant="ghost" title="Not now" onPress={() => void answer(false)} />
    </View>
  </View>;
}
