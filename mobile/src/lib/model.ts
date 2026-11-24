export const CATEGORIES = [
  'Food & dining', 'Groceries', 'Travel', 'Bills', 'Shopping',
  'Health', 'Entertainment', 'Transfers',
] as const;

// The built-in categories: what the parser assigns and what a new ledger starts with.
// Since schema v9 the list is the user's (categories table); a category is any name in it.
export type Category = string;
export const TRANSFERS: Category = 'Transfers';

export const BUILT_IN_COLORS: Record<string, string> = {
  'Food & dining': '#F08A52', Groceries: '#84C06C', Travel: '#6FB1DE', Bills: '#B39AD6',
  Shopping: '#EC86AE', Health: '#5FCFC0', Entertainment: '#E2C056', Transfers: '#A9A495',
};
// Colours a new category can take (the built-ins' plus a few more).
export const CATEGORY_SWATCHES = ['#F08A52', '#84C06C', '#6FB1DE', '#B39AD6', '#EC86AE', '#5FCFC0', '#E2C056', '#A9A495', '#E0685F', '#7C8CE0', '#C9A27A', '#9BCB4F'] as const;

export interface CategoryDef {
  name: Category;
  color: string;
  position: number;
  // A deleted category points at the one its rows moved to; new reads follow it.
  mergedInto: Category | null;
}
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
  // Transfers (schema v8): the other of your own accounts this money moved to or from.
  // A debit moves accountId → transferAccountId; a credit moves transferAccountId → accountId.
  transferAccountId: string | null;
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
  // *Not a habit* (schema v6, P5): the payee's group never shows as a Habit.
  habitHidden: boolean;
}

// Schedules (P4, WF-6). Only decisions are stored: a confirmed Schedule's terms, or a
// "Not a schedule" dismissal. Suggestions, matches and states are computed on read.
export type ScheduleInterval = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly';
export type ScheduleStatus = 'active' | 'ended' | 'dismissed';

export interface Schedule {
  id: string;
  // Representative payee; the payee group (same display name) is resolved on read.
  payeeId: string;
  accountId: string | null;
  direction: Direction;
  interval: ScheduleInterval;
  // Day of month (monthly/quarterly) or weekday 0-6, Sunday = 0 (weekly/fortnightly).
  anchorDay: number;
  // Quarterly phase 1-3 (Jan/Apr/Jul/Oct = 1); null otherwise.
  anchorMonth: number | null;
  amountMin: number;
  amountMax: number;
  // Where the read-time walk starts. Matches never write it back.
  lastPaidAt: number | null;
  status: ScheduleStatus;
  createdAt: number;
  decidedAt: number;
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
  { address: 'HDFCBN', label: 'HDFC Bank · UPI', enabled: true },
  { address: 'SBIUPI', label: 'SBI · UPI', enabled: true },
  { address: 'ICICIT', label: 'ICICI Bank', enabled: true },
  { address: 'PNBSMS', label: 'PNB', enabled: true },
];

export const DEFAULT_PREFERENCES: Preferences = {
  onboardingDone: false,
  readSms: false,
  autoAdd: true,
  lastScanAt: 0,
};
