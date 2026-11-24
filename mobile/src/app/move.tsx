import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Body, Caption, Screen, ScreenHead } from '@/ui/Kit';
import { Field, Note } from '@/ui/Forms';
import { Icon } from '@/ui/Icon';
import { effectivePayeeId, payeeLabel, payeeList } from '@/lib/resolve';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';

// "Wrong payee? Move this one" (WF-1): reassigns only this row, via payee_override_id.
// Later SMS still resolve to the original payee.
export default function MovePayee() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, payees, stats, movePayee } = useLedger();
  const t = transactions.find(item => item.id === id);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const current = t ? effectivePayeeId(t) : null;
  const original = t?.payeeOverrideId ? t.payeeId : null;
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = payeeList(payees, stats);
    // The row's own ingest payee stays reachable (to undo a move) even with no other rows.
    const originalPayee = original ? payees.find(x => x.id === original) : undefined;
    if (originalPayee && !list.some(e => e.payee.id === original)) {
      list.unshift({ payee: originalPayee, label: payeeLabel(originalPayee), stats: { count: 0, spentPaise: 0, receivedPaise: 0 } });
    }
    return list.filter(e => !q || e.label.toLowerCase().includes(q)).slice(0, 40);
  }, [payees, stats, query, original]);
  if (!t) return <Screen><ScreenHead title="Entry not found" back /></Screen>;

  async function move(target: string | { newName: string }) {
    if (!t) return;
    setBusy(true);
    try { await movePayee(t.id, target); router.back(); }
    catch (e) { showMessage('Could not move', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }

  // One box: type to find a payee, or keep typing and create one with that name.
  const typed = query.trim();
  const exact = options.some(e => e.label.toLowerCase() === typed.toLowerCase());
  return <Screen><ScreenHead title="Move this one" back />
    <Body muted>Only this transaction moves. Other and future messages keep their payee.</Body>
    <View style={{ gap: 12, marginTop: 22 }}>
      <Field label="Payee" value={query} onChangeText={setQuery} placeholder="Search, or type a new name" autoCapitalize="words" />
      {t.payeeOverrideId && t.payeeId ? <Note>Pick the original payee to undo the move.</Note> : null}
    </View>
    <View style={{ marginTop: 6 }}>
      {typed && !exact ? <Pressable accessibilityRole="button" accessibilityLabel={`Create payee ${typed}`} disabled={busy} onPress={() => void move({ newName: typed })}
        style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="plus" color={p.leaf} size={18} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{busy ? 'Moving…' : `Create “${typed}”`}</Text>
          <Caption>A new payee for this transaction</Caption>
        </View>
      </Pressable> : null}
      {options.map(e => <Pressable key={e.payee.id} accessibilityRole="button" disabled={busy || e.payee.id === current} onPress={() => void move(e.payee.id)}
        style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{e.label}</Text>
          <Caption>{e.stats.count} {e.stats.count === 1 ? 'transaction' : 'transactions'}{e.payee.id === t.payeeId && t.payeeOverrideId ? ' · original' : ''}</Caption>
        </View>
        {e.payee.id === current ? <Icon name="check" color={p.leaf} size={18} /> : null}
      </Pressable>)}
      {typed && !options.length ? <Caption style={{ marginTop: 10 }}>No payee matches “{typed}”.</Caption> : null}
    </View>
  </Screen>;
}
