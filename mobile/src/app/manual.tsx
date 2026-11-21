import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Caption, Screen, ScreenHead } from '@/ui/Kit';
import { CategoryPicker, Field } from '@/ui/Forms';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { dateLabel, timeLabel } from '@/lib/format';
import { unparsedHints } from '@/lib/unparsed';
import type { Category, Direction } from '@/lib/model';
import { showMessage } from '@/ui/dialog';

// Manual entry. Opened from Couldn't read (?unparsedId=…), it starts from the
// message's amount, likely direction and time, and links the message on save.
export default function Manual() {
  const p = usePalette();
  const { unparsedId } = useLocalSearchParams<{ unparsedId?: string }>();
  const { addManual, addFromUnparsed, unparsed } = useLedger();
  const source = unparsedId ? unparsed.find(m => m.id === unparsedId && m.status === 'pending') ?? null : null;
  const hints = source ? unparsedHints(source.rawBody) : null;
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState(() => {
    const paise = source?.amountPaise ?? hints?.amountPaise;
    return paise ? String(paise / 100) : '';
  });
  const [category, setCategory] = useState<Category>('Food & dining');
  const [direction, setDirection] = useState<Direction>(hints?.direction ?? 'debit');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      if (source) await addFromUnparsed(source.id, merchant, Number(amount), direction, category, source.receivedAt);
      else await addManual(merchant, Number(amount), direction, category);
      router.back();
    }
    catch (e) { showMessage('Check the entry', e instanceof Error ? e.message : 'Try again.'); }
    finally { setSaving(false); }
  }
  return <Screen><ScreenHead title="Add an entry" back />
    {source ? <View style={{ marginBottom: 22, gap: 6 }}>
      <Caption>From {source.sender} · {dateLabel(source.receivedAt)} · {timeLabel(source.receivedAt)}</Caption>
      <Text selectable numberOfLines={5} style={{ fontFamily: fonts.monoRegular, fontSize: 12, lineHeight: 18, color: p.ink, backgroundColor: p.sunk, borderRadius: 10, padding: 10 }}>{source.rawBody}</Text>
    </View> : null}
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
      {(['debit', 'credit'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: direction === value }} onPress={() => setDirection(value)} style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: direction === value ? p.leaf : p.surface }}><Text style={{ fontFamily: fonts.bodyMedium, color: direction === value ? p.onLeaf : p.ink }}>{value === 'debit' ? 'Spent' : 'Received'}</Text></Pressable>)}
    </View>
    <View style={{ gap: 20 }}><Field label="Amount in rupees" value={amount} onChangeText={setAmount} numeric placeholder="0.00" /><Field label={direction === 'debit' ? 'Paid to' : 'Received from'} value={merchant} onChangeText={setMerchant} placeholder="Name or place" /><CategoryPicker value={category} onChange={setCategory} /><Action title={saving ? 'Saving…' : 'Save entry'} disabled={saving} onPress={() => void save()} /></View>
  </Screen>;
}
