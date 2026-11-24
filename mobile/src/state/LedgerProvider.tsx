import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import {
  addTransaction, dismissUnparsed, exportSnapshot, getDatabase, ingestScan, keepBoth, linkDebitCard, linkUnparsed, listAccounts,
  listBudgets, listPayees, listSenders, listTransactions, listUnparsed, loadPreferences, markPayeeNudged, mergeDuplicate, movePayee,
  removeBudget, removeSender, renameAccount, renamePayee, restoreSnapshot, saveBudget, savePreference, saveSender,
  setCreditLimit, setOpeningBalance, setTransactionCategory, setTransactionStatus, setTransfer, unmerge,
  addSchedule, endSchedule, listSchedules, updateScheduleTerms, setHabitHidden,
  addCategory, deleteCategory, listCategories,
} from '@/lib/database';
import type { MoveTarget, ScheduleTerms, Snapshot } from '@/lib/database';
import { BUILT_IN_COLORS, CATEGORIES, DEFAULT_PREFERENCES, NO_FIGURES, NOT_A_DUPLICATE } from '@/lib/model';
import { liveCategories } from '@/lib/categories';
import type { Account, Budget, Category, CategoryDef, Direction, Payee, Preferences, Schedule, SenderRule, Transaction, TransactionStatus, UnparsedMessage } from '@/lib/model';
import { computeBalances, netWorth } from '@/lib/balances';
import type { AccountBalance } from '@/lib/balances';
import { detectSeries, matchSchedules, suggestionsFrom } from '@/lib/schedules';
import type { ScheduleDraft, ScheduleMatches, SeriesCandidate } from '@/lib/schedules';
import { detectHabits } from '@/lib/habits';
import type { Habit } from '@/lib/habits';
import { duplicatePairs } from '@/lib/duplicates';
import type { DuplicatePair } from '@/lib/duplicates';
import { byId, effectiveCategory, effectivePayeeId, payeeStats, transactionLabel } from '@/lib/resolve';
import type { PayeeStats } from '@/lib/resolve';
import { readBankSms, requestSmsPermission } from '@/lib/sms';
import type { ScanProgress } from '@/lib/sms';

interface LedgerContextValue {
  ready: boolean;
  busy: boolean;
  error: string | null;
  transactions: Transaction[];
  accounts: Account[];
  payees: Payee[];
  // Read-time resolution (spec §3.3), memoized on the ledger revision.
  accountsById: ReadonlyMap<string, Account>;
  payeesById: ReadonlyMap<string, Payee>;
  stats: ReadonlyMap<string, PayeeStats>;
  labelOf: (t: Transaction) => string;
  categoryOf: (t: Transaction) => Category;
  payeeOf: (t: Transaction) => Payee | null;
  accountOf: (t: Transaction) => Account | null;
  // Duplicate review and Couldn't read (P2).
  pairs: DuplicatePair[];
  unparsed: UnparsedMessage[];
  // Balances (P3): per account, and Home's Net (null when no account has a figure).
  balances: ReadonlyMap<string, AccountBalance>;
  net: number | null;
  // Schedules (P4): stored decisions, plus suggestions and matches computed on read.
  schedules: Schedule[];
  suggestions: SeriesCandidate[];
  scheduleMatches: ScheduleMatches;
  trackSchedule: (draft: ScheduleDraft) => Promise<string>;
  dismissSuggestion: (candidate: SeriesCandidate) => Promise<void>;
  updateScheduleTerms: (id: string, terms: ScheduleTerms) => Promise<void>;
  endSchedule: (id: string) => Promise<void>;
  // Habits (P5): computed on read; *Not a habit* is the only stored decision.
  habits: Habit[];
  // The "now" detection ran at (the last ledger read); Habit wording is relative to it.
  asOf: number;
  setHabitHidden: (payeeIds: readonly string[], hidden: boolean) => Promise<void>;
  budgets: Budget[];
  // Your categories (v9), in order; deleted ones are left out.
  categories: CategoryDef[];
  categoryColor: (name: Category) => string;
  addCategory: (name: string, color?: string) => Promise<string>;
  deleteCategory: (name: Category, into: Category) => Promise<void>;
  senders: SenderRule[];
  preferences: Preferences;
  refresh: () => Promise<void>;
  scan: (full?: boolean) => Promise<number>;
  enableSms: () => Promise<boolean>;
  addManual: (merchant: string, rupees: number, direction: Direction, category: Category, occurredAt?: number, accountId?: string | null) => Promise<string>;
  addFromUnparsed: (unparsedId: string, merchant: string, rupees: number, direction: Direction, category: Category, occurredAt: number) => Promise<void>;
  mergeDuplicate: (flaggedId: string, survivorId: string) => Promise<void>;
  keepBoth: (id: string) => Promise<void>;
  unmerge: (id: string) => Promise<void>;
  dismissUnparsed: (id: string) => Promise<void>;
  setTransactionStatus: (id: string, status: TransactionStatus) => Promise<void>;
  setTransactionCategory: (id: string, category: Category) => Promise<void>;
  setTransfer: (id: string, from: string | null, to: string | null) => Promise<void>;
  movePayee: (id: string, target: MoveTarget) => Promise<string>;
  renamePayee: (id: string, name: string | null, category?: Category | null) => Promise<void>;
  markPayeeNudged: (id: string) => Promise<void>;
  renameAccount: (id: string, name: string | null) => Promise<void>;
  linkDebitCard: (cardId: string, bankId: string | null) => Promise<void>;
  setOpeningBalance: (id: string, paise: number | null, at?: number) => Promise<void>;
  setCreditLimit: (id: string, paise: number | null) => Promise<void>;
  setBudget: (category: Category, amountPaise: number) => Promise<void>;
  removeBudget: (category: Category) => Promise<void>;
  setSender: (sender: SenderRule) => Promise<void>;
  removeSender: (address: string) => Promise<void>;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => Promise<void>;
  restore: (snapshot: Snapshot) => Promise<void>;
  clearError: () => void;
}

const LedgerContext = createContext<LedgerContextValue | null>(null);

// A whole-inbox read can take a minute. Its progress lives in its own context so the
// ticks re-render only the progress bar, not every ledger consumer. Null when idle, and
// during a short incremental scan.
export interface ScanStatus extends ScanProgress { full: boolean }
const ScanProgressContext = createContext<ScanStatus | null>(null);

async function trackScheduleWrite(draft: ScheduleDraft): Promise<string> {
  const now = Date.now();
  const id = randomUUID();
  await addSchedule({ ...draft, id, status: 'active', createdAt: now, decidedAt: now });
  return id;
}

// Not a schedule: a 'dismissed' row for the series key, interval and band.
async function dismissSuggestionWrite(c: SeriesCandidate): Promise<void> {
  const now = Date.now();
  await addSchedule({ id: randomUUID(), payeeId: c.payeeId, accountId: c.accountId, direction: c.direction, interval: c.interval,
    anchorDay: c.anchorDay, anchorMonth: c.anchorMonth, amountMin: c.amountMin, amountMax: c.amountMax, lastPaidAt: c.lastHitAt,
    status: 'dismissed', createdAt: now, decidedAt: now });
}

// The first scan and a full re-read take the whole inbox; later scans read only what is new
// (with a 2-minute overlap). Re-reading is safe: rows dedupe on source_hash.
function scanStart(full: boolean, lastScanAt: number): number {
  return full || !lastScanAt ? 0 : lastScanAt - 120_000;
}

export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [unparsed, setUnparsed] = useState<UnparsedMessage[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [allCategories, setAllCategories] = useState<CategoryDef[]>(() => CATEGORIES.map((name, position) => ({ name, color: BUILT_IN_COLORS[name], position, mergedInto: null })));
  // When the ledger was last read: the "now" detection and matching are computed at.
  const [revisionAt, setRevisionAt] = useState(0);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [senders, setSenders] = useState<SenderRule[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const scanBusyRef = useRef(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  // When the ledger was last read; balance staleness is judged against it.
  const [loadedAt, setLoadedAt] = useState(0);

  const refresh = useCallback(async () => {
    const [nextTransactions, nextAccounts, nextPayees, nextUnparsed, nextBudgets, nextSenders, nextPreferences, nextSchedules, nextCategories] = await Promise.all([
      listTransactions(), listAccounts(), listPayees(), listUnparsed(), listBudgets(), listSenders(), loadPreferences(), listSchedules(), listCategories(),
    ]);
    setTransactions(nextTransactions);
    setSchedules(nextSchedules);
    setAllCategories(nextCategories);
    setRevisionAt(Date.now());
    setUnparsed(nextUnparsed);
    setAccounts(nextAccounts);
    setPayees(nextPayees);
    setBudgets(nextBudgets);
    setSenders(nextSenders);
    setPreferences(nextPreferences);
    setLoadedAt(Date.now());
  }, []);

  useEffect(() => {
    getDatabase().then(refresh).then(() => setReady(true)).catch(e => {
      setError(e instanceof Error ? e.message : 'Could not open the ledger.');
      setReady(true);
    });
  }, [refresh]);

  const scan = useCallback(async (full = false): Promise<number> => {
    if (Platform.OS !== 'android' || !preferences.readSms) return 0;
    if (scanBusyRef.current) return 0;
    scanBusyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const since = scanStart(full, preferences.lastScanAt);
      const whole = since === 0;
      const report = (progress: ScanProgress) => { if (whole) setScanStatus({ ...progress, full: whole }); };
      // Flagging runs at ingest against the ledger, so a copy that lands in a later
      // scan than its original is still caught (WF-5).
      const batch = await readBankSms(senders, since, preferences.autoAdd, report);
      const { added } = await ingestScan(batch, report);
      await savePreference('lastScanAt', Date.now());
      await refresh();
      return added;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not read SMS.';
      setError(message);
      throw e;
    } finally { scanBusyRef.current = false; setBusy(false); setScanStatus(null); }
  }, [preferences, senders, refresh]);

  const scanRef = useRef(scan);
  useEffect(() => { scanRef.current = scan; }, [scan]);

  useEffect(() => {
    if (!ready || !preferences.readSms || Platform.OS !== 'android') return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void scanRef.current().catch(() => {});
    });
    void scanRef.current().catch(() => {});
    return () => subscription.remove();
  }, [ready, preferences.readSms]);

  const enableSms = useCallback(async () => {
    const granted = await requestSmsPermission();
    if (granted) {
      await savePreference('readSms', true);
      await refresh();
    }
    return granted;
  }, [refresh]);

  const addManual = useCallback(async (merchant: string, rupees: number, direction: Direction, category: Category, occurredAt = Date.now(), accountId: string | null = null) => {
    const amountPaise = Math.round(rupees * 100);
    if (!merchant.trim() || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a merchant and an amount above zero.');
    const now = Date.now();
    const id = randomUUID();
    await addTransaction({ id, sourceHash: null, sender: null, rawBody: null,
      occurredAt, merchant: merchant.trim(), amountPaise, direction, category,
      status: 'manual', accountLast4: null, counterpartyMasked: null, counterpartyLast4: null,
      reference: null, confidence: 1, createdAt: now, updatedAt: now,
      accountId, payeeId: null, payeeOverrideId: null, categoryByUser: true, ...NOT_A_DUPLICATE, ...NO_FIGURES, transferAccountId: null });
    await refresh();
    return id;
  }, [refresh]);

  const addFromUnparsed = useCallback(async (unparsedId: string, merchant: string, rupees: number, direction: Direction, category: Category, occurredAt: number) => {
    const id = await addManual(merchant, rupees, direction, category, occurredAt);
    await linkUnparsed(unparsedId, id);
    await refresh();
  }, [addManual, refresh]);

  // Every mutation is a stored decision followed by a re-read; labels, categories and
  // suggestions recompute from the new revision.
  const mutations = useMemo(() => {
    const after = <A extends unknown[], R>(write: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      const result = await write(...args);
      await refresh();
      return result;
    };
    return {
      setTransactionStatus: after(setTransactionStatus),
      setTransactionCategory: after(setTransactionCategory),
      setTransfer: after(setTransfer),
      movePayee: after(movePayee),
      renamePayee: after(renamePayee),
      markPayeeNudged: after(markPayeeNudged),
      renameAccount: after(renameAccount),
      linkDebitCard: after(linkDebitCard),
      setOpeningBalance: after(setOpeningBalance),
      setCreditLimit: after(setCreditLimit),
      mergeDuplicate: after(mergeDuplicate),
      keepBoth: after(keepBoth),
      unmerge: after(unmerge),
      dismissUnparsed: after(dismissUnparsed),
      trackSchedule: after(trackScheduleWrite),
      dismissSuggestion: after(dismissSuggestionWrite),
      updateScheduleTerms: after(updateScheduleTerms),
      endSchedule: after(endSchedule),
      setHabitHidden: after(setHabitHidden),
      addCategory: after(addCategory),
      deleteCategory: after(deleteCategory),
    };
  }, [refresh]);

  const resolved = useMemo(() => {
    const payeesById = byId(payees);
    const accountsById = byId(accounts);
    return {
      payeesById, accountsById, stats: payeeStats(transactions),
      labelOf: (t: Transaction) => transactionLabel(t, payeesById),
      categoryOf: (t: Transaction) => effectiveCategory(t, payeesById),
      payeeOf: (t: Transaction) => { const id = effectivePayeeId(t); return (id && payeesById.get(id)) || null; },
      accountOf: (t: Transaction) => (t.accountId && accountsById.get(t.accountId)) || null,
      pairs: duplicatePairs(transactions),
      ...(() => { const balances = computeBalances(transactions, accounts, loadedAt); return { balances, net: netWorth(balances.values()) }; })(),
    };
  }, [transactions, payees, accounts, loadedAt]);

  // Detection and matching re-run on every ledger revision: scans, naming, moves,
  // merges and unmerges all go through refresh (spec §5.4 re-run triggers).
  const scheduling = useMemo(() => {
    const candidates = detectSeries(transactions, resolved.payeesById, revisionAt);
    const scheduleMatches = matchSchedules(transactions, schedules, resolved.payeesById, revisionAt);
    return {
      suggestions: suggestionsFrom(candidates, schedules, resolved.payeesById),
      scheduleMatches,
      // Schedule wins per row (WF-7): matched rows are removed before Habit counting.
      habits: detectHabits(transactions, scheduleMatches, resolved.payeesById, accounts, revisionAt),
    };
  }, [transactions, schedules, resolved, accounts, revisionAt]);

  const changeBudget = useCallback(async (category: Category, amountPaise: number) => {
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a budget above zero.');
    await saveBudget(category, amountPaise);
    await refresh();
  }, [refresh]);

  const changePreference = useCallback(async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    await savePreference(key, value);
    await refresh();
  }, [refresh]);

  const categoryInfo = useMemo(() => {
    const colors = new Map(allCategories.map(c => [c.name, c.color]));
    return { categories: liveCategories(allCategories), categoryColor: (name: Category) => colors.get(name) ?? BUILT_IN_COLORS[name] ?? '#A9A495' };
  }, [allCategories]);

  const value = useMemo<LedgerContextValue>(() => ({
    ...categoryInfo,
    ready, busy, error, transactions, accounts, payees, unparsed, ...resolved, schedules, ...scheduling, asOf: revisionAt, budgets, senders, preferences, refresh, scan, enableSms,
    addManual, addFromUnparsed, ...mutations, setBudget: changeBudget,
    removeBudget: async category => { await removeBudget(category); await refresh(); },
    setSender: async sender => { await saveSender(sender); await refresh(); },
    removeSender: async address => { await removeSender(address); await refresh(); },
    setPreference: changePreference,
    restore: async snapshot => { await restoreSnapshot(snapshot); await refresh(); },
    clearError: () => setError(null),
  }), [ready, busy, error, transactions, accounts, payees, unparsed, resolved, schedules, scheduling, revisionAt, budgets, senders, preferences, refresh, scan, enableSms, addManual, addFromUnparsed, mutations, changeBudget, changePreference, categoryInfo]);

  return <LedgerContext.Provider value={value}><ScanProgressContext.Provider value={scanStatus}>{children}</ScanProgressContext.Provider></LedgerContext.Provider>;
}

export function useLedger(): LedgerContextValue {
  const value = useContext(LedgerContext);
  if (!value) throw new Error('LedgerProvider is missing');
  return value;
}

export function useScanProgress(): ScanStatus | null {
  return useContext(ScanProgressContext);
}

export { exportSnapshot };
