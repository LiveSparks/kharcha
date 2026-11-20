import { accountKindFrom, bankFamily } from './banks.ts';
import type { AccountKind, PayeeKind } from './model';

// Ingest-time identity (WF-1). Pure: given the parser's raw fields, say which account
// and which payee a row belongs to. Storage layers upsert what this returns.

export const UNKNOWN_MERCHANT = 'Unknown merchant';

export interface IdentitySource {
  sender: string | null;
  rawBody: string | null;
  merchant: string;
  accountLast4: string | null;
  counterpartyMasked: string | null;
  counterpartyLast4: string | null;
}

export interface AccountIdentity { id: string; bank: string; last4: string; kind: AccountKind }
export interface PayeeIdentity { id: string; kind: PayeeKind; bank: string; key: string; masked: string | null }

export function normalizeMerchant(merchant: string): string {
  return merchant.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Ids are derived from the natural key, so the same account or payee gets the same id
// on every device, in every backup and in the replay harness.
export function accountId(bank: string, last4: string): string { return `acct:${bank}:${last4}`; }
export function payeeId(kind: PayeeKind, bank: string, key: string): string { return `payee:${kind}:${bank}:${key}`; }

export function identityFor(t: IdentitySource): { account: AccountIdentity | null; payee: PayeeIdentity | null } {
  const bank = bankFamily(t.sender);
  const account = t.accountLast4 && t.sender
    ? { id: accountId(bank, t.accountLast4), bank, last4: t.accountLast4, kind: accountKindFrom(t.rawBody, t.accountLast4) }
    : null;
  const merchant = t.merchant.trim();
  let payee: PayeeIdentity | null = null;
  if (merchant && merchant !== UNKNOWN_MERCHANT) {
    const key = normalizeMerchant(merchant);
    if (key) payee = { id: payeeId('merchant', '', key), kind: 'merchant', bank: '', key, masked: merchant };
  } else if (t.counterpartyLast4) {
    payee = {
      id: payeeId('masked', bank, t.counterpartyLast4), kind: 'masked', bank, key: t.counterpartyLast4,
      masked: t.counterpartyMasked ?? `**${t.counterpartyLast4}`,
    };
  }
  return { account, payee };
}

// Payees made by "Move this one" get '<key>#<n>' so new ingests never resolve to them.
export function overrideKey(baseKey: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const key = `${baseKey}#${n}`;
    if (!used.has(key)) return key;
  }
}
