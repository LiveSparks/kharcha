import { DEFAULT_PREFERENCES, DEFAULT_SENDERS, NOT_A_DUPLICATE } from './model';
import type { Account, Budget, Category, Payee, Preferences, Schedule, SenderRule, Transaction, TransactionStatus, UnparsedMessage } from './model';
import { DUPLICATE_WINDOW_MS, applyPatch, flagDuplicates, keepBothDecision, mergeDecision, pairKey, relinkLegacyFlags, unmergeDecision } from './duplicates';
import type { DuplicateDecision } from './duplicates';
import { mergeAccountKind } from './banks';
import { identityFor, overrideKey } from './identity';
import type { AccountIdentity, PayeeIdentity } from './identity';
import { LATEST_VERSION } from './migrations';
import { parseBankSms, reportedFigures } from './parser';
import { validateSnapshot, validPaise } from './ledger';
import type { IngestResult, MoveTarget, ScanBatch, ScheduleTerms, Snapshot, SnapshotV1, SnapshotV2 } from './ledger';
import { validateName } from './resolve';
import { accountFromRow, budgetFromRow, payeeFromRow, scheduleFromRow, scheduleToRow, senderFromRow, transactionFromRow, transactionToRow, unparsedFromRow } from './rows';
import { validateTerms } from './schedules';
import type { AccountRow, PayeeRow, TransactionRow } from './rows';

export type { IngestResult, MoveTarget, ScanBatch, ScheduleTerms, Snapshot } from './ledger';

// Web preview: the ledger lives in localStorage in the backup snapshot schema-2 shape
// (storage rows, every column), so a web export restores on Android and back. The v1
// key is migrated forward on first read with the same identity rules as v1→v2.
const KEY = 'kharcha.browser-ledger.v2';
const V1_KEY = 'kharcha.browser-ledger.v1';

function empty(): SnapshotV2 {
  return {
    schema: 2, schemaVersion: LATEST_VERSION, transactions: [], budgets: [],
    senders: DEFAULT_SENDERS.map(s => ({ address: s.address, label: s.label, enabled: Number(s.enabled) })),
    preferences: [], accounts: [], payees: [], unparsed_messages: [], duplicate_dismissals: [], schedules: [], exportedAt: 0,
  };
}

// The web twin of the migrations after v2: v3 adds the duplicate columns (defaults on
// read) and links legacy flags the same way v2→v3 does; the schedules step adds an
// empty table.
function upgrade(s: SnapshotV2): SnapshotV2 {
  if (s.schemaVersion >= LATEST_VERSION) return s;
  const out: SnapshotV2 = { ...s, unparsed_messages: s.unparsed_messages ?? [], duplicate_dismissals: s.duplicate_dismissals ?? [], schedules: s.schedules ?? [], schemaVersion: LATEST_VERSION };
  if (s.schemaVersion < 3) {
    const autoAddPref = s.preferences.find(p => p.key === 'autoAdd');
    const autoAdd = autoAddPref ? JSON.parse(autoAddPref.value) !== false : true;
    const rows = out.transactions.map(transactionFromRow);
    const byIdMap = new Map(rows.map(t => [t.id, t]));
    for (const patch of relinkLegacyFlags(rows, autoAdd)) byIdMap.set(patch.id, applyPatch(byIdMap.get(patch.id)!, patch, byIdMap.get(patch.id)!.updatedAt));
    out.transactions = rows.map(t => transactionToRow(byIdMap.get(t.id)!));
  }
  if (s.schemaVersion < 4) {
    // v3 → v4 twin: re-read stated balances/limits from stored messages.
    out.transactions = out.transactions.map(r => {
      const parsed = r.raw_body ? parseBankSms(r.raw_body) : null;
      return { ...r, reported_balance_paise: parsed?.reportedBalancePaise ?? null, reported_avl_limit_paise: parsed?.reportedAvlLimitPaise ?? null };
    });
    out.accounts = out.accounts.map(a => ({ opening_balance_paise: null, opening_balance_at: null, credit_limit_paise: null, ...a }));
  }
  return out;
}

function preferenceRows(preferences: Partial<Preferences>): SnapshotV2['preferences'] {
  return Object.entries(preferences).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
}

function upsertAccount(s: SnapshotV2, a: AccountIdentity, now: number): string {
  const existing = s.accounts.find(row => row.bank === a.bank && row.last4 === a.last4);
  if (!existing) { s.accounts.push({ id: a.id, bank: a.bank, last4: a.last4, kind: a.kind, funded_by: null, name: null, created_at: now, opening_balance_paise: null, opening_balance_at: null, credit_limit_paise: null }); return a.id; }
  existing.kind = mergeAccountKind(existing.kind, a.kind);
  return existing.id;
}

function upsertPayee(s: SnapshotV2, p: PayeeIdentity, now: number): string {
  const existing = s.payees.find(row => row.kind === p.kind && row.bank === p.bank && row.key === p.key);
  if (existing) return existing.id;
  s.payees.push({ id: p.id, kind: p.kind, bank: p.bank, key: p.key, masked: p.masked, name: null, category: null, nudged_at: null, created_at: now });
  return p.id;
}

// The web twin of migrations v1→v2.
function fromV1(v1: SnapshotV1): SnapshotV2 {
  const s: SnapshotV2 = { ...empty(), schemaVersion: 2, transactions: [], senders: [], preferences: preferenceRows(v1.preferences ?? {}), exportedAt: v1.exportedAt };
  s.budgets = v1.budgets.map(b => ({ category: b.category, amount_paise: b.amountPaise }));
  s.senders = v1.senders.map(r => ({ address: r.address, label: r.label, enabled: Number(r.enabled) }));
  const ordered = [...v1.transactions].sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const t of ordered) {
    const counterpartyMasked = t.rawBody ? parseBankSms(t.rawBody)?.counterpartyMasked ?? null : null;
    const { account, payee } = identityFor({ ...t, counterpartyMasked });
    s.transactions.push(transactionToRow({
      ...t, counterpartyMasked,
      accountId: account ? upsertAccount(s, account, t.createdAt) : null,
      payeeId: payee ? upsertPayee(s, payee, t.createdAt) : null,
      payeeOverrideId: null, categoryByUser: t.status === 'manual', ...NOT_A_DUPLICATE,
      ...reportedFigures(t.rawBody ?? '', t.accountLast4),
    }));
  }
  return s;
}

function read(): SnapshotV2 {
  const stored = localStorage.getItem(KEY);
  if (stored) {
    const value = validateSnapshot(JSON.parse(stored));
    if (value.schema !== 2) throw new Error('Browser ledger format is not supported.');
    if (value.schemaVersion < LATEST_VERSION) { const upgraded = upgrade(value); write(upgraded); return upgraded; }
    return value;
  }
  const legacy = localStorage.getItem(V1_KEY);
  if (!legacy) return empty();
  const value = validateSnapshot(JSON.parse(legacy));
  const migrated = upgrade(value.schema === 1 ? fromV1(value) : value);
  write(migrated);
  return migrated;
}

function write(snapshot: SnapshotV2): void {
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

function update(change: (s: SnapshotV2) => void): void {
  const snapshot = read();
  change(snapshot);
  write(snapshot);
}

function row(s: SnapshotV2, id: string): TransactionRow {
  const item = s.transactions.find(t => t.id === id);
  if (!item) throw new Error('Entry not found.');
  return item;
}

export async function getDatabase(): Promise<void> { read(); }

export async function listTransactions(): Promise<Transaction[]> {
  return read().transactions.map(transactionFromRow).sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt);
}
export async function listAccounts(): Promise<Account[]> {
  return read().accounts.map(accountFromRow).sort((a, b) => a.bank.localeCompare(b.bank) || a.last4.localeCompare(b.last4));
}
export async function listPayees(): Promise<Payee[]> {
  return read().payees.map(payeeFromRow).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function addTransaction(transaction: Transaction): Promise<boolean> {
  const snapshot = read();
  if (snapshot.transactions.some(item => item.id === transaction.id || !!transaction.sourceHash && item.source_hash === transaction.sourceHash)) return false;
  const { account, payee } = identityFor(transaction);
  snapshot.transactions.push(transactionToRow({
    ...transaction,
    accountId: account ? upsertAccount(snapshot, account, transaction.createdAt) : transaction.sender ? null : transaction.accountId ?? null,
    payeeId: payee ? upsertPayee(snapshot, payee, transaction.createdAt) : null,
    payeeOverrideId: null,
  }));
  write(snapshot);
  return true;
}

export async function setTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const keepLink = status === 'duplicate_review' || status === 'merged';
  update(s => {
    const t = row(s, id);
    Object.assign(t, { status, updated_at: Date.now() }, keepLink ? {} : { duplicate_of: null, pre_flag_status: null });
  });
}

export async function listUnparsed(): Promise<UnparsedMessage[]> {
  return (read().unparsed_messages ?? []).map(unparsedFromRow).sort((a, b) => b.receivedAt - a.receivedAt);
}

// Same steps as ingestScanSql. The web build has no SMS, so this only sees pasted messages.
export async function ingestScan(batch: ScanBatch): Promise<IngestResult> {
  const result: IngestResult = { added: 0, flagged: 0, unparsed: 0 };
  update(s => {
    const hashes = new Set(s.transactions.map(t => t.source_hash).filter(Boolean));
    const ids = new Set(s.transactions.map(t => t.id));
    const fresh: Transaction[] = [];
    for (const t of batch.transactions) {
      if (ids.has(t.id) || t.sourceHash && hashes.has(t.sourceHash)) continue;
      if (t.sourceHash) hashes.add(t.sourceHash);
      const { account, payee } = identityFor(t);
      fresh.push({ ...t, payeeOverrideId: null,
        accountId: account ? upsertAccount(s, account, t.createdAt) : null,
        payeeId: payee ? upsertPayee(s, payee, t.createdAt) : null });
    }
    if (fresh.length) {
      const since = Math.min(...fresh.map(t => t.occurredAt)) - DUPLICATE_WINDOW_MS;
      const existing = s.transactions.map(transactionFromRow)
        .filter(t => t.occurredAt >= since && ['auto', 'review', 'manual', 'duplicate_review'].includes(t.status));
      const dismissed = new Set((s.duplicate_dismissals ?? []).map(d => pairKey(d.a_id, d.b_id)));
      for (const t of flagDuplicates(fresh, existing, dismissed)) {
        s.transactions.push(transactionToRow(t));
        result.added++;
        if (t.status === 'duplicate_review') result.flagged++;
      }
    }
    s.unparsed_messages ??= [];
    for (const m of batch.unparsed) {
      if (s.unparsed_messages.some(u => u.source_hash === m.sourceHash)) continue;
      s.unparsed_messages.push({ id: m.id, source_hash: m.sourceHash, sender: m.sender, raw_body: m.rawBody, received_at: m.receivedAt,
        amount_paise: m.amountPaise, status: 'pending', transaction_id: null, created_at: Date.now() });
      result.unparsed++;
    }
  });
  return result;
}

function decide(choose: (rows: Map<string, Transaction>) => DuplicateDecision): void {
  update(s => {
    const rows = new Map(s.transactions.map(t => [t.id, transactionFromRow(t)]));
    const { patches, dismiss } = choose(rows);
    const now = Date.now();
    for (const patch of patches) {
      const i = s.transactions.findIndex(t => t.id === patch.id);
      s.transactions[i] = transactionToRow(applyPatch(rows.get(patch.id)!, patch, now));
    }
    if (dismiss) {
      s.duplicate_dismissals ??= [];
      if (!s.duplicate_dismissals.some(d => d.a_id === dismiss[0] && d.b_id === dismiss[1])) s.duplicate_dismissals.push({ a_id: dismiss[0], b_id: dismiss[1], created_at: now });
    }
  });
}

export async function mergeDuplicate(flaggedId: string, survivorId: string): Promise<void> { decide(rows => mergeDecision(rows, flaggedId, survivorId)); }
export async function keepBoth(id: string): Promise<void> { decide(rows => keepBothDecision(rows, id)); }
export async function unmerge(id: string): Promise<void> { decide(rows => unmergeDecision(rows, id)); }

function unparsedRow(s: SnapshotV2, id: string) {
  const m = (s.unparsed_messages ?? []).find(u => u.id === id);
  if (!m) throw new Error('Message not found.');
  return m;
}
export async function linkUnparsed(id: string, transactionId: string): Promise<void> {
  update(s => { const m = unparsedRow(s, id); if (m.status === 'pending') Object.assign(m, { status: 'added', transaction_id: transactionId }); });
}
export async function dismissUnparsed(id: string): Promise<void> {
  update(s => Object.assign(unparsedRow(s, id), { status: 'dismissed', raw_body: '' }));
}
export async function setTransactionCategory(id: string, category: Category): Promise<void> {
  update(s => Object.assign(row(s, id), { category, category_by_user: 1, updated_at: Date.now() }));
}

export async function movePayee(id: string, target: MoveTarget): Promise<string> {
  let result = '';
  update(s => {
    const t = row(s, id);
    let targetId: string;
    if (typeof target === 'string') {
      if (!s.payees.some(p => p.id === target)) throw new Error('Payee not found.');
      targetId = target;
    } else {
      const name = validateName(target.newName);
      if (!name) throw new Error('Enter a name for the new payee.');
      const base = s.payees.find(p => p.id === (t.payee_override_id ?? t.payee_id));
      const kind = base?.kind ?? 'merchant';
      const bank = base?.bank ?? '';
      const baseKey = (base?.key ?? name.toLowerCase()).replace(/#\d+$/, '');
      const key = overrideKey(baseKey, s.payees.filter(p => p.kind === kind && p.bank === bank).map(p => p.key));
      targetId = `payee:${kind}:${bank}:${key}`;
      s.payees.push({ id: targetId, kind, bank, key, masked: base?.masked ?? name, name, category: null, nudged_at: null, created_at: Date.now() });
    }
    Object.assign(t, { payee_override_id: targetId === t.payee_id ? null : targetId, updated_at: Date.now() });
    result = targetId;
  });
  return result;
}

function payee(s: SnapshotV2, id: string): PayeeRow {
  const p = s.payees.find(item => item.id === id);
  if (!p) throw new Error('Payee not found.');
  return p;
}
function account(s: SnapshotV2, id: string): AccountRow {
  const a = s.accounts.find(item => item.id === id);
  if (!a) throw new Error('Account not found.');
  return a;
}

export async function renamePayee(id: string, name: string | null, category?: Category | null): Promise<void> {
  const clean = name === null ? null : validateName(name);
  update(s => { const p = payee(s, id); p.name = clean; if (category !== undefined) p.category = category; });
}
export async function markPayeeNudged(id: string): Promise<void> {
  update(s => { const p = payee(s, id); p.nudged_at ??= Date.now(); });
}
export async function setOpeningBalance(id: string, paise: number | null, at: number = Date.now()): Promise<void> {
  const value = validPaise(paise, 'opening balance', true);
  update(s => {
    const a = account(s, id);
    if (a.kind !== 'bank') throw new Error('Only a bank account takes an opening balance.');
    a.opening_balance_paise = value; a.opening_balance_at = value === null ? null : at;
  });
}
export async function setCreditLimit(id: string, paise: number | null): Promise<void> {
  const value = validPaise(paise, 'credit limit');
  update(s => {
    const a = account(s, id);
    if (a.kind !== 'credit_card') throw new Error('Only a credit card takes a credit limit.');
    a.credit_limit_paise = value;
  });
}
export async function renameAccount(id: string, name: string | null): Promise<void> {
  const clean = name === null ? null : validateName(name);
  update(s => { account(s, id).name = clean; });
}
export async function linkDebitCard(cardId: string, bankId: string | null): Promise<void> {
  if (bankId === cardId) throw new Error('A card cannot fund itself.');
  update(s => {
    const card = account(s, cardId);
    card.funded_by = bankId;
    if (bankId) card.kind = 'debit_card';
  });
}

export async function listSchedules(): Promise<Schedule[]> {
  return (read().schedules ?? []).map(scheduleFromRow).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export async function addSchedule(schedule: Schedule): Promise<void> {
  if (schedule.status !== 'dismissed') validateTerms(schedule);
  update(s => { s.schedules ??= []; if (!s.schedules.some(r => r.id === schedule.id)) s.schedules.push(scheduleToRow(schedule)); });
}
function activeSchedule(s: SnapshotV2, id: string) {
  return (s.schedules ?? []).find(r => r.id === id && r.status === 'active');
}
export async function updateScheduleTerms(id: string, terms: ScheduleTerms): Promise<void> {
  validateTerms(terms);
  update(s => {
    const r = activeSchedule(s, id);
    if (r) Object.assign(r, { interval: terms.interval, anchor_day: terms.anchorDay, anchor_month: terms.anchorMonth, amount_min: terms.amountMin, amount_max: terms.amountMax, decided_at: Date.now() });
  });
}
export async function endSchedule(id: string): Promise<void> {
  update(s => { const r = activeSchedule(s, id); if (r) Object.assign(r, { status: 'ended', decided_at: Date.now() }); });
}

export async function listBudgets(): Promise<Budget[]> { return read().budgets.map(budgetFromRow).sort((a, b) => a.category.localeCompare(b.category)); }
export async function saveBudget(category: Category, amountPaise: number): Promise<void> {
  update(s => { s.budgets = s.budgets.filter(item => item.category !== category); s.budgets.push({ category, amount_paise: amountPaise }); });
}
export async function removeBudget(category: Category): Promise<void> {
  update(s => { s.budgets = s.budgets.filter(item => item.category !== category); });
}

export async function listSenders(): Promise<SenderRule[]> { return read().senders.map(senderFromRow).sort((a, b) => a.address.localeCompare(b.address)); }
export async function saveSender(sender: SenderRule): Promise<void> {
  const address = sender.address.toUpperCase().trim();
  update(s => {
    s.senders = s.senders.filter(item => item.address !== address);
    s.senders.push({ address, label: sender.label.trim(), enabled: Number(sender.enabled) });
  });
}
export async function removeSender(address: string): Promise<void> {
  update(s => { s.senders = s.senders.filter(item => item.address !== address); });
}

export async function loadPreferences(): Promise<Preferences> {
  const values = Object.fromEntries(read().preferences.map(({ key, value }) => [key, JSON.parse(value)]));
  return { ...DEFAULT_PREFERENCES, ...values };
}
export async function savePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
  update(s => { s.preferences = [...s.preferences.filter(p => p.key !== key), { key, value: JSON.stringify(value) }]; });
}

export async function exportSnapshot(): Promise<SnapshotV2> { return { ...read(), schemaVersion: LATEST_VERSION, exportedAt: Date.now() }; }
export async function restoreSnapshot(input: Snapshot): Promise<void> {
  const snapshot = validateSnapshot(input);
  write(upgrade(snapshot.schema === 1 ? fromV1(snapshot) : snapshot));
}
