import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Caption, SectionTitle } from './Kit';
import { Figure, figureTitle } from './Balances';
import { fonts, usePalette } from './theme';
import { useLedger } from '@/state/LedgerProvider';
import { accountLabel, isLive, isOwnTransfer } from '@/lib/resolve';
import { signedMoney } from '@/lib/format';
import { accountCardSummaries } from '@/lib/accountCards';

// Home: one card per account you track (yours, then undecided), with its balance and this
// month's money in and out. A card opens the account's history. While some accounts are
// undecided, a line asks which are yours.
export function AccountCards({ now }: { now: number }) {
  const p = usePalette();
  const { accounts, transactions, balances } = useLedger();
  const cards = useMemo(() => accountCardSummaries(accounts, transactions.filter(t => isLive(t) && !isOwnTransfer(t)), now), [accounts, transactions, now]);
  const undecided = accounts.filter(a => a.mine === null).length;
  if (!cards.length) return null;
  return <View style={{ marginTop: 6, marginBottom: 22 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <SectionTitle>Accounts</SectionTitle>
      <Pressable accessibilityRole="button" accessibilityLabel="Open accounts" onPress={() => router.push('/accounts')} hitSlop={8}>
        <Caption style={{ color: undecided ? p.review : p.muted }}>{undecided ? `${undecided} to sort ›` : 'All ›'}</Caption>
      </Pressable>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 16 }} style={{ marginHorizontal: -16 }}>
      <View style={{ width: 6 }} />
      {cards.map(c => {
        const b = balances.get(c.account.id);
        return <Pressable key={c.account.id} accessibilityRole="button" accessibilityLabel={`Open ${accountLabel(c.account)}`}
          onPress={() => router.push({ pathname: '/account/[id]', params: { id: c.account.id } })}
          style={({ pressed }) => ({ width: 210, padding: 14, borderRadius: 16, backgroundColor: pressed ? p.sunk : p.surface, borderWidth: 1, borderColor: c.account.mine === null ? p.marigold : p.line, gap: 6 })}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, fontSize: 15, color: p.ink }}>{accountLabel(c.account)}</Text>
          <Caption numberOfLines={1}>{c.account.name ? `${c.account.bank} ••${c.account.last4}` : c.account.mine === null ? 'Is this yours?' : ' '}</Caption>
          <View style={{ minHeight: 24, justifyContent: 'center' }}>
            {b && b.amountPaise !== null ? <Figure balance={b} size={18} /> : <Caption>No balance yet</Caption>}
          </View>
          {b && b.amountPaise !== null ? <Caption numberOfLines={1}>{figureTitle(b)}</Caption> : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: p.debit }}>{signedMoney(c.outPaise, 'debit')}</Text>
            <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: p.credit }}>{signedMoney(c.inPaise, 'credit')}</Text>
          </View>
          <Caption>this month · {c.count} {c.count === 1 ? 'entry' : 'entries'}</Caption>
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}
