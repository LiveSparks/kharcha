import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Caption, Label } from './Kit';
import { PickerSheet } from './Sheet';
import { Icon } from './Icon';
import { fonts, usePalette } from './theme';
import { useLedger } from '@/state/LedgerProvider';
import { accountLabel } from '@/lib/resolve';
import type { Account, AccountKind } from '@/lib/model';
import { showMessage } from './dialog';

// Account settings below the name (v10): whose account it is, what type it is, and for
// a debit card the account it draws from. Each choice saves at once.

function Choices<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | null; options: readonly [T, string][]; onChange: (value: T) => void;
}) {
  const p = usePalette();
  return <View style={{ gap: 8 }}>
    <Label>{label}</Label>
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map(([v, text]) => <Pressable key={v} accessibilityRole="radio" accessibilityState={{ checked: value === v }} onPress={() => onChange(v)}
        style={{ minHeight: 38, paddingHorizontal: 13, borderRadius: 10, justifyContent: 'center',
          backgroundColor: value === v ? p.leaf : p.surface, borderWidth: value === v ? 0 : 1, borderColor: p.line }}>
        <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: value === v ? p.onLeaf : p.ink }}>{text}</Text>
      </Pressable>)}
    </View>
  </View>;
}

type Owner = 'mine' | 'not' | 'unsure';

export function AccountSettings({ account }: { account: Account }) {
  const p = usePalette();
  const { accounts, accountsById, setAccountMine, setAccountKind, linkDebitCard } = useLedger();
  const [picking, setPicking] = useState(false);
  const run = (write: Promise<void>) => void write.catch(e => showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'));
  const owner: Owner = account.mine === true ? 'mine' : account.mine === false ? 'not' : 'unsure';
  const funder = account.fundedBy ? accountsById.get(account.fundedBy) : undefined;
  const kind: AccountKind | null = account.kind === 'unknown' ? null : account.kind;
  return <View style={{ gap: 20 }}>
    <Choices<Owner> label="Is this yours?" value={owner}
      options={[['mine', 'Yes, mine'], ['not', 'Not mine'], ['unsure', 'Not sure yet']]}
      onChange={v => run(setAccountMine(account.id, v === 'mine' ? true : v === 'not' ? false : null))} />
    <Caption style={{ marginTop: -12 }}>{owner === 'not'
      ? 'Its messages are left out of your ledger, review, duplicates and totals. Its number can still show up as a payee.'
      : owner === 'mine' ? 'Its messages count in your ledger and totals.' : 'Counted for now. Say whether it is yours to keep your ledger to your own accounts.'}</Caption>
    <Choices<AccountKind> label="Type" value={kind}
      options={[['bank', 'Bank account'], ['debit_card', 'Debit card'], ['credit_card', 'Credit card']]}
      onChange={v => run(setAccountKind(account.id, v))} />
    {account.kind === 'debit_card' ? <View style={{ gap: 8 }}>
      <Label>Draws from</Label>
      <Pressable accessibilityRole="button" accessibilityLabel={`Draws from ${funder ? accountLabel(funder) : 'no account'}. Change`} onPress={() => setPicking(true)}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: 14, borderRadius: 11, borderWidth: 1, borderColor: p.strongLine, backgroundColor: p.surface }}>
        <Text style={{ fontFamily: fonts.body, fontSize: 15, color: funder ? p.ink : p.muted }}>{funder ? accountLabel(funder) : 'Pick the bank account'}</Text>
        <Icon name="chevron" color={p.muted} size={16} />
      </Pressable>
      <Caption>Its spends and balance messages count toward that account.</Caption>
      <PickerSheet open={picking} title="Draws from" onClose={() => setPicking(false)}
        options={[{ key: 'none', label: 'Not linked', on: !account.fundedBy, pick: () => { setPicking(false); run(linkDebitCard(account.id, null)); } },
          ...accounts.filter(a => a.id !== account.id && a.kind !== 'credit_card' && a.kind !== 'debit_card')
            .map(a => ({ key: a.id, label: accountLabel(a), on: account.fundedBy === a.id, pick: () => { setPicking(false); run(linkDebitCard(account.id, a.id)); } }))]} />
    </View> : null}
  </View>;
}
