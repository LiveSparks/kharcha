import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Action, Body, Caption, CategoryDot, Screen, ScreenHead, SectionTitle } from '@/ui/Kit';
import { Field, Note } from '@/ui/Forms';
import { PickerSheet } from '@/ui/Sheet';
import { fonts, usePalette } from '@/ui/theme';
import { useLedger } from '@/state/LedgerProvider';
import { CATEGORY_SWATCHES, TRANSFERS } from '@/lib/model';
import type { Category } from '@/lib/model';
import { confirmAction, showMessage } from '@/ui/dialog';

// Your categories (v9): add one with a colour, or delete one and say where its
// transactions go. Transfers stays: the transfer panel depends on it.
export default function Categories() {
  const p = usePalette();
  const { categories, transactions, payees, budgets, categoryOf, addCategory, deleteCategory } = useLedger();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(CATEGORY_SWATCHES[8]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of transactions) m.set(categoryOf(t), (m.get(categoryOf(t)) ?? 0) + 1);
    return m;
  }, [transactions, categoryOf]);

  async function add() {
    setBusy(true);
    try { await addCategory(name, color); setName(''); }
    catch (e) { showMessage('Could not add', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }

  function remove(target: Category, into: Category) {
    setDeleting(null);
    const n = counts.get(target) ?? 0;
    const extras = [payees.some(x => x.category === target) ? 'payee defaults' : '', budgets.some(b => b.category === target) ? 'its budget' : ''].filter(Boolean);
    confirmAction(`Delete ${target}?`,
      `${n} ${n === 1 ? 'transaction moves' : 'transactions move'} to ${into}${extras.length ? `, along with ${extras.join(' and ')}` : ''}. New messages Kharcha would file under ${target} go to ${into} too.`,
      'Delete', () => {
        void deleteCategory(target, into).catch(e => showMessage('Could not delete', e instanceof Error ? e.message : 'Try again.'));
      });
  }

  return <Screen><ScreenHead title="Categories" back />
    <Body muted>Add your own, or delete one and move its transactions to another.</Body>
    <View style={{ marginTop: 22, gap: 12 }}>
      <SectionTitle>Add a category</SectionTitle>
      <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Pets, Rent, Kids" autoCapitalize="words" />
      <View accessibilityRole="radiogroup" accessibilityLabel="Colour" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {CATEGORY_SWATCHES.map(c => <Pressable key={c} accessibilityRole="radio" accessibilityLabel={`Colour ${c}`} accessibilityState={{ checked: color === c }} onPress={() => setColor(c)}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, borderWidth: color === c ? 3 : 0, borderColor: p.ink }} />)}
      </View>
      <Action title={busy ? 'Adding…' : 'Add category'} disabled={busy || !name.trim()} onPress={() => void add()} />
    </View>
    <View style={{ marginTop: 30, marginBottom: 6 }}><SectionTitle>Your categories · {categories.length}</SectionTitle></View>
    {categories.map(c => <View key={c.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.line }}>
      <CategoryDot category={c.name} size={12} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyMedium, color: p.ink }}>{c.name}</Text>
        <Caption>{counts.get(c.name) ?? 0} transactions{c.name === TRANSFERS ? ' · used for transfers, can’t be deleted' : ''}</Caption>
      </View>
      {c.name !== TRANSFERS && categories.length > 2 ? <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${c.name}`} onPress={() => setDeleting(c.name)} hitSlop={8}>
        <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: p.debit }}>Delete</Text>
      </Pressable> : null}
    </View>)}
    <View style={{ marginTop: 14 }}><Note>Kharcha files bank messages under the built-in categories. If you delete one, those messages land in the category you moved it to.</Note></View>
    <PickerSheet open={!!deleting} title={deleting ? `Move ${deleting} transactions to` : ''} onClose={() => setDeleting(null)}
      options={categories.filter(c => c.name !== deleting).map(c => ({ key: c.name, label: c.name, dot: c.name, on: false, pick: () => remove(deleting!, c.name) }))} />
  </Screen>;
}
