import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Caption, Label } from './Kit';
import { fonts, usePalette } from './theme';
import { showMessage } from './dialog';
import { dateLabel, money, signedMoney, timeLabel } from '@/lib/format';
import { accountLabel } from '@/lib/resolve';
import { gapLabel } from '@/lib/duplicates';
import type { DuplicatePair } from '@/lib/duplicates';
import { unparsedHints } from '@/lib/unparsed';
import type { Transaction, UnparsedMessage } from '@/lib/model';
import { useLedger } from '@/state/LedgerProvider';

// Duplicate review surfaces (WF-5): one card per pending pair with both slips, the
// default survivor badged Keep, and Merge / Keep the other / Keep both.

function useRun() {
  const [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); }
    catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  };
  return { busy, run };
}

function PairSlip({ transaction: t, keep }: { transaction: Transaction; keep: boolean }) {
  const p = usePalette();
  const { labelOf, accountOf } = useLedger();
  const account = accountOf(t);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${labelOf(t)}${keep ? ', kept' : ''}`}
    onPress={() => router.push({ pathname: '/transaction/[id]', params: { id: t.id } })}
    style={{ borderRadius: 14, borderWidth: keep ? 1.5 : 1, borderColor: keep ? p.leaf : p.line, padding: 12, gap: 8, backgroundColor: p.bg }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: p.muted }}>{t.sender ?? 'Added by you'}</Text>
      {keep ? <View style={{ backgroundColor: p.leaf, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}><Text style={{ fontFamily: fonts.bodyMedium, fontSize: 11, color: p.onLeaf }}>Keep</Text></View> : null}
      <Caption>{dateLabel(t.occurredAt)} · {timeLabel(t.occurredAt)}</Caption>
    </View>
    {t.rawBody ? <Text selectable numberOfLines={6} style={{ fontFamily: fonts.monoRegular, fontSize: 12, lineHeight: 18, color: p.ink, backgroundColor: p.sunk, borderRadius: 10, padding: 10 }}>{t.rawBody}</Text> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label><Text numberOfLines={1}>{labelOf(t)}</Text></Label>
        <Caption numberOfLines={1}>{account ? accountLabel(account) : t.accountLast4 ? `Account ··${t.accountLast4}` : 'No account in message'}</Caption>
      </View>
      <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: t.direction === 'debit' ? p.debit : p.credit }}>{signedMoney(t.amountPaise, t.direction)}</Text>
    </View>
  </Pressable>;
}

export function DuplicateActions({ pair, onDone }: { pair: DuplicatePair; onDone?: () => void }) {
  const { mergeDuplicate, keepBoth } = useLedger();
  const { busy, run } = useRun();
  const other = pair.survivorId === pair.flagged.id ? pair.partner.id : pair.flagged.id;
  const act = (task: () => Promise<void>) => void run(async () => { await task(); onDone?.(); });
  return <View style={{ gap: 7 }}>
    <View style={{ flexDirection: 'row', gap: 7 }}>
      <View style={{ flex: 1 }}><Action compact variant="leaf" title="Merge" disabled={busy} onPress={() => act(() => mergeDuplicate(pair.flagged.id, pair.survivorId))} /></View>
      <View style={{ flex: 1 }}><Action compact variant="secondary" title="Keep the other" disabled={busy} onPress={() => act(() => mergeDuplicate(pair.flagged.id, other))} /></View>
    </View>
    <Action compact variant="ghost" title="Keep both, not a duplicate" disabled={busy} onPress={() => act(() => keepBoth(pair.flagged.id))} />
  </View>;
}

export function DuplicatePairCard({ pair }: { pair: DuplicatePair }) {
  const p = usePalette();
  const [first, second] = pair.partner.occurredAt <= pair.flagged.occurredAt ? [pair.partner, pair.flagged] : [pair.flagged, pair.partner];
  return <View style={{ backgroundColor: p.surface, borderRadius: 20, borderWidth: 1, borderColor: p.marigold, padding: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink, fontSize: 14 }}>Same {money(pair.flagged.amountPaise, true)} twice?</Text>
      <Caption style={{ color: p.review }}>{gapLabel(pair.gapMs)}</Caption>
    </View>
    <PairSlip transaction={first} keep={first.id === pair.survivorId} />
    <PairSlip transaction={second} keep={second.id === pair.survivorId} />
    <DuplicateActions pair={pair} />
  </View>;
}

export function UnparsedCard({ message: m }: { message: UnparsedMessage }) {
  const p = usePalette();
  const { dismissUnparsed } = useLedger();
  const { busy, run } = useRun();
  const hints = unparsedHints(m.rawBody);
  return <View style={{ backgroundColor: p.surface, borderRadius: 20, borderWidth: 1, borderColor: p.line, padding: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: p.muted }}>{m.sender}</Text>
      <Caption>{dateLabel(m.receivedAt)} · {timeLabel(m.receivedAt)}</Caption>
    </View>
    <Text selectable style={{ fontFamily: fonts.monoRegular, fontSize: 12, lineHeight: 18, color: p.ink, backgroundColor: p.sunk, borderRadius: 10, padding: 10 }}>{m.rawBody}</Text>
    <Caption>{hints.amountPaise ? `Mentions ${money(hints.amountPaise, true)}, but Kharcha couldn't read who or which account.` : "Kharcha couldn't read this message."}</Caption>
    <View style={{ flexDirection: 'row', gap: 7 }}>
      <View style={{ flex: 1 }}><Action compact variant="ghost" title="Dismiss" disabled={busy} onPress={() => void run(() => dismissUnparsed(m.id))} /></View>
      <View style={{ flex: 1 }}><Action compact variant="leaf" title="Add as transaction" disabled={busy} onPress={() => router.push({ pathname: '/manual', params: { unparsedId: m.id } })} /></View>
    </View>
  </View>;
}
