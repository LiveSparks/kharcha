import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Body, Caption, EmptyState, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { accountLabel, debitCardSuggestions, isLive } from '@/lib/resolve';
import type { Account, AccountKind } from '@/lib/model';
import { fonts, usePalette } from '@/ui/theme';
import { AsOf, Figure, figureTitle } from '@/ui/Balances';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';

const kindLabels: Record<AccountKind, string> = {
  bank: 'Bank account', credit_card: 'Credit card', debit_card: 'Debit card', unknown: 'Card or account',
};

// Accounts screen (WF-3, WF-4): accounts by bank with their balance or card outstanding,
// named here, and the user-confirmed debit card link (only ever suggested, never set on
// its own). A row opens the account's history.
export default function Accounts() {
  const p = usePalette();
  const { accounts, accountsById, transactions, allTransactions, balances, linkDebitCard } = useLedger();
  const suggestions = useMemo(() => debitCardSuggestions(accounts, transactions), [accounts, transactions]);
  const counts = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of allTransactions) if (t.accountId && isLive(t)) n.set(t.accountId, (n.get(t.accountId) ?? 0) + 1);
    return n;
  }, [allTransactions]);
  // Yours first, then the ones to decide, then the ones you don't track (v10).
  const groups: [string, string, Account[]][] = [
    ['Yours', '', accounts.filter(a => a.mine === true)],
    ['Is this yours?', 'Counted until you decide. Tap Edit to say.', accounts.filter(a => a.mine === null)],
    ['Not tracked', 'Their messages are left out of your ledger.', accounts.filter(a => a.mine === false)],
  ];

  async function link(card: Account, bank: Account | null) {
    try { await linkDebitCard(card.id, bank?.id ?? null); }
    catch (e) { showMessage('Could not update the card', e instanceof Error ? e.message : 'Try again.'); }
  }

  return <Screen><ScreenHead title="Accounts" back />
    <Body muted>Accounts and cards seen in your bank SMS. Mark which are yours: only their messages count.</Body>
    {suggestions.map(s => <View key={s.card.id} style={{ marginTop: 18, padding: 15, borderRadius: 12, backgroundColor: p.marigoldSoft, gap: 10 }}>
      <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>••{s.card.last4} looks like a debit card on {accountLabel(s.bank)}</Text>
      <Caption>{s.unmatched} of its {s.cardSpends} spends have no separate message from the bank account.</Caption>
      <View style={{ alignSelf: 'flex-start' }}><Action compact variant="leaf" title="Link" onPress={() => void link(s.card, s.bank)} /></View>
    </View>)}
    {!accounts.length ? <View style={{ marginTop: 22 }}><EmptyState title="No accounts yet" detail="Accounts appear once bank SMS with an account or card number are read." /></View> : null}
    {groups.filter(([, , list]) => list.length).map(([title, note, list]) => <View key={title} style={{ marginTop: 28 }}>
      <SectionTitle>{title} · {list.length}</SectionTitle>
      {note ? <Caption style={{ marginTop: 2 }}>{note}</Caption> : null}
      {list.map(a => {
        const funder = a.fundedBy ? accountsById.get(a.fundedBy) : undefined;
        const n = counts.get(a.id) ?? 0;
        const b = balances.get(a.id);
        const prompt = b?.needsOpening ? 'Set opening balance ›' : b?.needsLimit ? 'Set credit limit ›' : null;
        return <View key={a.id} style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${accountLabel(a)}`} onPress={() => router.push({ pathname: '/account/[id]', params: { id: a.id } })} style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.bodyMedium, color: p.ink }}>{accountLabel(a)}</Text>
                {b && b.amountPaise !== null ? <Figure balance={b} /> : null}
              </View>
              <Caption>{a.name ? `${a.bank} ` : ''}{kindLabels[a.kind]} · ••{a.last4} · {n} {n === 1 ? 'transaction' : 'transactions'}{b && b.amountPaise !== null ? ` · ${figureTitle(b).toLowerCase()}` : ''}</Caption>
              {b && b.amountPaise !== null ? <AsOf balance={b} /> : null}
              {prompt ? <Caption style={{ color: p.review }}>{prompt}</Caption> : null}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${accountLabel(a)}`} onPress={() => router.push({ pathname: '/name', params: { kind: 'account', id: a.id } })} hitSlop={8}>
              <Text style={{ fontFamily: fonts.bodyMedium, color: a.mine === null ? p.review : p.muted, fontSize: 13 }}>Edit</Text>
            </Pressable>
          </View>
          {funder ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Caption>Draws on {accountLabel(funder)}</Caption>
            <Pressable accessibilityRole="button" onPress={() => void link(a, null)}><Caption style={{ color: p.review }}>Unlink</Caption></Pressable>
          </View> : null}
        </View>;
      })}
    </View>)}
  </Screen>;
}
