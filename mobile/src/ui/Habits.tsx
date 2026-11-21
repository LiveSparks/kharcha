import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Caption } from './Kit';
import { fonts, usePalette } from './theme';
import { habitDetail, habitFor } from '@/lib/habits';
import type { Habit } from '@/lib/habits';
import type { Payee } from '@/lib/model';
import { useLedger } from '@/state/LedgerProvider';

// Habits UI pieces (spec §5.5). A Habit describes the past: no date, no range, no
// due or upcoming wording, and never a Home card.

export function HabitChip({ payee }: { payee: Payee }) {
  const p = usePalette();
  const { habits } = useLedger();
  const h = habitFor(payee, habits);
  if (!h || h.state !== 'active') return null;
  return <View accessibilityLabel="Habit" style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, backgroundColor: p.marigoldSoft, marginTop: 5 }}>
    <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 12, color: p.ink }}>Habit</Text>
  </View>;
}

export function HabitLine({ habit: h, now }: { habit: Habit; now: number }) {
  const p = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${h.label}, ${habitDetail(h, now)}`}
    onPress={() => router.push({ pathname: '/habit', params: { payee: h.payeeId } })}
    style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line }}>
    <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: h.state === 'active' ? p.ink : p.muted }}>{h.label}</Text>
    <Caption>{habitDetail(h, now)}</Caption>
  </Pressable>;
}
