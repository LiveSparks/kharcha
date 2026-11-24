import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, Screen, ScreenHead } from '@/ui/Kit';
import { Field, Note, OptionalCategoryPicker } from '@/ui/Forms';
import { accountDefaultLabel, effectivePayeeId, isLive, payeeDefaultLabel, payeeReach, validateName } from '@/lib/resolve';
import { scheduleFor } from '@/lib/schedules';
import { groupMembers, isHabitHidden } from '@/lib/habits';
import { usePalette } from '@/ui/theme';
import type { Category } from '@/lib/model';
import { useLedger } from '@/state/LedgerProvider';
import { showMessage } from '@/ui/dialog';

// The name sheet (WF-3), shared by payees and accounts. A name is a stored decision on
// the payee/account row; no transaction is rewritten, so clearing it brings the
// default label back everywhere.
export default function NameSheet() {
  const { kind, id } = useLocalSearchParams<{ kind: 'payee' | 'account'; id: string }>();
  const p = usePalette();
  const { payees, payeesById, accountsById, transactions, scheduleMatches, renamePayee, renameAccount, setHabitHidden } = useLedger();
  const payee = kind === 'payee' ? payeesById.get(id) : undefined;
  const account = kind === 'account' ? accountsById.get(id) : undefined;
  const current = payee ?? account;
  // An unnamed merchant payee starts with the name read from its messages, ready to keep
  // or edit; an account-number payee ("a/c **7788") has nothing worth suggesting.
  const [name, setName] = useState(current?.name ?? (payee?.kind === 'merchant' ? payeeDefaultLabel(payee).slice(0, 40).trim() : ''));
  const [category, setCategory] = useState<Category | null>(payee?.category ?? null);
  const [busy, setBusy] = useState(false);
  if (!current) return <Screen><ScreenHead title="Not found" back /><Body muted>This payee or account is no longer in your ledger.</Body></Screen>;
  const defaultLabel = payee ? payeeDefaultLabel(payee) : accountDefaultLabel(account!);
  const reach = payee ? payeeReach(payee.id, transactions) : transactions.filter(t => isLive(t) && t.accountId === account!.id).length;
  // Track as schedule (P4): prefilled from this payee's latest row, unless already tracked.
  const latest = payee && !scheduleFor(payee, scheduleMatches.state.values(), payeesById)
    ? transactions.find(t => isLive(t) && effectivePayeeId(t) === payee.id) : undefined;

  // Not a habit (P5): stored on every payee of this display group, so a variant
  // merchant string can't keep the Habit alive. Applies at once, like a toggle.
  const hidden = payee ? isHabitHidden(payee, payees) : false;
  async function toggleHabit(value: boolean) {
    if (!payee) return;
    try { await setHabitHidden(groupMembers(payee, payees), value); }
    catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
  }

  async function save(clear = false) {
    let clean: string | null;
    try { clean = clear ? null : validateName(name); }
    catch (e) { showMessage('Check the name', e instanceof Error ? e.message : 'Try again.'); return; }
    if (!clean && !clear && !current?.name) { showMessage('Enter a name', 'Give it a name of 1 to 40 characters.'); return; }
    setBusy(true);
    try {
      if (payee) await renamePayee(payee.id, clean, category);
      else await renameAccount(account!.id, clean);
      router.back();
    } catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }

  return <Screen><ScreenHead title={current.name ? `Rename ${payee ? 'payee' : 'account'}` : `Name this ${payee ? 'payee' : 'account'}`} back />
    <Caption>Shown as “{defaultLabel}” until named</Caption>
    <View style={{ gap: 21, marginTop: 18 }}>
      <Field label="Name" value={name} onChangeText={setName} placeholder={payee ? 'e.g. Landlord, Zomato' : 'e.g. Salary account'} autoCapitalize="words" />
      {payee ? <OptionalCategoryPicker label="Default category (optional)" value={category} onChange={setCategory} /> : null}
      <Note>Applies to {reach} past and all future transactions.{payee ? ' Rows you categorised by hand keep their category.' : ''}</Note>
      <Action title={busy ? 'Saving…' : 'Save'} disabled={busy} onPress={() => void save()} />
      {current.name ? <Action title="Clear name" variant="ghost" disabled={busy} onPress={() => void save(true)} /> : null}
      {payee ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}><Body>Not a habit</Body><Caption>Leave this payee out of Habits in Insights</Caption></View>
        <Switch accessibilityLabel="Not a habit" value={hidden} onValueChange={v => void toggleHabit(v)} trackColor={{ false: p.line, true: p.leaf }} thumbColor={hidden ? p.onLeaf : p.muted} />
      </View> : null}
      {latest ? <Action title="Track as schedule" variant="secondary" disabled={busy} onPress={() => router.push({ pathname: '/schedule', params: { from: latest.id } })} /> : null}
    </View>
  </Screen>;
}
