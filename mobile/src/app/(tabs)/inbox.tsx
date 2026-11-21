import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, EmptyState, Screen, ScreenHead, SmsSlip } from '@/ui/Kit';
import { DuplicatePairCard, UnparsedCard } from '@/ui/Duplicates';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import type { TransactionStatus } from '@/lib/model';
import { showMessage } from '@/ui/dialog';

type Tab = 'review' | 'auto' | 'ignored' | 'duplicates' | 'unread';
const TABS: readonly Tab[] = ['review', 'duplicates', 'unread', 'auto', 'ignored'];

const empty: Record<Tab, { title: string; detail: string }> = {
  review: { title: 'All caught up', detail: 'New messages that need a closer look will land here.' },
  auto: { title: 'Nothing here yet', detail: 'Bank messages will appear after an Android scan.' },
  ignored: { title: 'Nothing here yet', detail: 'Messages you ignore stay here, with their original text.' },
  duplicates: { title: 'No duplicates to check', detail: 'When one payment is notified twice, both messages show up here so you can merge them.' },
  unread: { title: 'Nothing unread', detail: "Bank messages that mention an amount but that Kharcha couldn't read land here." },
};

export default function Inbox() {
  const p = usePalette();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const { transactions, pairs, unparsed, setTransactionStatus } = useLedger();
  const [selected, setSelected] = useState<Tab>('review');
  // A link may ask for a tab (Home's duplicate card); follow it once per change.
  const [linked, setLinked] = useState<string | undefined>(undefined);
  if (tab !== linked) {
    setLinked(tab);
    if (tab && (TABS as readonly string[]).includes(tab)) setSelected(tab as Tab);
  }
  const pending = unparsed.filter(m => m.status === 'pending');
  const titles: Record<Tab, string> = {
    review: 'To review', auto: 'In ledger', ignored: 'Ignored',
    duplicates: `Duplicates · ${pairs.length}`, unread: `Couldn't read · ${pending.length}`,
  };
  const visible = selected === 'review' || selected === 'auto' || selected === 'ignored'
    ? transactions.filter(t => t.status === selected && t.rawBody) : [];
  async function change(id: string, status: TransactionStatus) {
    try { await setTransactionStatus(id, status); }
    catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
  }
  const count = selected === 'duplicates' ? pairs.length : selected === 'unread' ? pending.length : visible.length;
  return <Screen>
    <ScreenHead title="Needs your eye" action={{ icon: 'plus', label: 'Add a transaction', onPress: () => router.push('/manual') }} />
    <Body muted>Kharcha keeps the original bank message beside what it understood. You have the last word.</Body>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 22, flexGrow: 0 }} contentContainerStyle={{ padding: 4, backgroundColor: p.sunk, borderRadius: 12, gap: 3 }}>
      {TABS.map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: selected === value }} onPress={() => setSelected(value)} style={{ alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: selected === value ? p.surface : 'transparent', borderRadius: 9 }}><Text style={{ fontFamily: selected === value ? fonts.bodyMedium : fonts.body, color: selected === value ? p.ink : p.muted, fontSize: 12 }}>{titles[value]}</Text></Pressable>)}
    </ScrollView>
    <View style={{ marginTop: 16, gap: 15 }}>
      {!count ? <EmptyState title={empty[selected].title} detail={empty[selected].detail} />
        : selected === 'duplicates' ? pairs.map(pair => <DuplicatePairCard key={pair.flagged.id} pair={pair} />)
          : selected === 'unread' ? pending.map(m => <UnparsedCard key={m.id} message={m} />)
            : visible.map(t => <SmsSlip key={t.id} transaction={t} actions={<View style={{ flexDirection: 'row', gap: 7 }}>
              {selected !== 'ignored' ? <View style={{ flex: 1 }}><Action compact title="Not a spend" variant="ghost" onPress={() => void change(t.id, 'ignored')} /></View> : null}
              <View style={{ flex: 1 }}><Action compact title="Fix" variant="secondary" onPress={() => router.push({ pathname: '/transaction/[id]', params: { id: t.id } })} /></View>
              {selected !== 'auto' ? <View style={{ flex: 1 }}><Action compact title="Looks right" variant="leaf" onPress={() => void change(t.id, 'auto')} /></View> : null}
            </View>} />)}
    </View>
  </Screen>;
}
