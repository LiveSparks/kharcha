export const CATEGORIES = [
  'Food & dining', 'Groceries', 'Travel', 'Bills', 'Shopping',
  'Health', 'Entertainment', 'Transfers',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Direction = 'debit' | 'credit';
export type TransactionStatus = 'auto' | 'review' | 'duplicate_review' | 'ignored' | 'manual';

export interface Transaction {
  id: string;
  sourceHash: string | null;
  sender: string | null;
  rawBody: string | null;
  occurredAt: number;
  merchant: string;
  amountPaise: number;
  direction: Direction;
  category: Category;
  status: TransactionStatus;
  accountLast4: string | null;
  // Masked counterparty account when the bank hides the other side ("to a/c **5280").
  counterpartyMasked: string | null;
  counterpartyLast4: string | null;
  reference: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  // Identity (schema v2). Resolved at ingest; names and categories resolve on read.
  accountId: string | null;
  payeeId: string | null;
  // Per-row reassignment ("Move this one"); wins over payeeId.
  payeeOverrideId: string | null;
  // The user picked this row's category, so the payee default doesn't apply.
  categoryByUser: boolean;
}

export type AccountKind = 'bank' | 'credit_card' | 'debit_card' | 'unknown';

export interface Account {
  id: string;
  bank: string;
  last4: string;
  kind: AccountKind;
  fundedBy: string | null;
  name: string | null;
  createdAt: number;
}

export type PayeeKind = 'merchant' | 'masked';

export interface Payee {
  id: string;
  kind: PayeeKind;
  bank: string;
  key: string;
  // Masked payee: verbatim mask ("**5280"). Merchant payee: first-seen merchant string.
  masked: string | null;
  name: string | null;
  category: Category | null;
  nudgedAt: number | null;
  createdAt: number;
}

export interface Budget {
  category: Category;
  amountPaise: number;
}

export interface SenderRule {
  address: string;
  label: string;
  enabled: boolean;
}

export interface Preferences {
  onboardingDone: boolean;
  readSms: boolean;
  autoAdd: boolean;
  lastScanAt: number;
}

export const DEFAULT_SENDERS: SenderRule[] = [
  { address: 'HDFCBK', label: 'HDFC Bank', enabled: true },
  { address: 'VM-SBIUPI', label: 'SBI · UPI', enabled: true },
  { address: 'AX-ICICIT', label: 'ICICI Bank', enabled: true },
  { address: 'PNBSMS', label: 'PNB', enabled: true },
];

export const DEFAULT_PREFERENCES: Preferences = {
  onboardingDone: false,
  readSms: false,
  autoAdd: true,
  lastScanAt: 0,
};
