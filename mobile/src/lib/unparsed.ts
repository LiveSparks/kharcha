import type { Direction } from './model';

// "Couldn't read" capture (WF-5, spec §5.2). An allowed-sender SMS that parseBankSms
// rejected is kept for the user when it states an amount and a transaction verb and
// isn't promotional, a bill reminder, a collect request or a notice of a future
// debit (those name an amount and a verb but nothing has moved yet). Pure; the scan
// stores what this accepts.

const AMOUNT = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const VERB = /\b(debited|credited|spent|sent|received|paid|withdrawn|deposited)\b/i;
const NOT_YET = /\b(?:will be (?:debited|credited)|upcoming|has requested|requested (?:money|Rs)|to be (?:paid|debited)|(?:total|min(?:imum)?) (?:amount )?due|overdue)\b/i;
const EXCLUDE = /\b(cashback|offers?|pre-?approved|loans?|is due)\b|https?:\/\/|\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|[a-z0-9-]+\.(?:ly|io|gl|gy|me))\/\S/i;

export function isUnreadTransaction(body: string): boolean {
  return AMOUNT.test(body) && VERB.test(body) && !EXCLUDE.test(body) && !NOT_YET.test(body);
}

const DEBIT_VERB = /\b(debited|spent|sent|paid|withdrawn)\b/i;
const CREDIT_VERB = /\b(credited|received|deposited)\b/i;

// Best-effort prefill for "Add as transaction". Never stored as a parse.
export function unparsedHints(body: string): { amountPaise: number | null; direction: Direction | null } {
  const match = AMOUNT.exec(body);
  const rupees = match ? Number(match[1].replace(/,/g, '')) : NaN;
  const amountPaise = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : null;
  const debit = DEBIT_VERB.exec(body)?.index ?? Infinity;
  const credit = CREDIT_VERB.exec(body)?.index ?? Infinity;
  const direction = debit === credit ? null : debit < credit ? 'debit' : 'credit';
  return { amountPaise, direction };
}
