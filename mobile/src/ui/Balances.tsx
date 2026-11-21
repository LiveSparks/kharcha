import React from 'react';
import { Text } from 'react-native';
import { Caption } from './Kit';
import { fonts, usePalette } from './theme';
import { dateLabel, money, timeLabel } from '@/lib/format';
import type { AccountBalance } from '@/lib/balances';

// Balance figures (P3, WF-4): one wording everywhere an account's figure shows.

export function figureTitle(b: AccountBalance): string {
  return b.kind === 'outstanding' ? 'Outstanding' : b.kind === 'available' ? 'Available' : 'Balance';
}

// A signed rupee figure: negative balances (overdrawn) keep their minus.
export function figureText(paise: number): string {
  return paise < 0 ? `−${money(-paise, true)}` : money(paise, true);
}

export function AsOf({ balance }: { balance: AccountBalance }) {
  const p = usePalette();
  if (balance.asOf === null) return null;
  return <Caption style={balance.stale ? { color: p.muted, opacity: 0.7 } : undefined}>
    as of {dateLabel(balance.asOf)} · {timeLabel(balance.asOf)}{balance.stale ? ' · no balance message in 30 days' : ''}
  </Caption>;
}

export function Figure({ balance, size = 15 }: { balance: AccountBalance; size?: number }) {
  const p = usePalette();
  if (balance.amountPaise === null) return null;
  const owed = balance.kind === 'outstanding' && balance.amountPaise > 0;
  return <Text style={{ fontFamily: fonts.mono, fontSize: size, color: owed || balance.amountPaise < 0 ? p.debit : p.ink }}>{figureText(balance.amountPaise)}</Text>;
}
