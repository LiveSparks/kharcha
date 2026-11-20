import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, Label, Screen, ScreenHead, SmsSlip } from '@/ui/Kit';
import { CategoryPicker } from '@/ui/Forms';
import { Icon } from '@/ui/Icon';
import { dateLabel, signedMoney } from '@/lib/format';
import { accountLabel, payeeLabel } from '@/lib/resolve';
import type { Category, Transaction, TransactionStatus } from '@/lib/model';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';

function TransactionSummary({ transaction: t }: { transaction: Transaction }) {
  const p = usePalette();
  const source = t.status === 'manual' ? 'Added by you' : `from ${t.sender ?? 'SMS'}`;
  return <View style={{ marginTop: 5, marginBottom: 22 }}>
    <Text style={{ fontFamily: fonts.mono, fontSize: 33, color: t.direction === 'debit' ? p.debit : p.credit }}>
      {signedMoney(t.amountPaise, t.direction, true)}
    </Text>
    <Caption style={{ marginTop: 5 }}>{dateLabel(t.occurredAt)} · {source}</Caption>
  </View>;
}

const statusLabels: Record<TransactionStatus, string> = {
  review: 'Needs review', duplicate_review: 'Possible duplicate', ignored: 'Ignored', manual: 'Manual', auto: 'In ledger',
};

// The Payee row (WF-3): the effective payee's label with Name / Rename, and the
// per-row "Move this one" escape hatch below it.
function PayeeRow({ transaction: t }: { transaction: Transaction }) {
  const p = usePalette();
  const { payeeOf } = useLedger();
  const payee = payeeOf(t);
  return <View style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, gap: 12, marginBottom: 22 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Caption>{t.direction === 'debit' ? 'Paid to' : 'Received from'}</Caption>
        <Label style={{ fontSize: 16, marginTop: 2 }}><Text numberOfLines={2}>{payee ? payeeLabel(payee) : t.merchant}</Text></Label>
        {payee?.name ? <Caption numberOfLines={1}>{payee.kind === 'masked' ? `a/c ${payee.masked ?? ''}` : payee.masked ?? payee.key}</Caption> : null}
      </View>
      {payee ? <Action compact variant="secondary" title={payee.name ? 'Rename' : 'Name'} onPress={() => router.push({ pathname: '/name', params: { kind: 'payee', id: payee.id } })} /> : null}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Wrong payee? Move this one" onPress={() => router.push({ pathname: '/move', params: { id: t.id } })}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: p.line, paddingTop: 12 }}>
      <Caption>{t.payeeOverrideId ? 'Moved by you · change' : 'Wrong payee? Move this one'}</Caption>
      <Icon name="chevron" color={p.muted} size={15} />
    </Pressable>
  </View>;
}

function TransactionFacts({ transaction: t }: { transaction: Transaction }) {
  const p = usePalette();
  const { accountOf } = useLedger();
  const account = accountOf(t);
  return <View style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, gap: 13, marginBottom: 28 }}>
    <Pressable accessibilityRole="button" disabled={!account} onPress={() => router.push('/accounts')} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Caption>{t.direction === 'debit' ? 'Paid from' : 'Into'}</Caption>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Body>{account ? accountLabel(account) : t.accountLast4 ? `Account ··${t.accountLast4}` : 'Not in source'}</Body>
        {account ? <Icon name="chevron" color={p.muted} size={15} /> : null}
      </View>
    </Pressable>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Caption>Reference</Caption><Body>{t.reference ?? 'Not in source'}</Body></View>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Caption>Current state</Caption><Body>{statusLabels[t.status]}</Body></View>
  </View>;
}

function TransactionActions({ transaction, busy, onSave }: { transaction: Transaction; busy: boolean; onSave: (status: TransactionStatus) => void }) {
  return <View style={{ gap: 9, paddingBottom: 15 }}>
    <Action title={busy ? 'Saving…' : 'Save and include'} disabled={busy} onPress={() => onSave(transaction.status === 'manual' ? 'manual' : 'auto')} />
    {transaction.status !== 'ignored' ? <Action title="Ignore this message" variant="ghost" disabled={busy} onPress={() => onSave('ignored')} /> : null}
  </View>;
}

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, categoryOf, setTransactionStatus, setTransactionCategory } = useLedger();
  const t = transactions.find(item => item.id === id);
  const shown = t ? categoryOf(t) : 'Transfers';
  const [picked, setPicked] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  if (!t) return <Screen><ScreenHead title="Entry not found" back /><Body muted>This entry may have been removed when a backup was restored.</Body></Screen>;
  const category = picked ?? shown;
  async function save(status: TransactionStatus) {
    if (!t) return;
    setBusy(true);
    try {
      // Only a category the user actually changed becomes a per-row choice; otherwise
      // the row keeps following its payee's default.
      if (picked && picked !== shown) await setTransactionCategory(t.id, picked);
      if (status !== t.status) await setTransactionStatus(t.id, status);
      router.back();
    }
    catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }
  return <Screen><ScreenHead title="The whole story" back />
    <TransactionSummary transaction={t} />
    <PayeeRow transaction={t} />
    <View style={{ marginBottom: 28 }}><CategoryPicker value={category} onChange={setPicked} /></View>
    <TransactionFacts transaction={t} />
    {t.rawBody ? <View style={{ marginBottom: 24 }}><SmsSlip transaction={t} /></View> : null}
    <TransactionActions transaction={t} busy={busy} onSave={status => void save(status)} />
  </Screen>;
}
