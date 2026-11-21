import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
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
  const unnamed = entries.filter(e => !e.payee.name);
  const named = entries.filter(e => e.payee.name);
  return <Screen><ScreenHead title="Payees and accounts" back />
    <Pressable accessibilityRole="button" onPress={() => router.push('/accounts')} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, backgroundColor: p.surface, borderRadius: 12, marginBottom: 26 }}>
      <View style={{ flex: 1 }}><Body>Your accounts and cards</Body><Caption>{accounts.length} seen in bank SMS · names and card links</Caption></View>
      <Icon name="chevron" color={p.muted} size={17} />
    </Pressable>
    {!entries.length ? <EmptyState title="No payees yet" detail="Payees appear as transactions come in from bank SMS or manual entries." /> : null}
    {unnamed.length ? <><SectionTitle>Unnamed · {unnamed.length}</SectionTitle><Caption style={{ marginTop: 3, marginBottom: 6 }}>Biggest first. A name applies to every past and future transaction.</Caption>{unnamed.map(e => <PayeeLine key={e.payee.id} entry={e} />)}</> : null}
    {named.length ? <View style={{ marginTop: unnamed.length ? 30 : 0 }}><SectionTitle>Named · {named.length}</SectionTitle><View style={{ marginTop: 6 }}>{named.map(e => <PayeeLine key={e.payee.id} entry={e} />)}</View></View> : null}
  </Screen>;
}

function PayeeLine({ entry: e }: { entry: PayeeListEntry }) {
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
}
