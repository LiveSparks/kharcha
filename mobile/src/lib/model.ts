export const CATEGORIES = [
  'Food & dining', 'Groceries', 'Travel', 'Bills', 'Shopping',
  'Health', 'Entertainment', 'Transfers',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Direction = 'debit' | 'credit';
export type TransactionStatus = 'auto' | 'review' | 'duplicate_review' | 'ignored' | 'manual' | 'merged';
// The status a flagged or merged row returns to (Keep both / Unmerge).
export type RestorableStatus = 'auto' | 'review' | 'manual';

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
  // Duplicate review (schema v3). duplicate_review: the earlier partner; merged: the survivor.
  duplicateOf: string | null;
  preFlagStatus: RestorableStatus | null;
  // Set by Keep both / Unmerge (informational; the pair table stops re-flagging).
  duplicateCleared: boolean;
  // Balances (schema v4): what the bank says after this transaction (WF-4 anchors).
  reportedBalancePaise: number | null;
  reportedAvlLimitPaise: number | null;
}

// Defaults for a row that was never flagged.
export const NOT_A_DUPLICATE = { duplicateOf: null, preFlagStatus: null, duplicateCleared: false } as const;
// Defaults for a row with no stated balance or limit (manual entries, v1 rows).
export const NO_FIGURES = { reportedBalancePaise: null, reportedAvlLimitPaise: null } as const;

export type UnparsedStatus = 'pending' | 'added' | 'dismissed';

// An allowed-sender SMS the parser rejected but that reads like a transaction ("Couldn't read").
export interface UnparsedMessage {
  id: string;
  sourceHash: string;
  sender: string;
  rawBody: string;
  receivedAt: number;
  amountPaise: number | null;
  status: UnparsedStatus;
  transactionId: string | null;
  createdAt: number;
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
  // Balances (schema v4). Opening balance: a user-entered anchor for an account that never
  // states its balance. Credit limit: entered once for a card.
  openingBalancePaise: number | null;
  openingBalanceAt: number | null;
  creditLimitPaise: number | null;
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
