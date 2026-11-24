import { isMandateEcho, parseBankSms } from './parser.ts';
import type { RestorableStatus, Transaction, TransactionStatus } from './model';

// v6 → v7 re-check (operator, 2026-11-24). Pure: returns the row changes the SQLite
// migration and the web preview both apply.
//
// 1. Auto-debit mandate echoes ("AutoPay (E-mandate) Success!") are no longer spends:
//    each becomes Ignored, and a twin that was flagged against it or merged into it
//    comes back with the status it had before the flag.
// 2. A reference number stopped being required for auto-add. Rows still waiting in
//    review (or waiting behind a duplicate flag with review underneath) whose stored
//    message now clears the bar move to the ledger. Only untouched review rows move;
//    nothing is ever demoted, and nothing moves when auto-add is off.

export interface RegradePatch {
  id: string;
  status: TransactionStatus;
  duplicateOf: string | null;
  preFlagStatus: RestorableStatus | null;
  confidence: number;
}

type Row = Pick<Transaction, 'id' | 'rawBody' | 'status' | 'duplicateOf' | 'preFlagStatus' | 'confidence'>;

export const AUTO_ADD_BAR = 0.9;

export function regradePatches(rows: readonly Row[], autoAdd: boolean): RegradePatch[] {
  const state = new Map<string, RegradePatch>(rows.map(r => [r.id, {
    id: r.id, status: r.status, duplicateOf: r.duplicateOf, preFlagStatus: r.preFlagStatus, confidence: r.confidence,
  }]));
  const echoes = new Set(rows.filter(r => r.rawBody && r.status !== 'ignored' && isMandateEcho(r.rawBody)).map(r => r.id));
  for (const id of echoes) Object.assign(state.get(id)!, { status: 'ignored', duplicateOf: null, preFlagStatus: null });
  for (const s of state.values()) {
    if (echoes.has(s.id) || !s.duplicateOf || !echoes.has(s.duplicateOf)) continue;
    if (s.status !== 'merged' && s.status !== 'duplicate_review') continue;
    Object.assign(s, { status: s.preFlagStatus ?? 'review', duplicateOf: null, preFlagStatus: null });
  }
  for (const r of rows) {
    const s = state.get(r.id)!;
    if (!r.rawBody || echoes.has(r.id) || r.confidence >= AUTO_ADD_BAR) continue;
    const waiting = s.status === 'review' || (s.status === 'duplicate_review' && s.preFlagStatus === 'review');
    if (!waiting) continue;
    const fresh = parseBankSms(r.rawBody)?.confidence ?? 0;
    if (fresh < AUTO_ADD_BAR) continue;
    s.confidence = fresh;
    if (!autoAdd) continue;
    if (s.status === 'review') s.status = 'auto';
    else s.preFlagStatus = 'auto';
  }
  return rows.flatMap(r => {
    const s = state.get(r.id)!;
    const same = s.status === r.status && s.duplicateOf === r.duplicateOf && s.preFlagStatus === r.preFlagStatus && s.confidence === r.confidence;
    return same ? [] : [s];
  });
}

// Bank sender rules match the bank code inside the header, whatever the 2-letter route
// prefix and "-S"/"-T" suffix (native matching: a rule of 5+ characters matches when the
// header contains it). The first defaults named one exact route, so ICICI and SBI
// messages from other routes were never read; HDFC's UPI sender had no rule at all.
export const SENDER_RENAMES: readonly [string, string][] = [['AX-ICICIT', 'ICICIT'], ['VM-SBIUPI', 'SBIUPI']];
export const HDFC_UPI_SENDER = { address: 'HDFCBN', label: 'HDFC Bank · UPI' } as const;
