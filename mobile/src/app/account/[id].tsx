import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, EmptyState, Label, Screen, ScreenHead, SectionTitle, TransactionRow } from '@/ui/Kit';
import { Field } from '@/ui/Forms';
import { AsOf, Figure, figureText, figureTitle } from '@/ui/Balances';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { accountHistory, balanceRows } from '@/lib/balances';
import type { GapRow } from '@/lib/balances';
import { accountLabel, isLive } from '@/lib/resolve';
import { dateLabel, signedMoney } from '@/lib/format';
import { showMessage } from '@/ui/dialog';

// Account history (P3, WF-4): the account's figure, the one-time opening balance or the
// card's credit limit, and its rows with "Unexplained difference" rows interleaved.
// Tapping a difference logs the missing transaction on this account, which closes it.

function toPaise(text: string): number | null {
  const clean = text.replace(/[,\s₹]/g, '');
  if (!clean) return null;
  const value = Number(clean);
  if (!Number.isFinite(value)) throw new Error('Enter an amount in rupees.');
  return Math.round(value * 100);
}

function GapItem({ gap }: { gap: GapRow }) {
  const p = usePalette();
  const open = () => router.push({ pathname: '/manual', params: {
    accountId: gap.accountId, gapPaise: String(gap.amountPaise), gapDirection: gap.direction, gapAt: String(gap.occurredAt - 1000),
  } });
  return <Pressable accessibilityRole="button" accessibilityLabel={`Unexplained difference ${signedMoney(gap.amountPaise, gap.direction, true)}. Log what it was.`} onPress={open}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, marginVertical: 4, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: p.review }}>
    <View style={{ flex: 1 }}>
      <Label>Unexplained difference</Label>
      <Caption>Before {dateLabel(gap.occurredAt)} · no SMS explains it. Tap to log what it was.</Caption>
    </View>
    <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: p.review }}>{signedMoney(gap.amountPaise, gap.direction, true)}</Text>
  </Pressable>;
}

export default function AccountScreen() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { accounts, accountsById, transactions, balances, setOpeningBalance, setCreditLimit } = useLedger();
  const account = id ? accountsById.get(id) : undefined;
  const balance = id ? balances.get(id) : undefined;
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const items = useMemo(() => {
    if (!account || !balance) return [];
    const rows = account.kind === 'debit_card'
      ? transactions.filter(t => t.accountId === account.id && isLive(t))
      : balanceRows(account.id, transactions, accounts);
    return accountHistory(rows, balance.gaps);
  }, [account, balance, transactions, accounts]);
  if (!account || !balance) return <Screen><ScreenHead title="Account" back /><EmptyState title="Account not found" detail="It may have been removed by a restore." /></Screen>;

  const funder = account.fundedBy ? accountsById.get(account.fundedBy) : undefined;
  const takesOpening = account.kind === 'bank' && (balance.needsOpening || (account.openingBalancePaise !== null && balance.anchors === 0));
  const takesLimit = account.kind === 'credit_card';
  async function save(clear = false) {
    setSaving(true);
    try {
      const paise = clear ? null : toPaise(amount);
      if (!clear && paise === null) throw new Error('Enter an amount in rupees.');
      if (takesLimit) await setCreditLimit(account!.id, paise);
      else await setOpeningBalance(account!.id, paise);
      setAmount('');
    } catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
    finally { setSaving(false); }
  }

  const header = <>
    <ScreenHead title={accountLabel(account)} back />
    <View style={{ backgroundColor: p.surface, borderRadius: 16, padding: 16, gap: 6 }}>
      {balance.amountPaise !== null ? <>
        <Caption>{figureTitle(balance)}</Caption>
        <Figure balance={balance} size={30} />
        <AsOf balance={balance} />
        {balance.gaps.length ? <Caption>{balance.gaps.length} unexplained {balance.gaps.length === 1 ? 'difference' : 'differences'} below</Caption> : null}
      </> : account.kind === 'debit_card'
        ? <Body muted>{funder ? `Its spends and balance messages count toward ${accountLabel(funder)}.` : 'A debit card has no balance of its own. Link it to its bank account on Accounts and its balance messages count there.'}</Body>
        : account.kind === 'unknown'
          ? <Body muted>{"Kharcha can't tell what kind of account this is yet, so it shows no balance."}</Body>
          : <Body muted>{account.kind === 'credit_card' ? 'No message from this card has stated its available limit yet.' : 'This account has never stated its balance in an SMS.'}</Body>}
    </View>

    {takesOpening ? <View style={{ marginTop: 18, gap: 10 }}>
      <Body>{account.openingBalancePaise !== null ? `Opening balance ${figureText(account.openingBalancePaise)}, counted from ${dateLabel(account.openingBalanceAt!)}.` : 'Set an opening balance once and Kharcha counts from today. A later balance SMS takes over from it.'}</Body>
      <Field label="Opening balance in rupees" value={amount} onChangeText={setAmount} numeric placeholder="0.00" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Action compact title={saving ? 'Saving…' : 'Set opening balance'} disabled={saving || !amount.trim()} onPress={() => void save()} /></View>
        {account.openingBalancePaise !== null ? <View style={{ flex: 1 }}><Action compact variant="ghost" title="Clear" disabled={saving} onPress={() => void save(true)} /></View> : null}
      </View>
    </View> : null}

    {takesLimit ? <View style={{ marginTop: 18, gap: 10 }}>
      <Body>{account.creditLimitPaise !== null ? `Credit limit ${figureText(account.creditLimitPaise)}.` : 'Enter the card\'s credit limit once to see what you owe on it.'}</Body>
      <Field label="Credit limit in rupees" value={amount} onChangeText={setAmount} numeric placeholder="0" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Action compact title={saving ? 'Saving…' : 'Set credit limit'} disabled={saving || !amount.trim()} onPress={() => void save()} /></View>
        {account.creditLimitPaise !== null ? <View style={{ flex: 1 }}><Action compact variant="ghost" title="Clear" disabled={saving} onPress={() => void save(true)} /></View> : null}
      </View>
    </View> : null}

    <View style={{ marginTop: 28, marginBottom: 8 }}><SectionTitle>History</SectionTitle></View>
  </>;
  const said = (t: (typeof items)[number]) => t.type === 'gap' ? null
    : t.transaction.reportedBalancePaise !== null && account.kind !== 'credit_card' ? `Bank said balance ${figureText(t.transaction.reportedBalancePaise)}`
      : t.transaction.reportedAvlLimitPaise !== null && account.kind === 'credit_card' ? `Bank said available ${figureText(t.transaction.reportedAvlLimitPaise)}` : null;
  return <Screen scroll={false}>
    <FlatList data={items} keyExtractor={item => item.type === 'gap' ? item.gap.id : item.transaction.id} ListHeaderComponent={header}
      ListEmptyComponent={<EmptyState title="No transactions yet" detail="Transactions on this account appear here." />}
      renderItem={({ item }) => item.type === 'gap' ? <GapItem gap={item.gap} /> : <View>
        <TransactionRow transaction={item.transaction} />
        {said(item) ? <Caption style={{ marginTop: -6, marginBottom: 6, textAlign: 'right' }}>{said(item)}</Caption> : null}
      </View>}
      initialNumToRender={15} maxToRenderPerBatch={15} windowSize={9} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 28 }} />
  </Screen>;
}
