import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import {
  addTransaction, dismissUnparsed, exportSnapshot, getDatabase, ingestScan, keepBoth, linkDebitCard, linkUnparsed, listAccounts,
  listBudgets, listPayees, listSenders, listTransactions, listUnparsed, loadPreferences, markPayeeNudged, mergeDuplicate, movePayee,
  removeBudget, removeSender, renameAccount, renamePayee, restoreSnapshot, saveBudget, savePreference, saveSender,
  setTransactionCategory, setTransactionStatus, unmerge,
} from '@/lib/database';
import type { MoveTarget, Snapshot } from '@/lib/database';
import { DEFAULT_PREFERENCES, NOT_A_DUPLICATE } from '@/lib/model';
import type { Account, Budget, Category, Direction, Payee, Preferences, SenderRule, Transaction, TransactionStatus, UnparsedMessage } from '@/lib/model';
import { duplicatePairs } from '@/lib/duplicates';
import type { DuplicatePair } from '@/lib/duplicates';
import { byId, effectiveCategory, effectivePayeeId, payeeStats, transactionLabel } from '@/lib/resolve';
import type { PayeeStats } from '@/lib/resolve';
import { readBankSms, requestSmsPermission } from '@/lib/sms';

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
  budgets: Budget[];
  senders: SenderRule[];
  preferences: Preferences;
  refresh: () => Promise<void>;
  scan: (full?: boolean) => Promise<number>;
  enableSms: () => Promise<boolean>;
  addManual: (merchant: string, rupees: number, direction: Direction, category: Category, occurredAt?: number) => Promise<string>;
  addFromUnparsed: (unparsedId: string, merchant: string, rupees: number, direction: Direction, category: Category, occurredAt: number) => Promise<void>;
  mergeDuplicate: (flaggedId: string, survivorId: string) => Promise<void>;
  keepBoth: (id: string) => Promise<void>;
  unmerge: (id: string) => Promise<void>;
  dismissUnparsed: (id: string) => Promise<void>;
  setTransactionStatus: (id: string, status: TransactionStatus) => Promise<void>;
  setTransactionCategory: (id: string, category: Category) => Promise<void>;
  movePayee: (id: string, target: MoveTarget) => Promise<string>;
  renamePayee: (id: string, name: string | null, category?: Category | null) => Promise<void>;
  markPayeeNudged: (id: string) => Promise<void>;
  renameAccount: (id: string, name: string | null) => Promise<void>;
  linkDebitCard: (cardId: string, bankId: string | null) => Promise<void>;
  setBudget: (category: Category, amountPaise: number) => Promise<void>;
  removeBudget: (category: Category) => Promise<void>;
  setSender: (sender: SenderRule) => Promise<void>;
  removeSender: (address: string) => Promise<void>;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => Promise<void>;
  restore: (snapshot: Snapshot) => Promise<void>;
  clearError: () => void;
}

const LedgerContext = createContext<LedgerContextValue | null>(null);

function scanStart(full: boolean, lastScanAt: number): number {
  return full || !lastScanAt ? Date.now() - 90 * 86400_000 : lastScanAt - 120_000;
}

export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [unparsed, setUnparsed] = useState<UnparsedMessage[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [senders, setSenders] = useState<SenderRule[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const scanBusyRef = useRef(false);

  const refresh = useCallback(async () => {
    const [nextTransactions, nextAccounts, nextPayees, nextUnparsed, nextBudgets, nextSenders, nextPreferences] = await Promise.all([
      listTransactions(), listAccounts(), listPayees(), listUnparsed(), listBudgets(), listSenders(), loadPreferences(),
    ]);
    setTransactions(nextTransactions);
    setUnparsed(nextUnparsed);
    setAccounts(nextAccounts);
    setPayees(nextPayees);
    setBudgets(nextBudgets);
    setSenders(nextSenders);
    setPreferences(nextPreferences);
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
      // Flagging runs at ingest against the ledger, so a copy that lands in a later
      // scan than its original is still caught (WF-5).
      const { added } = await ingestScan(await readBankSms(senders, since, preferences.autoAdd));
      await savePreference('lastScanAt', Date.now());
      await refresh();
      return added;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not read SMS.';
      setError(message);
      throw e;
    } finally { scanBusyRef.current = false; setBusy(false); }
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

  const addManual = useCallback(async (merchant: string, rupees: number, direction: Direction, category: Category, occurredAt = Date.now()) => {
    const amountPaise = Math.round(rupees * 100);
    if (!merchant.trim() || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a merchant and an amount above zero.');
    const now = Date.now();
    const id = randomUUID();
    await addTransaction({ id, sourceHash: null, sender: null, rawBody: null,
      occurredAt, merchant: merchant.trim(), amountPaise, direction, category,
      status: 'manual', accountLast4: null, counterpartyMasked: null, counterpartyLast4: null,
      reference: null, confidence: 1, createdAt: now, updatedAt: now,
      accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: true, ...NOT_A_DUPLICATE });
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
      movePayee: after(movePayee),
      renamePayee: after(renamePayee),
      markPayeeNudged: after(markPayeeNudged),
      renameAccount: after(renameAccount),
      linkDebitCard: after(linkDebitCard),
      mergeDuplicate: after(mergeDuplicate),
      keepBoth: after(keepBoth),
      unmerge: after(unmerge),
      dismissUnparsed: after(dismissUnparsed),
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
    };
  }, [transactions, payees, accounts]);

  const changeBudget = useCallback(async (category: Category, amountPaise: number) => {
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a budget above zero.');
    await saveBudget(category, amountPaise);
    await refresh();
  }, [refresh]);

  const changePreference = useCallback(async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    await savePreference(key, value);
    await refresh();
  }, [refresh]);

  const value = useMemo<LedgerContextValue>(() => ({
    ready, busy, error, transactions, accounts, payees, unparsed, ...resolved, budgets, senders, preferences, refresh, scan, enableSms,
    addManual, addFromUnparsed, ...mutations, setBudget: changeBudget,
    removeBudget: async category => { await removeBudget(category); await refresh(); },
    setSender: async sender => { await saveSender(sender); await refresh(); },
    removeSender: async address => { await removeSender(address); await refresh(); },
    setPreference: changePreference,
    restore: async snapshot => { await restoreSnapshot(snapshot); await refresh(); },
    clearError: () => setError(null),
  }), [ready, busy, error, transactions, accounts, payees, unparsed, resolved, budgets, senders, preferences, refresh, scan, enableSms, addManual, addFromUnparsed, mutations, changeBudget, changePreference]);

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useLedger(): LedgerContextValue {
  const value = useContext(LedgerContext);
  if (!value) throw new Error('LedgerProvider is missing');
  return value;
}

export { exportSnapshot };
