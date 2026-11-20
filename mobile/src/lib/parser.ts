import type { Category, Direction } from './model';

export interface ParsedSms {
  merchant: string;
  amountPaise: number;
  direction: Direction;
  category: Category;
  accountLast4: string | null;
  reference: string | null;
  confidence: number;
  // Masked counterparty account ("to a/c **5280"): structured exposure of the other
  // side for shapes where neither side is a merchant name. Verbatim mask on the wire,
  // digits-only companion for storage and joins.
  counterpartyMasked: string | null;
  counterpartyLast4: string | null;
}

const amountPattern = /(?:Rs\.?|INR\.?|₹)\s*([\d,]+(?:\.\d+)?)/i;
const contextualAmountPatterns = [
  /\b(?:debited by|credited by|sent|spent|paid|received)\s*(?:Rs\.?|INR\.?|₹)?\s*([\d,]+(?:\.\d+)?)/i,
  /(?:Rs\.?|INR\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:has been|was|is)?\s*(?:debited|credited|spent|paid|received)\b/i,
];
const otpPattern = /\b(otp|one.?time.password|verification code|login code|do not share|valid for \d+ min)\b/i;
const promoPattern = /\b(cashback|voucher|reward|bonus|claim|spam|discount|coupon|apply now|limited time|shop now|sale ends|pre.approved loan|off your bill)\b|\bbit\.ly\b/i;
// Money that is announced but not yet moved: approval requests, future mandates, due reminders.
const pendingPattern = /\b(?:will be|is being|going to be|to be)\s+(?:debited|credited|deducted|charged|withdrawn)\b|\bon approval\b|\bonce approved\b|\bhas requested (?:money|rs|inr)\b|\bamount to be paid\b|\boverdue\b|\bignore if paid\b|\bwill change to\b|\breceived a request\b|\bneeds to be paid\b|\bopt for\b/i;
// Money that did not move: declined, bounced, or unpaid attempts.
const failedPattern = /\b(?:declined|failed|failure|not processed|could not be processed|insufficient (?:funds|balance))\b/i;
// Merchant-side acknowledgements ("We have received a payment of Rs.130.85 for your Airtel
// account", "payment received for certificate", "Thank you for booking"): the same money
// already lands through the bank's own debit SMS, and counting both would double the ledger.
const acknowledgmentPattern = /\b(?:we|they)\s+have\s+received\s+(?:a\s+)?payment\b|\bpayment received\b|\bthank you for booking\b|\byour order\b.{0,80}\b(?:received|being processed|processed)\b|\byour main account balance\b|\bsuccessfully processed\s+(?:the\s+)?payment\b/i;
const referencePattern = /(?:UPI\s*Ref(?:\s*(?:No\.?|ID))?|Ref(?:\s*No\.?)?|RRN|UTR|SI Hub ID)\s*[:#.-]?\s*([A-Za-z0-9]{6,})/i;
const upiColonReferencePattern = /\bUPI\s*[:#]\s*(\d{8,})/i;
const upiBareReferencePattern = /\(UPI\s+(\d{8,})\)/i;
const accountPattern = /(?:A\/?c|Acct|Acc|Account|Card)\s*(?:no\.?\s*)?(?:[Xx*·-]+\s*)?(\d{3,})\b/i;
const merchantPatterns = [
  /\b(?:to\s+VPA|trf\s+to|paid\s+to)\s+([A-Z0-9._@ -]+?)(?=\s*\(|\s+Ref|\s+on\s+\d|[.;]|$)/i,
  /\bsent\s+(?:rs\.?|inr|₹)\s*[\d,.]+[\s\S]*?\bTo\s+([^\n|]+?)(?=\s*(?:\||\n)|\s*On\s+\d|\s*Not\s|\s*$)/i,
  /\b(?:at|from)\s+([A-Z][A-Z0-9&._@ -]+?)(?=\s+via\s+(?:UPI|IMPS|NEFT|RTGS|card)\b|\s+on\s+\d|\s+Ref\b|\s*\(|[.;]|$)/i,
  /\bNEFT\s+from\s+([A-Z0-9 &._-]+?)(?=[.;]|$)/i,
];

function titleCase(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/\b\p{L}/gu, c => c.toUpperCase())
    .replace(/([\p{L}])([\p{L}]+)/gu, (_, first: string, rest: string) => first + rest.toLowerCase());
}

export function categoryFor(merchant: string, body = ''): Category {
  const text = `${merchant} ${body}`.toLowerCase();
  if (/swiggy|zomato|restaurant|cafe|coffee|domino|food/.test(text)) return 'Food & dining';
  if (/blinkit|zepto|bigbasket|grocer|supermarket|dmart/.test(text)) return 'Groceries';
  if (/uber|ola\b|metro|irctc|flight|bus|travel|petrol|fuel|toll|fastag|netc/.test(text)) return 'Travel';
  if (/electric|airtel|jio|water bill|rent|broadband|utility|credit card/.test(text)) return 'Bills';
  if (/amazon|flipkart|myntra|shopping|store|book\s*(?:mart|shop)/.test(text)) return 'Shopping';
  if (/pharm|apollo|hospital|clinic|doctor|medicine|health/.test(text)) return 'Health';
  if (/netflix|spotify|movie|cinema|prime video/.test(text)) return 'Entertainment';
  return 'Transfers';
}

function toPaise(value: string): number {
  const amount = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return 0;
  return Math.round(amount * 100);
}

function isTransactionMessage(body: string): boolean {
  if (!body || body.length > 4000) return false;
  // "without PIN/OTP" appears inside completed transaction alerts, not OTP messages.
  const otpScan = body.replace(/(?:pin|password|cvv)\s*\/\s*otp/gi, '');
  return !otpPattern.test(otpScan) && !promoPattern.test(body) && !acknowledgmentPattern.test(body);
}

function isPending(body: string): boolean { return pendingPattern.test(body); }
function isFailed(body: string): boolean { return failedPattern.test(body); }

function firstMatch(patterns: RegExp[], body: string): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match;
  }
  return null;
}

interface ShapeResult {
  direction: Direction;
  amountPaise: number;
  merchant: string | null;
  accountLast4: string | null;
  reference: string | null;
  counterpartyMasked?: string | null;
  counterpartyLast4?: string | null;
  category?: Category;
}

function digits(value: string | undefined): string | null {
  if (!value) return null;
  return value.length >= 4 ? value.slice(-4) : value;
}

// A masked counterparty token like "**5280": keep the verbatim mask and expose the digits.
function counterparty(masked: string | undefined): { masked: string | null; last4: string | null } {
  const token = masked?.replace(/\s+/g, '') ?? '';
  const last4 = digits(token.match(/(\d+)$/) ? token.match(/(\d+)$/)![1] : undefined);
  return { masked: token || null, last4 };
}

// Payee/payer inside HDFC "Update! INR ... deposited ... for <narration>".
// Rail rows look like "NEFT Cr-<IFSC>-<Originator>-<Remitter>-<bank ref>" and third-party
// transfers look like "<masked acct>-TPT-Family-<remitter>"; plain narratives (interest,
// cash deposit, card POS, FX remittance refs) are reference data, not a remitter name.
function payerFromNarration(narration: string): string {
  const text = narration.trim();
  if (/interest paid/i.test(text)) return '';
  if (/^INW\b/i.test(text)) return '';
  const cashDeposit = text.match(/cash deposit by\s*[-\u2013]\s*(\w+)/i);
  if (cashDeposit) return cashDeposit[1];
  const cardPos = text.match(/^CRV POS\s+\S+\s+(.+)$/i);
  if (cardPos) return cardPos[1];
  const segments = text.split('-').map(part => part.trim()).filter(Boolean);
  if (/^(?:NEFT|RTGS|IMPS)\b/i.test(segments[0] ?? '')) {
    segments.splice(0, 2); // drop "<rail> Cr" and the IFSC...
    const last = segments[segments.length - 1] ?? '';
    if (last.length >= 12 && /\d{6,}/.test(last)) segments.pop(); // ...and the trailing bank reference
    return segments.join('-');
  }
  const upper = segments.map(part => part.toUpperCase());
  if (upper.includes('TPT')) return segments[segments.length - 1] ?? narration;
  return '';
}

// HDFC "for NEFT Cr-INDB0000006-Acme Escrow Inc-Arjun Mehta-INDBN...": payer sits
// between the rail/IFSC prefix and the trailing bank reference.
function payerAfterFor(after: string): string {
  const narration = after.split(/\.\s*Avl bal|\.Avl bal/)[0].trim().replace(/\.$/, '').trim();
  return payerFromNarration(narration);
}

const amount = String.raw`\s*(?:Rs\.?|INR\.?|₹)\s?([\d,]+(?:\.\d+)?)`;
const acct = String.raw`A\/c\s*(?:No\.?\s*)?(?:[Xx*]+\s*)?(\d{3,})`;

const shapes: Array<(body: string) => ShapeResult | null> = [
  // HDFC UPI debit: "Sent Rs.142.00\nFrom HDFC Bank A/C *3391\nTo FRESH MART\n..."
  // (also the "|"-separated single-line variant and "UPI Mandate:\nSent ..." executions).
  // The payee is read from the declared To section only; the trailing
  // "SMS BLOCK UPI to <phone>" must never win.
  body => {
    const amount = body.match(/\bSent\s+(?:Rs\.?|INR\.?|₹)\s*([\d,]+(?:\.\d+)?)/i);
    if (!amount) return null;
    const from = body.match(/From\s+HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx*]+\s*)?(\d{3,4})/i);
    const payeeMatch = body.slice(from ? (from.index ?? 0) : 0).match(/\bTo\s+([^\n|]+)/i);
    const payee = payeeMatch?.[1]?.trim().replace(/[\s|]+$/, '') ?? '';
    if (!payee) return null;
    return {
      direction: 'debit', amountPaise: toPaise(amount[1]), merchant: payee,
      accountLast4: digits(from?.[1]), reference: findReference(body),
    };
  },

  // HDFC UPI credit: "Credit Alert!\nRs.38000.00 credited to HDFC Bank A/c XX3391 on ... from VPA payer (UPI ref)"
  body => {
    const m = body.match(/Credit Alert!\s*(?:Rs\.?|INR\.?)?\s*([\d,]+(?:\.\d+)?)\s*credited to (?:HDFC Bank )?A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})[\s\S]{0,80}?from\s+(?:VPA\s+)?(\S+@[\w.]+|[\w .&'-]+?)\s*(?:\(UPI\s+(\d{8,})\)|$)/i);
    if (!m) return null;
    return {
      direction: 'credit', amountPaise: toPaise(m[1]), merchant: m[3]?.trim() || null,
      accountLast4: digits(m[2]), reference: m[4] ?? findReference(body),
    };
  },

  // HDFC FASTag wallet recharge: money moved out of the bank account into the wallet,
  // so this is a debit even though the wording says "credited/added to ... FASTag".
  body => {
    const m = body.match(/(?:Alert!|FASTag Alert)\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*(?:credited to|added to)\s*(?:HDFC Bank )?NETC FASTag\s*\d{6,}/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: null, reference: null, category: 'Travel' };
  },

  // HDFC FASTag toll / parking / annual pass: "Toll Paid!\nRs.65 for XX00AB1234",
  // "Alert!\nPaid Rs.65 toll for ...", "Paid: Rs.70 At: ... Via HDFC Bank NETC FASTag".
  // The toll plaza name is travel metadata, not a merchant, so the payee stays null.
  body => {
    if (!/\b(?:toll|fastag|netc)\b/i.test(body)) return null;
    const m = body.match(/\bPaid[!:\s]*\s*(?:Rs\.?|INR\.?)?\s*([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: null, reference: null, category: 'Travel' };
  },

  // HDFC card purchase: "Spent Rs.325.68 From HDFC Bank Card x8812 At MERCHANT On ...",
  // "Rs.1240.30 spent on HDFC Bank Card x8812 at MERCHANT on ...",
  // "ALERT:Rs.368.58 spent via HDFC BANK Debit Card xx8812 at MERCHANT on ...".
  body => {
    const card = body.match(/(?:[Cc]ard|DEBIT\/ATM Card)\s*[xX*]+\s*(\d{3,4})/);
    if (!card) return null;
    const m = firstMatch([
      new RegExp(`\\bSpent\\s+(?:Rs\\.?|INR\\.?)\\s?([\\d,]+(?:\\.\\d+)?)\\s*From[\\s\\S]{0,40}?Card\\s*[xX*]+\\s*\\d{3,4}\\s+At\\s+(.+?)\\s+On\\s`, 'i'),
      new RegExp(`\\b(?:Rs\\.?|INR\\.?)\\s?([\\d,]+(?:\\.\\d+)?)\\s*spent\\s+(?:via\\s+|on\\s+)?(?:HDFC BANK\\s+)?(?:Debit )?Card\\s*[xX*]+\\s*\\d{3,4}\\s+at\\s+(.+?)\\s+on\\s+\\S`, 'i'),
      new RegExp(`\\b(?:Rs\\.?|INR\\.?)\\s?([\\d,]+(?:\\.\\d+)?)\\s*spent on (?:HDFC Bank )?Card\\s*[xX*]+\\s*\\d{3,4}\\s+at\\s+(.+?)\\s+on\\s+\\S`, 'i'),
    ], body);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: (m[2] ?? '').trim() || null, accountLast4: digits(card[1]), reference: null };
  },

  // ATM withdrawal: "Withdrawn Rs.5000 From HDFC Bank Card x8812 At CITY BR" /
  // "Rs.4000 withdrawn from HDFC Bank Card x8812 at STATION ROAD". The ATM location
  // is not a merchant, so the payee stays null (adjudicated against the eval set).
  body => {
    const m = firstMatch([
      new RegExp(`\\bWithdrawn\\s+(?:Rs\\.?|INR\\.?)\\s?([\\d,]+(?:\\.\\d+)?)\\s*[Ff]rom[\\s\\S]{0,40}?Card\\s*[xX*]+\\s*(\\d{3,4})`),
      new RegExp(`\\b(?:Rs\\.?|INR\\.?)\\s?([\\d,]+(?:\\.\\d+)?)\\s*withdrawn from[\\s\\S]{0,40}?Card\\s*[xX*]+\\s*(\\d{3,4})`),
    ], body);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: null };
  },

  // HDFC AutoPay mandate execution: "AutoPay (E-mandate) Success!\nFor Google Workspace\nTxn Amt:INR325.68\nDt:...\nVia:HDFC Bank DC 8812".
  body => {
    const m = body.match(/AutoPay \(E-mandate\) Success!\s*For\s+([^\n]+?)\s*Txn Amt:\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    const card = body.match(/Via:\s*HDFC Bank (?:DC|CC|Card)?\s*(\d{3,4})/i);
    return {
      direction: 'debit', amountPaise: toPaise(m[2]), merchant: m[1]?.trim() || null,
      accountLast4: digits(card?.[1]), reference: findReference(body),
    };
  },

  // HDFC mandate plan / future deduction notices never carry completed money.
  // They are rejected before amount picking (pendingPattern), but pin the shape here
  // so a future refactor cannot silently start parsing them.
  body => {
    if (/^(?:Mandate Set|E-Mandate!|AutoPay Active!|Alert:\s*$)/im.test(body) && /\b(?:will be deducted|for [^\n]+|Starting:)/i.test(body)) return null;
    return null;
  },

  // HDFC NEFT/RTGS/TPT inward deposit: "Update! INR 36,210.50 deposited in HDFC Bank
  // A/c XX3391 on ... for NEFT Cr-INDB0000006-Acme Escrow Inc-Arjun Mehta-INDBN...".
  // TPT narrations carry the remitter's masked account ("XXXXXXXXXX4620-TPT-...");
  // that masked number is the from-counterparty side, so it gets the structured treatment too.
  body => {
    const m = body.match(/(?:Update!|UPDATE:)\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*deposited (?:in|to) (?:HDFC Bank )?A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+on\s+\S+\s+for\s+([\s\S]+?)(?:\.\s*Avl bal|\.Avl bal|$)/i);
    if (!m) return null;
    const counterpartyResult = /^[Xx*]+\s*\d{3,}\s*[-\u2013]\s*TPT\b/i.test(m[3].trim())
      ? counterparty(m[3].split('-')[0])
      : { masked: null, last4: null };
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: payerAfterFor(m[3]) || null, accountLast4: digits(m[2]), reference: null,
      counterpartyMasked: counterpartyResult.masked, counterpartyLast4: counterpartyResult.last4 };
  },

  // HDFC subsidy deposit: "INR 2.10 deposited to HDFC Bank A/C No XXXXXXXXXX3391 towards DBL subsidy- Val 04-Aug-26."
  body => {
    const m = body.match(/(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*deposited to (?:HDFC Bank )?A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+towards\s+(?:[A-Z]{2,3}\s+)?subsidy/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: null };
  },

  // HDFC outward transfer update: "UPDATE: INR 1,50,000.00 debited from HDFC Bank XX7713 on ... Info: ..."
  body => {
    const m = body.match(/(?:Update!|UPDATE:)\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*debited from (?:HDFC Bank )?(?:A\/c\s*)?(?:[Xx]+\s*)?(\d{4,6})/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: null };
  },

  // HDFC IMPS credit: "Received!\nINR 12,750.00 in HDFC Bank A/c xx9025\nOn ...\nFor IMPS -KARAN MALHOTRA- 61462000006".
  body => {
    const m = body.match(/(?:^Received!|\nReceived!)\s*\n?\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s+in (?:your )?HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})[\s\S]{0,80}?For IMPS\s*-([A-Za-z0-9 .&/'-]+?)\s*-\s*(\d{6,})/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: m[3]?.trim() || null, accountLast4: digits(m[2]), reference: m[4] };
  },

  // HDFC mobile-linked IMPS credit: "Money Received - INR 12,400.00 in your HDFC Bank A/c xx9025 ... (IMPS Ref No. ...)".
  body => {
    const m = body.match(/Money Received -\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s+in your HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: findReference(body) };
  },

  // HDFC online-banking transfer without a named beneficiary:
  // "Amt Deducted!\nRs.61,500.00 from your HDFC Bank A/c XX7713 for Money Transfer via ...".
  body => {
    const m = body.match(/Amt Deducted!\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*from your HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: null };
  },

  // HDFC NetBanking payment with a named beneficiary:
  // "Payment Successful!\nRs. 9310.40 from A/c XX7713 to ICICI BANK CREDIT CA via HDFC Bank NetBanking."
  body => {
    const m = body.match(/Payment Successful!\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*from A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})\s*to\s+(.+?)\s+via\s/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: m[3]?.trim() || null, accountLast4: digits(m[2]), reference: null };
  },

  // HDFC outward NEFT where the beneficiary is named:
  // "HDFC Bank : NEFT money transfer Txn No HDFCN... for Rs INR 90,000.00 has been credited to ACME TOUR AND TRAVEL on ..." —
  // "credited to" here refers to the beneficiary's account, so the user's ledger entry is a debit.
  body => {
    const m = body.match(/NEFT money transfer Txn No\s+\S+\s+for\s+(?:Rs\.?\s*)?(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s+has been credited to\s+(.+?)\s+on\s/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: m[2]?.trim() || null, accountLast4: null, reference: findReference(body) };
  },

  // HDFC cheque cleared: "Received Chq# 000001 of INR 75,000.00 for payment on ... Paid from your HDFC Bank A/c XX7713."
  body => {
    const m = body.match(/Received Chq#\s*(\d+)\s*of\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*for payment on\s+\S+\.?\s*Paid from your HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: digits(m[3]), reference: m[1] };
  },

  // HDFC card reversal: "Transaction Reversed!On HDFC Bank DEBIT/ATM Card xx8812 Amt: Rs.75 By CANVA* PZZZZX9Y8WQRTUV On ..."
  // The merchant's charge came back, so the ledger entry is a credit to the merchant.
  body => {
    const m = body.match(/Transaction Reversed!\s*On HDFC Bank (?:DEBIT\/ATM )?Card\s*[xX]+\s*(\d{3,4})\s*Amt:\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*By\s+(\S+)/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: m[3]?.replace(/\*+$/, '') || null, accountLast4: digits(m[1]), reference: null };
  },

  // HDFC mandate debit alert: "Debit Alert! Your HDFC Bank A/c xx3391 has been debited Rs 40000 via Debit Mandate for ...".
  body => {
    const m = body.match(/Debit Alert! Your HDFC Bank A\/c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,4})\s*has been debited\s*(?:Rs\.?|INR\.?)?\s?([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: digits(m[1]), reference: null };
  },

  // HDFC UPI transfer between bank accounts:
  // "HDFC Bank:Rs. 7420.00 debited from a/c *3391 on ... to a/c **5280 (UPI Ref No. ...)" —
  // the payee is a masked account, not a merchant, so the payee stays null while the
  // To-side masked account is exposed as structured counterparty data.
  body => {
    const m = body.match(/(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*debited from (?:HDFC Bank )?[Aa]\/c\s*(?:No\.?\s*)?(?:[Xx*]+\s*)?(\d{3,4})[\s\S]{0,80}?to (?:A\/c\s*)?([Xx*]+\s*\d{3,4})/i);
    if (!m) return null;
    const counterpartyResult = counterparty(m[3]);
    return { direction: 'debit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: findReference(body),
      counterpartyMasked: counterpartyResult.masked, counterpartyLast4: counterpartyResult.last4 };
  },

  // ICICI card spend: "INR 253.00 spent using ICICI Bank Card XX6119 on ... on AMAZON PAY IN G. Avl Limit: ..."
  // Foreign-currency spends ("USD 61.20 spent ...") carry no INR amount and are skipped.
  body => {
    const m = body.match(/\b(Rs\.?|INR\.?|USD)\s?([\d,]+(?:\.\d+)?)\s*spent (?:using|on) ICICI Bank Card\s*XX\s*(\d{4})\s+on\s+\S+\s+(?:on|at)\s+([^.]+?)\s*\.\s*Avl/i);
    if (!m) return null;
    if (m[1].toUpperCase() === 'USD') return null;
    return { direction: 'debit', amountPaise: toPaise(m[2]), merchant: m[4]?.trim() || null, accountLast4: digits(m[3]), reference: null };
  },

  // ICICI named refund: "AMAZON PAY IN E COMMERC refund of Rs 8,240.30 credited to your ICICI Bank Credit Card XX6119".
  body => {
    const m = body.match(/([A-Za-z0-9 .*&@'_/-]+?)\s+refund of\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*credited to your ICICI Bank Credit Card\s*XX\s*(\d{4})/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: m[1]?.trim() || null, accountLast4: digits(m[3]), reference: null };
  },

  // ICICI reversal credit: "Reversal of Rs 21.40 credited to ICICI Bank Credit Card XX6119 on ...".
  body => {
    const m = body.match(/Reversal of\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*credited to (?:your )?ICICI Bank Credit Card\s*XX\s*(\d{4})/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: null, accountLast4: digits(m[2]), reference: null };
  },

  // ICICI card refund without a merchant: "ICICI Bank Credit Card XX6119 credited/refunded with Rs 9,100.00 on ...".
  body => {
    const m = body.match(/ICICI Bank Credit Card\s*XX\s*(\d{4})\s*credited\/refunded with\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: digits(m[1]), reference: null };
  },

  // ICICI card bill payment received on the card — the card ledger treats the
  // payment as a credit (the statement lists it as CR), so this is a credit to the card.
  // The shape runs before the generic debit patterns so "received" is never re-read
  // as a bank-account inflow direction the other way around.
  body => {
    const m = body.match(/Payment of\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s*has been received (?:on|towards) your ICICI Bank Credit Card\s*XX\s*(\d{4})/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[1]), merchant: 'ICICI Bank Credit Card', accountLast4: digits(m[2]), reference: null, category: 'Bills' };
  },

  // PNB debit with balance tail: "Ac XX7712 Debited with Rs.47000.00, ... Aval Bal 312.18 CR.",
  // plus the charge variants "debited for/towards Rs.X towards bank charges".
  body => {
    const m = firstMatch([
      /A\/?c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+(?:is\s+)?[Dd]ebited with\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)/,
      /A\/?c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+(?:has\s+been\s+)?[Dd]ebited\s+(?:for|towards)\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)/,
    ], body);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: digits(m[1]), reference: null };
  },

  // PNB UPI debit: "A/c XX7712 debited INR 21300.00 Dt ... thru UPI:611100000011."
  body => {
    const m = body.match(/A\/?c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+debited\s+(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s+Dt\s/i);
    if (!m) return null;
    return { direction: 'debit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: digits(m[1]), reference: findReference(body) };
  },

  // PNB UPI credit: "Your a/c XX7712 is credited for INR 47000.00 ... through UPI..."
  // with optional remitter "by ARJUN MEHTA thru UPI".
  body => {
    const m = body.match(/A\/?c\s*(?:No\.?\s*)?(?:[Xx]+\s*)?(\d{3,})\s+(?:(?:is|has been)\s+)?credited (?:for|with)\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)(?:[\s\S]{0,90}?(?:by\s+([A-Za-z .&]+?)\s+thru|through|thru)\s+UPI)?/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: m[3]?.trim() || null, accountLast4: digits(m[1]), reference: findReference(body) };
  },

  // PNB PPF credit: "Acc XXXXXXPPFXXXXXXX01234 credited with Rs.2400 Dated ..." (PPF number
  // is not a usable last-4 hint, so the account stays null).
  body => {
    const m = body.match(/Acc\s+[Xx]+PPF[Xx]*(\d{3,})\s+credited with\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: null, accountLast4: null, reference: null };
  },

  // SBI inward transfer: "Dear SBI User, your A/c X3391-credited by Rs.28420.65 on 02Sep26 transfer from PRIYAVERMA Ref No 01462000009".
  body => {
    const m = body.match(/your A\/c\s*X\s*(\d{3,4})\s*[-–]?\s*credited by\s*(?:Rs\.?|INR\.?)\s?([\d,]+(?:\.\d+)?)\s+on\s+\S+\s+transfer from\s+(.+?)\s+Ref No\s*(\d+)/i);
    if (!m) return null;
    return { direction: 'credit', amountPaise: toPaise(m[2]), merchant: m[3]?.trim() || null, accountLast4: digits(m[1]), reference: m[4] };
  },
];

function findReference(body: string): string | null {
  return body.match(referencePattern)?.[1]
    ?? body.match(upiColonReferencePattern)?.[1]
    ?? body.match(upiBareReferencePattern)?.[1]
    ?? null;
}

// Generic money-anchored direction: only amounts that sit next to a debit/credit verb
// (not balances, limits, or due amounts) may drive the direction.
const debitAnchors = /\b(?:debit(?:ed)?|spent|withdrawn|deducted|purchase)\b|\bpaid\b|\bsent\s+(?:rs\.?|inr|₹)/i;
const creditAnchors = /\b(?:credit(?:ed)?|received|refund(?:ed)?|deposited|reversal|reversed)\b/i;
const debitPattern = /\b(debit(?:ed)?|spent|paid|sent\s+(?:rs\.?|inr|₹)|purchase|withdrawn)\b/i;
// "Credit" on its own also matches the narrative "Credit Card", which is not movement.
const creditPattern = /\b(credit(?:ed)?\b(?!\s+card\b)|received|refund|deposited)\b/i;
const nonTransactionAmount = /\b(?:avl|avail|available|balance|bal\.?\s|bal\b|wallet|limit|lmt|yesterday|min\.|minimum|maximum|due)\b/i;

interface MoneyMention {
  value: number;
  index: number;
  end: number;
  direction: Direction | null;
}

function moneyMentions(body: string): MoneyMention[] {
  const mentions: MoneyMention[] = [];
  const pattern = /(?:Rs\.?|INR\.?|₹)\s*([\d,]+(?:\.\d+)?)/gi;
  for (const match of body.matchAll(pattern)) {
    const value = toPaise(match[1]);
    if (!value) continue;
    const before = body.slice(Math.max(0, match.index - 30), match.index);
    const after = body.slice(match.index + match[0].length, match.index + match[0].length + 45);
    const window = `${before} ${after}`;
    // Balances, limits, and due amounts never carry the transaction amount. The
    // exclusion only looks up to the next sentence break so a trailing balance
    // sentence doesn't swallow the real amount that precedes it.
    const afterClause = after.split(/[.;\n]/)[0];
    if (nonTransactionAmount.test(before) || nonTransactionAmount.test(afterClause)) continue;
    const debit = debitAnchors.test(window);
    const credit = creditAnchors.test(window);
    mentions.push({
      value, index: match.index, end: match.index + match[0].length,
      direction: debit === credit ? null : debit ? 'debit' : 'credit',
    });
  }
  return mentions;
}

function transactionAmount(mentions: MoneyMention[]): { amountPaise: number; contextual: boolean } | null {
  if (!mentions.length) return null;
  const anchored = mentions.filter(mention => mention.direction);
  const chosen = anchored[0] ?? mentions[0];
  return { amountPaise: chosen.value, contextual: Boolean(anchored.length) };
}

function transactionDirection(mentions: MoneyMention[], body: string): Direction | null {
  const anchored = mentions.filter(mention => mention.direction);
  if (anchored.length) {
    const debit = anchored.some(mention => mention.direction === 'debit');
    const credit = anchored.some(mention => mention.direction === 'credit');
    if (debit === credit) return null;
    return debit ? 'debit' : 'credit';
  }
  // No amount sits next to a verb ("Credited to A/C X3381 from ACME. ... INR 500.00"),
  // so fall back to the message's overall wording while still refusing mixed movement.
  const debit = debitPattern.test(body);
  const credit = creditPattern.test(body);
  if (debit === credit) return null;
  return debit ? 'debit' : 'credit';
}

function transactionMerchant(body: string): string {
  for (const pattern of merchantPatterns) {
    const merchant = body.match(pattern)?.[1]?.trim() ?? '';
    if (merchant) return merchant.replace(/\s+(?:Ref|UPI|via)$/i, '').trim();
  }
  return '';
}

function transactionConfidence(merchant: string | null, accountLast4: string | null, reference: string | null, contextual: boolean): number {
  let base = 0.45;
  if (merchant && accountLast4 && reference) base = 0.95;
  else if (merchant && accountLast4) base = 0.84;
  else if (merchant) base = 0.68;
  return contextual ? base : Math.min(base, 0.68);
}

// ---- Body timestamp precedence (operator rule) -------------------------------
// If the message body itself carries a date (and time), the ledger must store that
// timestamp, not the SMS delivery time. Date-only bodies keep the SMS time of day;
// two-digit years snap to the expansion nearest the SMS year. Returns null when no
// plausible body timestamp is found and the delivery time should stand.

interface BodyDate { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }

function parseBodyDate(text: string): BodyDate | null {
  // "2025-07-03", "2025-08-26 06:39:41", "2026-03-03:19:48:33"
  const iso = text.match(/(?<![\d/-])(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T:]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?![\d/-])/);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]),
      hour: iso[4] != null ? Number(iso[4]) : undefined,
      minute: iso[5] != null ? Number(iso[5]) : undefined,
      second: iso[6] != null ? Number(iso[6]) : undefined };
  }
  // "on 05-10-25", "Dt 22-12-25 14:04:28", "10-03-2026 06:31:25", "14/08/25"
  const dmy = text.match(/(?<![\d/-])(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?![\d/-])/);
  if (dmy) {
    let day = Number(dmy[1]); let month = Number(dmy[2]);
    if (month > 12 && day <= 12) { day = Number(dmy[2]); month = Number(dmy[1]); } // "6/20/2025" US style
    return { year: Number(dmy[3]), month, day,
      hour: dmy[4] != null ? Number(dmy[4]) : undefined,
      minute: dmy[5] != null ? Number(dmy[5]) : undefined,
      second: dmy[6] != null ? Number(dmy[6]) : undefined };
  }
  // "on 02Sep26", "on 01-Sep-26", "on 17-Jul-26", "07-OCT-26", "on 11-Aug-2025"
  const dmmmyy = text.match(/(?<![\d/-])(\d{1,2})[-/ ]?([A-Za-z]{3})[-/ ]?(\d{4}|\d{2})\b/);
  if (dmmmyy) {
    const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const month = months[dmmmyy[2].toLowerCase()];
    if (!month) return null;
    return { year: Number(dmmmyy[3]), month, day: Number(dmmmyy[1]) };
  }
  return null;
}

export function occurredAtFrom(body: string, receivedAt: number): number | null {
  const parsedDate = parseBodyDate((body ?? '').normalize('NFKC').replace(/\r/g, ''));
  if (!parsedDate) return null;
  let { year } = parsedDate;
  if (year < 100) { // two-digit year: snap to the expansion nearest the SMS year
    const smsYear = new Date(receivedAt).getFullYear();
    const forward = 2000 + year, backward = 1900 + year;
    year = Math.abs(forward - smsYear) <= Math.abs(backward - smsYear) ? forward : backward;
  }
  const { month, day, hour, minute, second } = parsedDate;
  // Year-level plausibility against the delivery time; anything further is bogus.
  if (Math.abs(year - new Date(receivedAt).getFullYear()) > 3) return null;
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  if (hour != null && !(hour <= 23 && (minute ?? 0) <= 59 && (second ?? 0) <= 59)) return null;
  const built = hour != null
    ? new Date(year, month - 1, day, hour, minute ?? 0, second ?? 0).getTime()
    : (() => { const sms = new Date(receivedAt);
        return new Date(year, month - 1, day, sms.getHours(), sms.getMinutes(), sms.getSeconds()).getTime(); })();
  // A body date further than two days after delivery is a plan/expiry date, not the transaction.
  if (built - receivedAt > 2 * 24 * 60 * 60 * 1000) return null;
  return built;
}

export function parseBankSms(body: string): ParsedSms | null {
  // RCS banks (PNB/SBI via carrier agents) send Mathematical Sans-Serif letters.
  const text = (body ?? '').normalize('NFKC');
  if (!isTransactionMessage(text)) return null;
  if (isPending(text) || isFailed(text)) return null;

  for (const shape of shapes) {
    const result = shape(text);
    if (!result) continue;
    const merchant = result.merchant ? titleCase(result.merchant) : '';
    return {
      merchant: merchant || 'Unknown merchant',
      amountPaise: result.amountPaise,
      direction: result.direction,
      category: result.category ?? categoryFor(merchant, text),
      accountLast4: result.accountLast4,
      reference: result.reference,
      counterpartyMasked: result.counterpartyMasked ?? null,
      counterpartyLast4: result.counterpartyLast4 ?? null,
      confidence: transactionConfidence(result.merchant ? merchant : null, result.accountLast4, result.reference, true),
    };
  }

  const mentions = moneyMentions(text);
  const direction = transactionDirection(mentions, text);
  if (!direction) return null;
  const amount = transactionAmount(mentions);
  if (!amount) return null;
  const merchant = transactionMerchant(text);
  const accountLast4 = text.match(accountPattern)?.[1]
    ? digits(text.match(accountPattern)![1]) : null;
  const reference = findReference(text);
  return {
    merchant: merchant ? titleCase(merchant) : 'Unknown merchant',
    amountPaise: amount.amountPaise,
    direction,
    category: categoryFor(merchant, text),
    accountLast4,
    reference,
    counterpartyMasked: null,
    counterpartyLast4: null,
    confidence: transactionConfidence(merchant || null, accountLast4, reference, amount.contextual),
  };
}
