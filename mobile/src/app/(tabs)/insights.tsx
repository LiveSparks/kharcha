import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CategoryDot, EmptyState, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { CATEGORIES } from '@/lib/model';
import { money } from '@/lib/format';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { isLive } from '@/lib/resolve';
import { HabitLine } from '@/ui/Habits';
import type { Habit } from '@/lib/habits';

type Period = 'Week' | 'Month' | 'Year';
function periodStart(period: Period): number {
  const d = new Date();
  if (period === 'Week') { const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); }
  else if (period === 'Month') d.setDate(1);
  else { d.setMonth(0); d.setDate(1); }
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function Insights() {
  const p = usePalette();
  const { transactions, categoryOf, habits, asOf } = useLedger();
  const [period, setPeriod] = useState<Period>('Month');
  const data = useMemo(() => {
    const totals = Object.fromEntries(CATEGORIES.map(c => [c, 0])) as Record<typeof CATEGORIES[number], number>;
    const included = transactions.filter(t => t.occurredAt >= periodStart(period) && isLive(t) && t.direction === 'debit');
    for (const t of included) totals[categoryOf(t)] += t.amountPaise;
    return { entries: included.length, categories: CATEGORIES.map(category => ({ category, amount: totals[category] })).filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount) };
  }, [transactions, period, categoryOf]);
  const total = data.categories.reduce((sum, row) => sum + row.amount, 0);
  return <Screen>
    <ScreenHead title="Where it went" />
    <View style={{ flexDirection: 'row', gap: 7, marginTop: 7 }}>
      {(['Week', 'Month', 'Year'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: period === value }} onPress={() => setPeriod(value)} style={{ paddingHorizontal: 20, paddingVertical: 9, borderRadius: 9, backgroundColor: period === value ? p.leaf : p.surface }}><Text style={{ fontFamily: fonts.bodyMedium, color: period === value ? p.onLeaf : p.muted }}>{value}</Text></Pressable>)}
    </View>
    <View style={{ marginTop: 33, marginBottom: 25 }}><Text style={{ fontFamily: fonts.body, color: p.muted, fontSize: 14 }}>Total spent · {period.toLowerCase()}</Text><Text style={{ fontFamily: fonts.mono, fontSize: 37, color: p.ink, marginTop: 5 }}>{money(total)}</Text><Text style={{ fontFamily: fonts.body, color: p.muted, marginTop: 4 }}>{data.entries} {data.entries === 1 ? 'transaction' : 'transactions'}</Text></View>
    {data.categories.length ? <>
      <View style={{ height: 22, flexDirection: 'row', overflow: 'hidden', borderRadius: 7, marginBottom: 27 }}>
        {data.categories.map(row => <View key={row.category} style={{ width: `${row.amount / total * 100}%`, backgroundColor: categoryColor(row.category) }} />)}
      </View>
      <SectionTitle>By category</SectionTitle>
      <View style={{ marginTop: 13 }}>
        {data.categories.map(row => <View key={row.category} style={{ paddingVertical: 15, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: p.line }}><CategoryDot category={row.category} size={11} /><Text style={{ flex: 1, fontFamily: fonts.bodyMedium, color: p.ink }}>{row.category}</Text><Text style={{ fontFamily: fonts.mono, color: p.ink }}>{money(row.amount)}</Text><Text style={{ fontFamily: fonts.body, color: p.muted, width: 34, textAlign: 'right' }}>{Math.round(row.amount / total * 100)}%</Text></View>)}
      </View>
    </> : <EmptyState title="Your picture will grow" detail="Once you add an expense, its category will show here." />}
    <HabitsSection habits={habits} now={asOf} />
  </Screen>;
}

// Habits (P5, WF-7): repeated spending at one payee over the past year, Active ones by
// their last 90 days of spend, Faded ones folded away below.
function HabitsSection({ habits, now }: { habits: Habit[]; now: number }) {
  const p = usePalette();
  const [showFaded, setShowFaded] = useState(false);
  const active = habits.filter(h => h.state === 'active');
  const faded = habits.filter(h => h.state === 'faded');
  if (!habits.length) return null;
  return <View style={{ marginTop: 33 }}>
    <SectionTitle>Habits</SectionTitle>
    <Text style={{ fontFamily: fonts.body, color: p.muted, fontSize: 13, marginTop: 3 }}>Places you keep spending at, from the past year</Text>
    <View style={{ marginTop: 6 }}>{active.map(h => <HabitLine key={h.groupKey} habit={h} now={now} />)}</View>
    {faded.length ? <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showFaded }} onPress={() => setShowFaded(v => !v)} style={{ paddingVertical: 13 }}>
        <Text style={{ fontFamily: fonts.bodyMedium, color: p.muted }}>{showFaded ? '▾' : '▸'} Faded ({faded.length})</Text>
      </Pressable>
      {showFaded ? faded.map(h => <HabitLine key={h.groupKey} habit={h} now={now} />) : null}
    </> : null}
  </View>;
}

function categoryColor(category: string) {
  const colors: Record<string, string> = { 'Food & dining': '#F08A52', Groceries: '#84C06C', Travel: '#6FB1DE', Bills: '#B39AD6', Shopping: '#EC86AE', Health: '#5FCFC0', Entertainment: '#E2C056', Transfers: '#A9A495' };
  return colors[category];
}
