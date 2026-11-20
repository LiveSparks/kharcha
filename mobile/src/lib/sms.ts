import { PermissionsAndroid, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { parseBankSms, occurredAtFrom } from './parser';
import { flagDuplicates } from './duplicates';
import type { SenderRule, Transaction } from './model';

export function canReadSms(): boolean { return Platform.OS === 'android'; }

export async function requestSmsPermission(): Promise<boolean> {
  if (!canReadSms()) return false;
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_SMS, {
    title: 'Read bank transaction SMS',
    message: 'Kharcha reads messages only from the bank senders you allow. OTPs and personal chats are not added to your ledger.',
    buttonPositive: 'Allow', buttonNegative: 'Not now',
  })) === PermissionsAndroid.RESULTS.GRANTED;
}

export async function readBankSms(senders: SenderRule[], since: number, autoAdd: boolean): Promise<Transaction[]> {
  if (!canReadSms()) return [];
  const allowed = senders.filter(sender => sender.enabled).map(sender => sender.address);
  if (!allowed.length) return [];
  const native = (await import('../../modules/kharcha-sms/src/KharchaSmsModule')).default;
  const messages = await native.listMessages(allowed, since);
  const result: Transaction[] = [];
  for (const sms of messages) {
    const parsed = parseBankSms(sms.body);
    if (!parsed) continue;
    const sourceHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${sms.sender}\n${sms.receivedAt}\n${sms.body}`,
    );
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
      accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false,
    });
  }
  // Duplicate notifications of one transfer (different senders/bodies) sit side by
  // side in the read batch: mark the later copy for review instead of dropping it.
  return flagDuplicates(result);
}
