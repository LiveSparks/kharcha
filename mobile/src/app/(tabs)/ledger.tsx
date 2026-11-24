import React, { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Caption, CategoryDot, EmptyState, Screen, ScreenHead } from '@/ui/Kit';
import { Icon } from '@/ui/Icon';
import { PickerSheet } from '@/ui/Sheet';
import { fonts, usePalette } from '@/ui/theme';
import type { Palette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import type { Category, Direction } from '@/lib/model';
import { accountLabel } from '@/lib/resolve';
import { dateLabel, money, signedMoney } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { NO_FILTER, PERIODS, activeFilters, groupByDay, ledgerEntries, totals } from '@/lib/ledgerView';
import type { LedgerEntry, LedgerFilter, LedgerItem, Period } from '@/lib/ledgerView';

// The Ledger tab: every transaction in the books as a dense list (no SMS text), newest
// first and grouped by day, with search and filters. Tapping a row opens its details.

type Sheet = 'period' | 'account' | 'category' | 'direction' | null;

export default function Ledger() {
  const p = usePalette();
  const now = useNow();
  const { transactions, payeesById, accountsById, accounts, categories } = useLedger();
  const [filter, setFilter] = useState<LedgerFilter>(NO_FILTER);
  const [sheet, setSheet] = useState<Sheet>(null);
  const entries = useMemo(() => ledgerEntries(transactions, payeesById, accountsById, filter, now),
    [transactions, payeesById, accountsById, filter, now]);
  const items = useMemo(() => groupByDay(entries), [entries]);
  const sticky = useMemo(() => items.flatMap((item, index) => item.type === 'day' ? [index] : []), [items]);
  const sum = useMemo(() => totals(entries), [entries]);
  const set = useCallback((patch: Partial<LedgerFilter>) => { setFilter(f => ({ ...f, ...patch })); setSheet(null); }, []);
  const filtered = activeFilters(filter) > 0 || !!filter.query.trim();

  const account = filter.accountId ? accountsById.get(filter.accountId) : undefined;
  const chips: { key: Exclude<Sheet, null> | 'review'; label: string; on: boolean }[] = [
    { key: 'period', label: PERIODS.find(x => x.value === filter.period)!.label, on: filter.period !== 'all' },
    { key: 'account', label: account ? accountLabel(account) : 'Account', on: !!account },
    { key: 'category', label: filter.category ?? 'Category', on: !!filter.category },
    { key: 'direction', label: filter.direction === 'debit' ? 'Spent' : filter.direction === 'credit' ? 'Received' : 'In and out', on: !!filter.direction },
    { key: 'review', label: 'Needs review', on: filter.reviewOnly },
  ];

  const renderItem = useCallback(({ item }: { item: LedgerItem }) => item.type === 'day'
    ? <DayHeader at={item.at} outPaise={item.outPaise} inPaise={item.inPaise} p={p} />
    : <LedgerRow entry={item.entry} p={p} />, [p]);

  return <Screen scroll={false}>
    <ScreenHead title="Ledger" action={{ icon: 'plus', label: 'Add a transaction', onPress: () => router.push('/manual') }} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 46, borderRadius: 11, borderWidth: 1, borderColor: p.strongLine, backgroundColor: p.surface }}>
      <Icon name="search" color={p.muted} size={18} />
      <TextInput accessibilityLabel="Search the ledger" value={filter.query} onChangeText={query => setFilter(f => ({ ...f, query }))}
        placeholder="Payee, category, account or amount" placeholderTextColor={p.muted} selectionColor={p.focus} autoCapitalize="none" autoCorrect={false}
        returnKeyType="search" style={{ flex: 1, color: p.ink, fontFamily: fonts.body, fontSize: 15, paddingVertical: 10 }} />
      {filter.query ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setFilter(f => ({ ...f, query: '' }))} hitSlop={10}><Icon name="close" color={p.muted} size={16} /></Pressable> : null}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, marginTop: 10 }} contentContainerStyle={{ gap: 7, paddingRight: 8 }}>
      {chips.map(c => <Pressable key={c.key} accessibilityRole="button" accessibilityState={{ selected: c.on }}
        onPress={() => c.key === 'review' ? setFilter(f => ({ ...f, reviewOnly: !f.reviewOnly })) : setSheet(c.key)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 12, borderRadius: 17,
          backgroundColor: c.on ? p.leaf : p.surface, borderWidth: c.on ? 0 : 1, borderColor: p.line }}>
        <Text numberOfLines={1} style={{ maxWidth: 160, fontFamily: fonts.bodyMedium, fontSize: 13, color: c.on ? p.onLeaf : p.ink }}>{c.label}</Text>
        {c.key !== 'review' ? <Text style={{ fontSize: 10, color: c.on ? p.onLeaf : p.muted }}>▾</Text> : null}
      </Pressable>)}
      {filtered ? <Pressable accessibilityRole="button" onPress={() => setFilter(NO_FILTER)} style={{ justifyContent: 'center', paddingHorizontal: 8 }}>
        <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: p.review }}>Clear all</Text>
      </Pressable> : null}
    </ScrollView>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, paddingVertical: 10 }}>
      <Caption>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</Caption>
      <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 12, color: p.muted }}>
        <Text style={{ color: p.debit }}>{signedMoney(rounded(sum.outPaise), 'debit')}</Text>  <Text style={{ color: p.credit }}>{signedMoney(rounded(sum.inPaise), 'credit')}</Text>
      </Text>
    </View>
    {items.length ? <FlatList data={items} keyExtractor={item => item.key} renderItem={renderItem} stickyHeaderIndices={sticky}
      initialNumToRender={24} maxToRenderPerBatch={24} windowSize={9} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: 28 }} style={{ flex: 1, marginHorizontal: -16 }} />
      : <EmptyState title={filtered ? 'Nothing matches' : 'No transactions yet'} detail={filtered ? 'Try a shorter search or clear a filter.' : 'Transactions from bank SMS and the ones you add appear here.'} />}

    <PickerSheet open={sheet === 'period'} title="Period" onClose={() => setSheet(null)}
      options={PERIODS.map(x => ({ key: x.value, label: x.label, on: filter.period === x.value, pick: () => set({ period: x.value as Period }) }))} />
    <PickerSheet open={sheet === 'account'} title="Account" onClose={() => setSheet(null)}
      options={[{ key: 'any', label: 'All accounts', on: !filter.accountId, pick: () => set({ accountId: null }) },
        ...accounts.filter(a => a.mine !== false).map(a => ({ key: a.id, label: accountLabel(a), on: filter.accountId === a.id, pick: () => set({ accountId: a.id }) }))]} />
    <PickerSheet open={sheet === 'category'} title="Category" onClose={() => setSheet(null)}
      options={[{ key: 'any', label: 'All categories', on: !filter.category, pick: () => set({ category: null }) },
        ...categories.map(({ name: c }) => ({ key: c, label: c, dot: c, on: filter.category === c, pick: () => set({ category: c }) }))]} />
    <PickerSheet open={sheet === 'direction'} title="Money" onClose={() => setSheet(null)}
      options={([[null, 'In and out'], ['debit', 'Spent'], ['credit', 'Received']] as [Direction | null, string][]).map(([d, label]) =>
        ({ key: d ?? 'any', label, on: filter.direction === d, pick: () => set({ direction: d }) }))} />
  </Screen>;
}

// Whole rupees for the summary line, so large totals fit.
function rounded(paise: number): number { return Math.round(paise / 100) * 100; }

const DayHeader = memo(function DayHeader({ at, outPaise, inPaise, p }: { at: number; outPaise: number; inPaise: number; p: Palette }) {
  return <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6, backgroundColor: p.sunk }}>
    <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 12, color: p.muted }}>{dateLabel(at)}</Text>
    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.muted }}>{outPaise ? signedMoney(outPaise, 'debit') : ''}{outPaise && inPaise ? '  ' : ''}{inPaise ? signedMoney(inPaise, 'credit') : ''}</Text>
  </View>;
});

const LedgerRow = memo(function LedgerRow({ entry, p }: { entry: LedgerEntry; p: Palette }) {
  const t = entry.transaction;
  const review = t.status === 'review';
  return <Pressable onPress={() => router.push({ pathname: '/transaction/[id]', params: { id: t.id } })}
    accessibilityRole="button" accessibilityLabel={`${entry.label}, ${t.direction === 'debit' ? 'spent' : 'received'} ${money(t.amountPaise)}, ${entry.category}${entry.account ? `, ${entry.account}` : ''}${review ? ', needs review' : ''}`}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9, minHeight: 54,
      backgroundColor: pressed ? p.surface : p.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line })}>
    {review ? <View style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 4, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: p.marigold }} /> : null}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, fontSize: 14, color: p.ink }}>{entry.label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
        <CategoryDot category={entry.category} size={7} />
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.body, fontSize: 12, color: p.muted }}>{entry.category}{entry.account ? ` · ${entry.account}` : ''}{t.status === 'manual' ? ' · added by you' : ''}</Text>
      </View>
    </View>
    <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: t.direction === 'debit' ? p.debit : p.credit }}>{signedMoney(t.amountPaise, t.direction, t.amountPaise % 100 !== 0)}</Text>
  </Pressable>;
});
