import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Body, Caption, EmptyState, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { accountLabel, debitCardSuggestions, isLive } from '@/lib/resolve';
import type { Account, AccountKind } from '@/lib/model';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';

const kindLabels: Record<AccountKind, string> = {
  bank: 'Bank account', credit_card: 'Credit card', debit_card: 'Debit card', unknown: 'Card or account',
};

// Accounts screen (WF-3): accounts by bank, named here, and the user-confirmed debit
// card link. The link is only ever suggested, never set on its own.
export default function Accounts() {
  const p = usePalette();
  const { accounts, accountsById, transactions, linkDebitCard } = useLedger();
  const suggestions = useMemo(() => debitCardSuggestions(accounts, transactions), [accounts, transactions]);
  const counts = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of transactions) if (t.accountId && isLive(t)) n.set(t.accountId, (n.get(t.accountId) ?? 0) + 1);
    return n;
  }, [transactions]);
  const banks = [...new Set(accounts.map(a => a.bank))].sort();

  async function link(card: Account, bank: Account | null) {
    try { await linkDebitCard(card.id, bank?.id ?? null); }
    catch (e) { showMessage('Could not update the card', e instanceof Error ? e.message : 'Try again.'); }
  }

  return <Screen><ScreenHead title="Accounts" back />
    <Body muted>Accounts and cards seen in your bank SMS. Names show everywhere they appear.</Body>
    {suggestions.map(s => <View key={s.card.id} style={{ marginTop: 18, padding: 15, borderRadius: 12, backgroundColor: p.marigoldSoft, gap: 10 }}>
      <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>••{s.card.last4} looks like a debit card on {accountLabel(s.bank)}</Text>
      <Caption>{s.unmatched} of its {s.cardSpends} spends have no separate message from the bank account.</Caption>
      <View style={{ alignSelf: 'flex-start' }}><Action compact variant="leaf" title="Link" onPress={() => void link(s.card, s.bank)} /></View>
    </View>)}
    {!accounts.length ? <View style={{ marginTop: 22 }}><EmptyState title="No accounts yet" detail="Accounts appear once bank SMS with an account or card number are read." /></View> : null}
    {banks.map(bank => <View key={bank} style={{ marginTop: 28 }}>
      <SectionTitle>{bank}</SectionTitle>
      {accounts.filter(a => a.bank === bank).map(a => {
        const funder = a.fundedBy ? accountsById.get(a.fundedBy) : undefined;
        const n = counts.get(a.id) ?? 0;
        return <View key={a.id} style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${a.name ? 'Rename' : 'Name'} ${accountLabel(a)}`} onPress={() => router.push({ pathname: '/name', params: { kind: 'account', id: a.id } })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{accountLabel(a)}</Text>
              <Caption>{kindLabels[a.kind]} · ••{a.last4} · {n} {n === 1 ? 'transaction' : 'transactions'}</Caption>
            </View>
            <Text style={{ fontFamily: fonts.bodyMedium, color: p.muted, fontSize: 13 }}>{a.name ? 'Rename' : 'Name'}</Text>
          </Pressable>
          {funder ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Caption>Draws on {accountLabel(funder)}</Caption>
            <Pressable accessibilityRole="button" onPress={() => void link(a, null)}><Caption style={{ color: p.review }}>Unlink</Caption></Pressable>
          </View> : null}
        </View>;
      })}
    </View>)}
  </Screen>;
}
