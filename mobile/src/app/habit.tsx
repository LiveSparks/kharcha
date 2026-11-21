import React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, Screen, ScreenHead, TransactionRow } from '@/ui/Kit';
import { groupRows, habitDetail, habitFor } from '@/lib/habits';
import { payeeGroupKey } from '@/lib/resolve';
import { useLedger } from '@/state/LedgerProvider';

// A Habit's tap-through (spec §5.5): that payee group's spends, newest first. Keyed by
// payee, not group, so renaming from here keeps the screen on the (now larger) group.
export default function HabitScreen() {
  const { payee: payeeId } = useLocalSearchParams<{ payee: string }>();
  const { habits, transactions, payeesById, asOf } = useLedger();
  const payee = payeesById.get(payeeId);
  const key = payee ? payeeGroupKey(payee) : null;
  const habit = payee ? habitFor(payee, habits) : null;
  const rows = key ? groupRows(key, transactions, payeesById) : [];
  if (!habit) return <Screen><ScreenHead title="Not a habit now" back /><Body muted>This payee no longer shows as a habit.</Body></Screen>;
  return <Screen><ScreenHead title={habit.label} back />
    <Caption>{habitDetail(habit, asOf)}</Caption>
    <View style={{ marginTop: 12, marginBottom: 8 }}>
      <Action compact variant="secondary" title="Payee settings" onPress={() => router.push({ pathname: '/name', params: { kind: 'payee', id: payeeId } })} />
    </View>
    <View style={{ marginTop: 8 }}>{rows.map(t => <TransactionRow key={t.id} transaction={t} />)}</View>
  </Screen>;
}
