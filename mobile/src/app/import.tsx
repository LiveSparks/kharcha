import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Action, Body, Caption, Screen, ScreenHead, SmsSlip } from '@/ui/Kit';
import { Field, Note } from '@/ui/Forms';
import { parseBankSms, occurredAtFrom } from '@/lib/parser';
import { ingestScan } from '@/lib/database';
import { useLedger } from '@/state/LedgerProvider';
import { NOT_A_DUPLICATE } from '@/lib/model';
import type { Transaction } from '@/lib/model';
import { showMessage } from '@/ui/dialog';

export default function ImportSms() {
  const { refresh } = useLedger();
  const [body, setBody] = useState('');
  const [sender, setSender] = useState('');
  const [candidate, setCandidate] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  async function parse() {
    const parsed = parseBankSms(body);
    if (!parsed) { showMessage('No transaction found', 'Use a debit or credit bank message with an amount. OTPs and promotions are skipped.'); return; }
    const now = Date.now();
    const occurredAt = occurredAtFrom(body, now) ?? now;
    const sourceHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${sender.trim()}\n${body.trim()}`);
    setCandidate({ id: Crypto.randomUUID(), sourceHash, sender: sender.trim() || 'Pasted SMS', rawBody: body.trim(), occurredAt,
      merchant: parsed.merchant, amountPaise: parsed.amountPaise, direction: parsed.direction, category: parsed.category,
      status: 'review', accountLast4: parsed.accountLast4, reference: parsed.reference,
      counterpartyMasked: parsed.counterpartyMasked, counterpartyLast4: parsed.counterpartyLast4,
      confidence: parsed.confidence, createdAt: now, updatedAt: now,
      accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false, ...NOT_A_DUPLICATE, transferAccountId: null,
      reportedBalancePaise: parsed.reportedBalancePaise, reportedAvlLimitPaise: parsed.reportedAvlLimitPaise });
  }
  async function save() {
    if (!candidate) return;
    setBusy(true);
    try { const { added } = await ingestScan({ transactions: [candidate], unparsed: [] }); await refresh(); if (!added) showMessage('Already in your ledger', 'This message was already imported.'); router.replace('/(tabs)/inbox'); }
    catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }
  return <Screen><ScreenHead title="Paste a bank SMS" back /><Body muted>This reads only text you paste. It works on iOS, Android, and web.</Body>
    <View style={{ gap: 17, marginTop: 23 }}><Field label="Sender (optional)" value={sender} onChangeText={setSender} placeholder="Bank sender ID" autoCapitalize="characters" />
      <Field label="Message" value={body} onChangeText={value => { setBody(value); setCandidate(null); }} placeholder="Paste a debit or credit message here" multiline />
      <Note>Only transaction-like messages can be saved. No message is sent to the backup server unless you turn on encrypted backup and upload it yourself.</Note>
      <Action title="Read this message" onPress={() => void parse()} />
      {candidate ? <View style={{ gap: 13 }}><Caption>Preview, ready for your review</Caption><SmsSlip transaction={candidate} /><Action title={busy ? 'Saving…' : 'Add to review inbox'} disabled={busy} variant="leaf" onPress={() => void save()} /></View> : null}
    </View>
  </Screen>;
}
