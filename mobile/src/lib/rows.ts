import type { Account, Budget, Category, Payee, RestorableStatus, Schedule, SenderRule, Transaction, UnparsedMessage } from './model';

// Storage-shaped rows (snake_case, one key per column). SQLite returns these, backup
// snapshot schema 2 carries them verbatim, and the web preview stores them, so a row
// survives every round trip with all of its columns.

export type SqlValue = string | number | null;

export interface TransactionRow {
  id: string;
  source_hash: string | null;
  sender: string | null;
  raw_body: string | null;
  occurred_at: number;
  merchant: string;
  amount_paise: number;
  direction: Transaction['direction'];
  category: Category;
  status: Transaction['status'];
  account_last4: string | null;
  counterparty_last4: string | null;
  reference: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
  // v2
  account_id: string | null;
  payee_id: string | null;
  payee_override_id: string | null;
  counterparty_masked: string | null;
  category_by_user: number;
  // v3
  duplicate_of: string | null;
  pre_flag_status: RestorableStatus | null;
  duplicate_cleared: number;
  // v4
  reported_balance_paise: number | null;
  reported_avl_limit_paise: number | null;
}

export interface AccountRow {
  id: string; bank: string; last4: string; kind: Account['kind']; funded_by: string | null;
  name: string | null; created_at: number;
  // v4 (absent on rows written before it)
  opening_balance_paise?: number | null; opening_balance_at?: number | null; credit_limit_paise?: number | null;
}

export interface PayeeRow {
  id: string; kind: Payee['kind']; bank: string; key: string; masked: string | null;
  name: string | null; category: Category | null; nudged_at: number | null; created_at: number;
  habit_hidden?: number;
}

export interface UnparsedRow {
  id: string; source_hash: string; sender: string; raw_body: string; received_at: number;
  amount_paise: number | null; status: UnparsedMessage['status']; transaction_id: string | null; created_at: number;
}

// a_id < b_id, so a pair has one spelling.
export interface DismissalRow { a_id: string; b_id: string; created_at: number }

// Schedules (P4).
export interface ScheduleRow {
  id: string; payee_id: string; account_id: string | null; direction: Schedule['direction']; interval: Schedule['interval'];
  anchor_day: number; anchor_month: number | null; amount_min: number; amount_max: number; last_paid_at: number | null;
  status: Schedule['status']; created_at: number; decided_at: number;
}

export interface BudgetRow { category: Category; amount_paise: number }
export interface SenderRow { address: string; label: string; enabled: number }
export interface PreferenceRow { key: string; value: string }

export function transactionFromRow(row: TransactionRow): Transaction {
  return {
    id: row.id, sourceHash: row.source_hash, sender: row.sender, rawBody: row.raw_body,
    occurredAt: row.occurred_at, merchant: row.merchant, amountPaise: row.amount_paise,
    direction: row.direction, category: row.category, status: row.status,
    accountLast4: row.account_last4, counterpartyMasked: row.counterparty_masked ?? null,
    counterpartyLast4: row.counterparty_last4, reference: row.reference, confidence: row.confidence,
    createdAt: row.created_at, updatedAt: row.updated_at,
    accountId: row.account_id ?? null, payeeId: row.payee_id ?? null,
    payeeOverrideId: row.payee_override_id ?? null, categoryByUser: !!row.category_by_user,
    duplicateOf: row.duplicate_of ?? null, preFlagStatus: row.pre_flag_status ?? null,
    duplicateCleared: !!row.duplicate_cleared,
    reportedBalancePaise: row.reported_balance_paise ?? null, reportedAvlLimitPaise: row.reported_avl_limit_paise ?? null,
  };
}

export function transactionToRow(t: Transaction): TransactionRow {
  return {
    id: t.id, source_hash: t.sourceHash, sender: t.sender, raw_body: t.rawBody,
    occurred_at: t.occurredAt, merchant: t.merchant, amount_paise: t.amountPaise,
    direction: t.direction, category: t.category, status: t.status,
    account_last4: t.accountLast4, counterparty_last4: t.counterpartyLast4, reference: t.reference,
    confidence: t.confidence, created_at: t.createdAt, updated_at: t.updatedAt,
    account_id: t.accountId ?? null, payee_id: t.payeeId ?? null,
    payee_override_id: t.payeeOverrideId ?? null, counterparty_masked: t.counterpartyMasked ?? null,
    category_by_user: t.categoryByUser ? 1 : 0,
    duplicate_of: t.duplicateOf ?? null, pre_flag_status: t.preFlagStatus ?? null,
    duplicate_cleared: t.duplicateCleared ? 1 : 0,
    reported_balance_paise: t.reportedBalancePaise ?? null, reported_avl_limit_paise: t.reportedAvlLimitPaise ?? null,
  };
}

export function accountFromRow(row: AccountRow): Account {
  return {
    id: row.id, bank: row.bank, last4: row.last4, kind: row.kind, fundedBy: row.funded_by, name: row.name, createdAt: row.created_at,
    openingBalancePaise: row.opening_balance_paise ?? null, openingBalanceAt: row.opening_balance_at ?? null, creditLimitPaise: row.credit_limit_paise ?? null,
  };
}

export function payeeFromRow(row: PayeeRow): Payee {
  return {
    id: row.id, kind: row.kind, bank: row.bank, key: row.key, masked: row.masked, name: row.name,
    category: row.category, nudgedAt: row.nudged_at, createdAt: row.created_at, habitHidden: !!row.habit_hidden,
  };
}

export function unparsedFromRow(row: UnparsedRow): UnparsedMessage {
  return {
    id: row.id, sourceHash: row.source_hash, sender: row.sender, rawBody: row.raw_body, receivedAt: row.received_at,
    amountPaise: row.amount_paise, status: row.status, transactionId: row.transaction_id, createdAt: row.created_at,
  };
}

export function unparsedToRow(m: UnparsedMessage): UnparsedRow {
  return {
    id: m.id, source_hash: m.sourceHash, sender: m.sender, raw_body: m.rawBody, received_at: m.receivedAt,
    amount_paise: m.amountPaise, status: m.status, transaction_id: m.transactionId, created_at: m.createdAt,
  };
}

export function scheduleFromRow(row: ScheduleRow): Schedule {
  return {
    id: row.id, payeeId: row.payee_id, accountId: row.account_id, direction: row.direction, interval: row.interval,
    anchorDay: row.anchor_day, anchorMonth: row.anchor_month, amountMin: row.amount_min, amountMax: row.amount_max,
    lastPaidAt: row.last_paid_at, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at,
  };
}

export function scheduleToRow(s: Schedule): ScheduleRow {
  return {
    id: s.id, payee_id: s.payeeId, account_id: s.accountId, direction: s.direction, interval: s.interval,
    anchor_day: s.anchorDay, anchor_month: s.anchorMonth, amount_min: s.amountMin, amount_max: s.amountMax,
    last_paid_at: s.lastPaidAt, status: s.status, created_at: s.createdAt, decided_at: s.decidedAt,
  };
}

export function budgetFromRow(row: BudgetRow): Budget { return { category: row.category, amountPaise: row.amount_paise }; }
export function senderFromRow(row: SenderRow): SenderRule { return { address: row.address, label: row.label, enabled: !!row.enabled }; }

// v1 transaction columns, in table order. Schema-1 snapshots carry camelCase objects.
export const V1_TRANSACTION_COLUMNS = [
  'id', 'source_hash', 'sender', 'raw_body', 'occurred_at', 'merchant', 'amount_paise', 'direction',
  'category', 'status', 'account_last4', 'counterparty_last4', 'reference', 'confidence', 'created_at', 'updated_at',
] as const;

export function v1TransactionRow(t: Pick<Transaction, 'id' | 'sourceHash' | 'sender' | 'rawBody' | 'occurredAt' | 'merchant' | 'amountPaise' | 'direction' | 'category' | 'status' | 'accountLast4' | 'counterpartyLast4' | 'reference' | 'confidence' | 'createdAt' | 'updatedAt'>): Record<typeof V1_TRANSACTION_COLUMNS[number], SqlValue> {
  return {
    id: t.id, source_hash: t.sourceHash, sender: t.sender, raw_body: t.rawBody, occurred_at: t.occurredAt,
    merchant: t.merchant, amount_paise: t.amountPaise, direction: t.direction, category: t.category,
    status: t.status, account_last4: t.accountLast4, counterparty_last4: t.counterpartyLast4,
    reference: t.reference, confidence: t.confidence, created_at: t.createdAt, updated_at: t.updatedAt,
  };
}
