import { UNKNOWN_MERCHANT } from './identity.ts';
import type { Transaction } from './model';

// Why a row is waiting in To review (operator feedback, 2026-11-24). A message goes to
// the ledger on its own only when auto-add is on and the read names who it was with and
// which of your accounts it touched, with the amount next to a debit/credit word
// (parser.ts transactionConfidence). Each reason names the part that was missing.

type Row = Pick<Transaction, 'status' | 'merchant' | 'accountLast4' | 'counterpartyLast4' | 'confidence'>;

export function reviewReasons(t: Row, autoAdd: boolean): string[] {
  if (t.status !== 'review') return [];
  const reasons: string[] = [];
  if (!autoAdd) reasons.push('Auto-add is off, so every message waits here.');
  const named = !!t.merchant && t.merchant !== UNKNOWN_MERCHANT;
  if (!named) reasons.push(t.counterpartyLast4
    ? `Sent to an account number (··${t.counterpartyLast4}), not a named payee.`
    : "The message doesn't say who this was with.");
  if (!t.accountLast4) reasons.push("The message doesn't name your account or card.");
  if (named && t.accountLast4 && t.confidence <= 0.68) reasons.push("The amount isn't next to a word like debited or credited.");
  if (!reasons.length) reasons.push("Kharcha wasn't sure about this read.");
  return reasons;
}
