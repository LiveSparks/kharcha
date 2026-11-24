import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, EmptyState, Screen, ScreenHead, SmsSlip } from '@/ui/Kit';
import { DuplicatePairCard, UnparsedCard } from '@/ui/Duplicates';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import type { Transaction, TransactionStatus, UnparsedMessage } from '@/lib/model';
import type { DuplicatePair } from '@/lib/duplicates';
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
  const change = useCallback(async (id: string, status: TransactionStatus) => {
    try { await setTransactionStatus(id, status); }
    catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
  }, [setTransactionStatus]);
  // One virtualised list for every tab: a long review pile renders only what is on screen.
  type Item = { key: string; pair?: DuplicatePair; message?: UnparsedMessage; transaction?: Transaction };
  const data: Item[] = selected === 'duplicates' ? pairs.map(pair => ({ key: pair.flagged.id, pair }))
    : selected === 'unread' ? pending.map(message => ({ key: message.id, message }))
      : visible.map(transaction => ({ key: transaction.id, transaction }));
  const renderItem = useCallback(({ item }: { item: Item }) => item.pair ? <DuplicatePairCard pair={item.pair} />
    : item.message ? <UnparsedCard message={item.message} />
      : <SmsSlip transaction={item.transaction!} actions={<View style={{ flexDirection: 'row', gap: 7 }}>
        {selected !== 'ignored' ? <View style={{ flex: 1 }}><Action compact title="Not a spend" variant="ghost" onPress={() => void change(item.transaction!.id, 'ignored')} /></View> : null}
        <View style={{ flex: 1 }}><Action compact title="Fix" variant="secondary" onPress={() => router.push({ pathname: '/transaction/[id]', params: { id: item.transaction!.id } })} /></View>
        {selected !== 'auto' ? <View style={{ flex: 1 }}><Action compact title="Looks right" variant="leaf" onPress={() => void change(item.transaction!.id, 'auto')} /></View> : null}
      </View>} />, [selected, change]);
  const header = <View style={{ marginBottom: 16 }}>
    <ScreenHead title="Needs your eye" action={{ icon: 'plus', label: 'Add a transaction', onPress: () => router.push('/manual') }} />
    <Body muted>Kharcha keeps the original bank message beside what it understood. You have the last word.</Body>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 22, flexGrow: 0 }} contentContainerStyle={{ padding: 4, backgroundColor: p.sunk, borderRadius: 12, gap: 3 }}>
      {TABS.map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: selected === value }} onPress={() => setSelected(value)} style={{ alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: selected === value ? p.surface : 'transparent', borderRadius: 9 }}><Text style={{ fontFamily: selected === value ? fonts.bodyMedium : fonts.body, color: selected === value ? p.ink : p.muted, fontSize: 12 }}>{titles[value]}</Text></Pressable>)}
    </ScrollView>
  </View>;
  return <Screen scroll={false}>
    <FlatList data={data} keyExtractor={item => item.key} renderItem={renderItem} ListHeaderComponent={header}
      ListEmptyComponent={<EmptyState title={empty[selected].title} detail={empty[selected].detail} />}
      ItemSeparatorComponent={Gap} initialNumToRender={6} maxToRenderPerBatch={6} windowSize={7}
      contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled" />
  </Screen>;
}

function Gap() { return <View style={{ height: 15 }} />; }
