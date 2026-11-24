import React, { memo, useMemo } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Body, Caption, EmptyState, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { Icon } from '@/ui/Icon';
import { money } from '@/lib/format';
import { payeeList } from '@/lib/resolve';
import type { PayeeListEntry } from '@/lib/resolve';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { ScheduleBadge } from '@/ui/Schedules';

// Payees list (WF-3): unnamed payees by total spend, then named payees A–Z. One Name
// action covers every row with that payee.
export default function Payees() {
  const p = usePalette();
  const { payees, stats, accounts } = useLedger();
  const entries = useMemo(() => payeeList(payees, stats), [payees, stats]);
  // Unnamed (biggest first), then named A–Z, as one virtualised list with section rows.
  type Item = { key: string; heading?: string; note?: string; entry?: PayeeListEntry };
  const items = useMemo(() => {
    const unnamed = entries.filter(e => !e.payee.name);
    const named = entries.filter(e => e.payee.name);
    const out: Item[] = [];
    if (unnamed.length) out.push({ key: 'h:unnamed', heading: `Unnamed · ${unnamed.length}`, note: 'Biggest first. A name applies to every past and future transaction.' }, ...unnamed.map(entry => ({ key: entry.payee.id, entry })));
    if (named.length) out.push({ key: 'h:named', heading: `Named · ${named.length}` }, ...named.map(entry => ({ key: entry.payee.id, entry })));
    return out;
  }, [entries]);
  const header = <>
    <ScreenHead title="Payees and accounts" back />
    <Pressable accessibilityRole="button" onPress={() => router.push('/accounts')} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, backgroundColor: p.surface, borderRadius: 12, marginBottom: 26 }}>
      <View style={{ flex: 1 }}><Body>Your accounts and cards</Body><Caption>{accounts.length} seen in bank SMS · names and card links</Caption></View>
      <Icon name="chevron" color={p.muted} size={17} />
    </Pressable>
  </>;
  return <Screen scroll={false}>
    <FlatList data={items} keyExtractor={item => item.key} ListHeaderComponent={header}
      ListEmptyComponent={<EmptyState title="No payees yet" detail="Payees appear as transactions come in from bank SMS or manual entries." />}
      renderItem={({ item, index }) => item.entry ? <PayeeLine entry={item.entry} />
        : <View style={{ marginTop: index ? 30 : 0, marginBottom: 6 }}><SectionTitle>{item.heading}</SectionTitle>{item.note ? <Caption style={{ marginTop: 3 }}>{item.note}</Caption> : null}</View>}
      initialNumToRender={20} maxToRenderPerBatch={20} windowSize={9} contentContainerStyle={{ paddingBottom: 28 }} />
  </Screen>;
}

const PayeeLine = memo(function PayeeLine({ entry: e }: { entry: PayeeListEntry }) {
  const p = usePalette();
  const total = e.stats.spentPaise ? `${money(e.stats.spentPaise)} spent` : `${money(e.stats.receivedPaise)} received`;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${e.payee.name ? 'Rename' : 'Name'} ${e.label}`} onPress={() => router.push({ pathname: '/name', params: { kind: 'payee', id: e.payee.id } })}
    style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{e.label}</Text>
      <Caption>{e.stats.count} {e.stats.count === 1 ? 'transaction' : 'transactions'} · {total}{e.payee.category ? ` · ${e.payee.category}` : ''}</Caption>
      <ScheduleBadge payee={e.payee} />
    </View>
    <Text style={{ fontFamily: fonts.bodyMedium, color: e.payee.name ? p.muted : p.review, fontSize: 13 }}>{e.payee.name ? 'Rename' : 'Name'}</Text>
  </Pressable>;
});
