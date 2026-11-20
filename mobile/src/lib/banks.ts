import type { AccountKind } from './model';

// Sender address → bank family code (app-modification spec §3.4). The routing prefix
// ("VM-", "AD-") and the trailing route suffix ("-S", "-T") are stripped first.
// RCS agents ("punjab_national_bank_…_agent@rbm.goog") carry the bank's full name, so
// the long forms map to the same family as the short-code senders.
const FAMILIES: [RegExp, string][] = [
  [/HDFCBK|HDFC_BANK|HDFCBN/, 'HDFC'],
  [/ICICI/, 'ICICI'],
  [/SBI|STATE_BANK_OF_INDIA/, 'SBI'],
  [/PNB|PUNJAB_NATIONAL_BANK/, 'PNB'],
];

export function senderCore(sender: string): string {
  return sender.trim().toUpperCase().replace(/^[A-Z]{2}-/, '').replace(/-[A-Z]$/, '');
}

export function bankFamily(sender: string | null | undefined): string {
  if (!sender) return '';
  const core = senderCore(sender);
  for (const [pattern, family] of FAMILIES) if (pattern.test(core)) return family;
  return core;
}

// What the words right before the account digits say about the account. Card-spend
// shapes name the card ("Debit Card xx1234", "Credit Card XX1234"); a bare "Card x1234"
// is a card of unknown type; "A/c", "Acct", "Account" is a bank account. Only a
// keyword that sits directly before the masked digits counts, so an amount that
// happens to end in the same four digits is never read as the account.
const KIND_BEFORE_DIGITS = /(?<![A-Za-z])(credit\s*card(?:\s*(?:account|a\/c))?|debit\s*card|debit\/atm\s*card|card|CC|DC|a\/c|acct|account|ac)\s*(?:no\.?|number)?\s*[:.-]?\s*$/i;

export function accountKindFrom(body: string | null | undefined, last4: string): AccountKind {
  if (!body || !/^\d{3,4}$/.test(last4)) return 'unknown';
  const text = body.normalize('NFKC');
  for (const match of text.matchAll(new RegExp(`${last4}(?!\\d)`, 'g'))) {
    let start = match.index;
    while (start > 0 && /[0-9Xx*]/.test(text[start - 1])) start--;
    const before = text.slice(Math.max(0, start - 40), start);
    const word = before.match(KIND_BEFORE_DIGITS)?.[1];
    if (!word) continue;
    const w = word.toLowerCase().replace(/\s+/g, ' ');
    if (w.startsWith('credit') || w === 'cc') return 'credit_card';
    if (w.startsWith('debit') || w === 'dc') return 'debit_card';
    if (w === 'card') return 'unknown';
    return 'bank';
  }
  return 'unknown';
}

const RANK: Record<AccountKind, number> = { unknown: 0, bank: 1, debit_card: 2, credit_card: 2 };

// Ingest only ever sharpens what is known about an account: a specific kind replaces
// 'unknown', a card kind replaces 'bank', and nothing downgrades (a user-confirmed
// debit-card link sets 'debit_card', which ingest never undoes).
export function mergeAccountKind(existing: AccountKind, seen: AccountKind): AccountKind {
  return RANK[seen] > RANK[existing] ? seen : existing;
}
