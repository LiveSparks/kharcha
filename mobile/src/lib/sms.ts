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

// Reads allowed-sender SMS since `since`. Parsed messages become candidate rows;
// rejected ones that read like a transaction go to "Couldn't read". Duplicate flagging
// happens at ingest, against the ledger (ingestScan).
export async function readBankSms(senders: SenderRule[], since: number, autoAdd: boolean): Promise<ScanBatch> {
  const none: ScanBatch = { transactions: [], unparsed: [] };
  if (!canReadSms()) return none;
  const allowed = senders.filter(sender => sender.enabled).map(sender => sender.address);
  if (!allowed.length) return none;
  const native = (await import('../../modules/kharcha-sms/src/KharchaSmsModule')).default;
  const messages = await native.listMessages(allowed, since);
  const result: Transaction[] = [];
  const unparsed: UnparsedInput[] = [];
  for (const sms of messages) {
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
    });
  }
  return { transactions: result, unparsed };
}
