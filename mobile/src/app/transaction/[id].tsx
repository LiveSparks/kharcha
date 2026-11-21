import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, Label, Screen, ScreenHead, SmsSlip } from '@/ui/Kit';
import { CategoryPicker } from '@/ui/Forms';
import { Icon } from '@/ui/Icon';
import { dateLabel, signedMoney } from '@/lib/format';
import { accountLabel, payeeLabel } from '@/lib/resolve';
import { gapLabel, mergedCopies } from '@/lib/duplicates';
import { DuplicateActions } from '@/ui/Duplicates';
import type { Category, Transaction, TransactionStatus } from '@/lib/model';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';
import { ScheduleBadge } from '@/ui/Schedules';
import { scheduleFor } from '@/lib/schedules';

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
  merged: 'Merged copy',
};

function open(id: string) { router.push({ pathname: '/transaction/[id]', params: { id } }); }

// Duplicate review on the detail screen (WF-5): a pending pair offers the same three
// actions as the Inbox, a merged copy offers Unmerge, and a survivor links its copies.
function DuplicatePanel({ transaction: t }: { transaction: Transaction }) {
  const p = usePalette();
  const { pairs, transactions, labelOf, unmerge } = useLedger();
  const [busy, setBusy] = useState(false);
  const pair = pairs.find(x => x.flagged.id === t.id || x.partner.id === t.id);
  const copies = mergedCopies(t.id, transactions);
  const survivor = t.status === 'merged' && t.duplicateOf ? transactions.find(x => x.id === t.duplicateOf) : undefined;
  if (!pair && !copies.length && !survivor) return null;
  const box = { backgroundColor: p.surface, borderRadius: 12, padding: 15, gap: 12, marginBottom: 22, borderWidth: 1, borderColor: pair ? p.marigold : p.line };
  // A merged copy shows only where it went; a kept row shows any pair still waiting
  // on it and, below, the copies already merged into it.
  if (survivor) {
    async function undo() {
      setBusy(true);
      try { await unmerge(t.id); } catch (e) { showMessage('Could not unmerge', e instanceof Error ? e.message : 'Try again.'); } finally { setBusy(false); }
    }
    return <View style={box}>
      <Pressable accessibilityRole="button" onPress={() => open(survivor.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}><Label>Merged into {labelOf(survivor)}</Label><Caption>Not counted in totals. Kept here with its original message.</Caption></View>
        <Icon name="chevron" color={p.muted} size={15} />
      </Pressable>
      <Action compact variant="secondary" title={busy ? 'Unmerging…' : 'Unmerge'} disabled={busy} onPress={() => void undo()} />
    </View>;
  }
  const other = pair ? (pair.flagged.id === t.id ? pair.partner : pair.flagged) : null;
  return <View style={box}>
    {pair && other ? <>
      <Pressable accessibilityRole="button" onPress={() => open(other.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Label>Possible duplicate of {labelOf(other)}</Label>
          <Caption>{gapLabel(pair.gapMs)} · {other.sender ?? 'Added by you'} · {pair.survivorId === t.id ? 'this one is kept' : 'the other is kept'}</Caption>
        </View>
        <Icon name="chevron" color={p.muted} size={15} />
      </Pressable>
      <DuplicateActions pair={pair} />
    </> : null}
    {copies.length ? <View style={{ gap: 8, borderTopWidth: pair ? 1 : 0, borderTopColor: p.line, paddingTop: pair ? 12 : 0 }}>
      <Label>{copies.length === 1 ? '1 merged copy' : `${copies.length} merged copies`}</Label>
      {copies.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={`Open merged copy from ${c.sender ?? 'you'}`} onPress={() => open(c.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Caption style={{ flex: 1 }}>{c.sender ?? 'Added by you'} · {gapLabel(Math.abs(c.occurredAt - t.occurredAt))}</Caption>
        <Icon name="chevron" color={p.muted} size={15} />
      </Pressable>)}
    </View> : null}
  </View>;
}

// The Payee row (WF-3): the effective payee's label with Name / Rename, and the
// per-row "Move this one" escape hatch below it.
function PayeeRow({ transaction: t }: { transaction: Transaction }) {
  const p = usePalette();
  const { payeeOf, scheduleMatches, payeesById } = useLedger();
  const payee = payeeOf(t);
  const tracked = payee ? scheduleFor(payee, scheduleMatches.state.values(), payeesById) : null;
  const canTrack = payee && !tracked && (t.status === 'auto' || t.status === 'review' || t.status === 'manual');
  return <View style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, gap: 12, marginBottom: 22 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Caption>{t.direction === 'debit' ? 'Paid to' : 'Received from'}</Caption>
        <Label style={{ fontSize: 16, marginTop: 2 }}><Text numberOfLines={2}>{payee ? payeeLabel(payee) : t.merchant}</Text></Label>
        {payee?.name ? <Caption numberOfLines={1}>{payee.kind === 'masked' ? `a/c ${payee.masked ?? ''}` : payee.masked ?? payee.key}</Caption> : null}
        {payee ? <ScheduleBadge payee={payee} /> : null}
      </View>
      {payee ? <Action compact variant="secondary" title={payee.name ? 'Rename' : 'Name'} onPress={() => router.push({ pathname: '/name', params: { kind: 'payee', id: payee.id } })} /> : null}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Wrong payee? Move this one" onPress={() => router.push({ pathname: '/move', params: { id: t.id } })}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: p.line, paddingTop: 12 }}>
      <Caption>{t.payeeOverrideId ? 'Moved by you · change' : 'Wrong payee? Move this one'}</Caption>
      <Icon name="chevron" color={p.muted} size={15} />
    </Pressable>
    {canTrack ? <Pressable accessibilityRole="button" accessibilityLabel="Track as schedule" onPress={() => router.push({ pathname: '/schedule', params: { from: t.id } })}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: p.line, paddingTop: 12 }}>
      <Caption>Track as schedule</Caption>
      <Icon name="chevron" color={p.muted} size={15} />
    </Pressable> : null}
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
  // Pending and merged copies change state only through the duplicate panel.
  if (transaction.status === 'duplicate_review' || transaction.status === 'merged') {
    return <View style={{ gap: 9, paddingBottom: 15 }}><Action title={busy ? 'Saving…' : 'Save'} disabled={busy} onPress={() => onSave(transaction.status)} /></View>;
  }
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
    <DuplicatePanel transaction={t} />
    <PayeeRow transaction={t} />
    <View style={{ marginBottom: 28 }}><CategoryPicker value={category} onChange={setPicked} /></View>
    <TransactionFacts transaction={t} />
    {t.rawBody ? <View style={{ marginBottom: 24 }}><SmsSlip transaction={t} /></View> : null}
    <TransactionActions transaction={t} busy={busy} onSave={status => void save(status)} />
  </Screen>;
}
