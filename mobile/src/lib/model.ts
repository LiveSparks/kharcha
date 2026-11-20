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
];

export const DEFAULT_PREFERENCES: Preferences = {
  onboardingDone: false,
  readSms: false,
  autoAdd: true,
  lastScanAt: 0,
};
