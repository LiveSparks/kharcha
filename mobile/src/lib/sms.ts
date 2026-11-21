import { PermissionsAndroid, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { parseBankSms, occurredAtFrom } from './parser';
import { isUnreadTransaction, unparsedHints } from './unparsed';
import { NOT_A_DUPLICATE } from './model';
import type { SenderRule, Transaction } from './model';
import type { ScanBatch, UnparsedInput } from './ledger';

export function canReadSms(): boolean { return Platform.OS === 'android'; }

export async function requestSmsPermission(): Promise<boolean> {
  if (!canReadSms()) return false;
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_SMS, {
    title: 'Read bank transaction SMS',
    message: 'Kharcha reads messages only from the bank senders you allow. OTPs and personal chats are not added to your ledger.',
    buttonPositive: 'Allow', buttonNegative: 'Not now',
  })) === PermissionsAndroid.RESULTS.GRANTED;
}

// Where a scan is: fetching from the inbox, parsing `done` of `total` bank messages,
// checking them against the ledger, or adding the new ones (ingest's steps).
export interface ScanProgress { phase: 'reading' | 'parsing' | 'checking' | 'adding'; done: number; total: number }

const PROGRESS_EVERY = 25;

// Reads allowed-sender SMS since `since`. Parsed messages become candidate rows;
// rejected ones that read like a transaction go to "Couldn't read". Duplicate flagging
// happens at ingest, against the ledger (ingestScan).
export async function readBankSms(senders: SenderRule[], since: number, autoAdd: boolean, onProgress?: (progress: ScanProgress) => void): Promise<ScanBatch> {
  const none: ScanBatch = { transactions: [], unparsed: [] };
  if (!canReadSms()) return none;
  const allowed = senders.filter(sender => sender.enabled).map(sender => sender.address);
  if (!allowed.length) return none;
  onProgress?.({ phase: 'reading', done: 0, total: 0 });
  const native = (await import('../../modules/kharcha-sms/src/KharchaSmsModule')).default;
  const messages = await native.listMessages(allowed, since);
  const result: Transaction[] = [];
  const unparsed: UnparsedInput[] = [];
  for (const [index, sms] of messages.entries()) {
    if (index % PROGRESS_EVERY === 0) onProgress?.({ phase: 'parsing', done: index, total: messages.length });
    const parsed = parseBankSms(sms.body);
    if (!parsed && !isUnreadTransaction(sms.body)) continue;
    const sourceHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${sms.sender}\n${sms.receivedAt}\n${sms.body}`,
    );
    if (!parsed) {
      unparsed.push({ id: Crypto.randomUUID(), sourceHash, sender: sms.sender, rawBody: sms.body,
        receivedAt: occurredAtFrom(sms.body, sms.receivedAt) ?? sms.receivedAt, amountPaise: unparsedHints(sms.body).amountPaise });
      continue;
    }
    const now = Date.now();
    // Body timestamp precedence: banks put the true transaction time inside the text.
    const occurredAt = occurredAtFrom(sms.body, sms.receivedAt) ?? sms.receivedAt;
    result.push({
      id: Crypto.randomUUID(), sourceHash, sender: sms.sender, rawBody: sms.body,
      occurredAt, merchant: parsed.merchant, amountPaise: parsed.amountPaise,
      direction: parsed.direction, category: parsed.category,
      status: autoAdd && parsed.confidence >= 0.9 ? 'auto' : 'review',
      accountLast4: parsed.accountLast4, reference: parsed.reference,
      counterpartyMasked: parsed.counterpartyMasked, counterpartyLast4: parsed.counterpartyLast4,
      confidence: parsed.confidence, createdAt: now, updatedAt: now,
      // Account and payee resolve at insert (addTransaction), from sender + parser fields.
      accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false, ...NOT_A_DUPLICATE,
      reportedBalancePaise: parsed.reportedBalancePaise, reportedAvlLimitPaise: parsed.reportedAvlLimitPaise,
    });
  }
  return { transactions: result, unparsed };
}
