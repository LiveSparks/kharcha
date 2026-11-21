import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Action, Body, Caption, Label, Screen, ScreenHead, SectionTitle, TransactionRow } from '@/ui/Kit';
import { Field, Note } from '@/ui/Forms';
import { StateChip, aroundLabel, candidateKey } from '@/ui/Schedules';
import { confirmAction, showMessage } from '@/ui/dialog';
import { fonts, usePalette } from '@/ui/theme';
import { money } from '@/lib/format';
import { accountLabel, payeeLabel } from '@/lib/resolve';
import { INTERVALS, INTERVAL_LABEL, WEEKDAYS, anchorsFor, bandFor, draftFromCandidate, draftFromRow, validateTerms } from '@/lib/schedules';
import type { ScheduleDraft, ScheduleView } from '@/lib/schedules';
import type { ScheduleTerms } from '@/lib/database';
import type { ScheduleInterval } from '@/lib/model';
import { useLedger } from '@/state/LedgerProvider';

const QUARTER_MONTHS = ['Jan · Apr · Jul · Oct', 'Feb · May · Aug · Nov', 'Mar · Jun · Sep · Dec'];
const weekly = (i: ScheduleInterval) => i === 'weekly' || i === 'fortnightly';
const rupees = (paise: number) => String(Math.round(paise / 100));
const paise = (text: string) => Math.round(Number(text.replace(/[,\s₹]/g, '')) * 100);

// One screen for a Schedule: the Track form for a suggestion (Track it) or a single row
// (Track as schedule), and the detail of a tracked one (state, matched history, edit,
// Stop tracking). The name is the payee's, edited through the name sheet.
export default function ScheduleScreen() {
  const params = useLocalSearchParams<{ id?: string; candidate?: string; from?: string }>();
  const { suggestions, schedules, scheduleMatches, transactions, payeesById, accountsById, trackSchedule, updateScheduleTerms, endSchedule } = useLedger();
  const existing = params.id ? schedules.find(s => s.id === params.id) : undefined;
  const view = existing ? scheduleMatches.state.get(existing.id) : undefined;
  const base: ScheduleDraft | null = useMemo(() => {
    if (existing) return existing;
    if (params.candidate) { const c = suggestions.find(x => candidateKey(x) === params.candidate); return c ? draftFromCandidate(c) : null; }
    if (params.from) { const t = transactions.find(x => x.id === params.from); return t ? draftFromRow(t) : null; }
    return null;
    // Only the first render's source matters; later ledger revisions must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!base) return <Screen><ScreenHead title="Not found" back /><Body muted>This schedule or suggestion is no longer there. It may have been tracked or dismissed already.</Body></Screen>;
  return <ScheduleForm base={base} existingId={existing?.id ?? null} ended={existing?.status === 'ended'} view={view}
    payeeName={payeesById.get(base.payeeId) ? payeeLabel(payeesById.get(base.payeeId)!) : 'Unknown payee'}
    accountName={base.accountId && accountsById.get(base.accountId) ? accountLabel(accountsById.get(base.accountId)!) : null}
    onTrack={trackSchedule} onUpdate={updateScheduleTerms} onEnd={endSchedule} />;
}

function ScheduleForm({ base, existingId, ended, view, payeeName, accountName, onTrack, onUpdate, onEnd }: {
  base: ScheduleDraft; existingId: string | null; ended: boolean; view: ScheduleView | undefined;
  payeeName: string; accountName: string | null;
  onTrack: (d: ScheduleDraft) => Promise<string>; onUpdate: (id: string, terms: ScheduleTerms) => Promise<void>; onEnd: (id: string) => Promise<void>;
}) {
  const p = usePalette();
  const [interval, setInterval] = useState<ScheduleInterval>(base.interval);
  const [anchorDay, setAnchorDay] = useState(base.anchorDay);
  const [dayText, setDayText] = useState(weekly(base.interval) ? '' : String(base.anchorDay));
  const [anchorMonth, setAnchorMonth] = useState<number | null>(base.anchorMonth);
  const [minText, setMinText] = useState(rupees(base.amountMin));
  const [maxText, setMaxText] = useState(rupees(base.amountMax));
  const [busy, setBusy] = useState(false);
  const [seed] = useState(() => base.lastPaidAt ?? Date.now());

  // Switching between weekday and day-of-month anchors re-derives the anchor from the
  // starting row's date; switching within a kind keeps what the user set.
  function pickInterval(next: ScheduleInterval) {
    const a = anchorsFor(next, seed);
    if (weekly(next) !== weekly(interval)) {
      setAnchorDay(a.anchorDay);
      if (!weekly(next)) setDayText(String(a.anchorDay));
    }
    setAnchorMonth(next === 'quarterly' ? anchorMonth ?? a.anchorMonth : null);
    setInterval(next);
  }

  async function save() {
    const terms = { interval, anchorDay: weekly(interval) ? anchorDay : Number(dayText), anchorMonth: interval === 'quarterly' ? anchorMonth : null, amountMin: paise(minText), amountMax: paise(maxText) };
    try { validateTerms(terms); } catch (e) { showMessage('Check the schedule', e instanceof Error ? e.message : 'Try again.'); return; }
    setBusy(true);
    try {
      if (existingId) { await onUpdate(existingId, terms); router.back(); }
      else { const id = await onTrack({ ...base, ...terms }); router.replace({ pathname: '/schedule', params: { id } }); }
    } catch (e) { showMessage('Could not save', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }

  async function acceptDrift() {
    if (!existingId || !view?.drift) return;
    const band = bandFor(view.drift.toPaise, view.drift.toPaise);
    setBusy(true);
    try { await onUpdate(existingId, { interval: base.interval, anchorDay: base.anchorDay, anchorMonth: base.anchorMonth, ...band }); setMinText(rupees(band.amountMin)); setMaxText(rupees(band.amountMax)); }
    catch (e) { showMessage('Could not update', e instanceof Error ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  }

  function stop() {
    if (!existingId) return;
    confirmAction('Stop tracking?', 'Its history stays, and it will not be suggested again.', 'Stop tracking', () => {
      void onEnd(existingId).then(() => router.back(), e => showMessage('Could not stop', e instanceof Error ? e.message : 'Try again.'));
    });
  }

  const chip = (selected: boolean) => ({ minHeight: 35, paddingHorizontal: 11, borderRadius: 9, justifyContent: 'center' as const,
    backgroundColor: selected ? p.leaf : p.surface, borderWidth: selected ? 0 : 1, borderColor: p.line });
  const chipText = (selected: boolean) => ({ fontFamily: fonts.bodyMedium, fontSize: 13, color: selected ? p.onLeaf : p.ink });

  return <Screen><ScreenHead title={existingId ? payeeName : 'Track as schedule'} back />
    {view && existingId ? <View style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, gap: 8, marginBottom: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {ended ? <Caption>Stopped</Caption> : <StateChip state={view.state} />}
        {!ended ? <Body>{view.missedAt != null && (view.state === 'overdue' || view.state === 'lapsed') ? `was due around ${aroundLabel(view.missedAt)} · ` : ''}next around {aroundLabel(view.expectedAt)}</Body> : null}
      </View>
      <Caption>Window {aroundLabel(view.windowStart)} – {aroundLabel(view.windowEnd - 1)} · {money(view.typicalPaise)} · {INTERVAL_LABEL[base.interval].toLowerCase()}</Caption>
      {view.drift && !ended ? <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: p.line, paddingTop: 10 }}>
        <Label>Amount changed: {money(view.drift.fromPaise)} → {money(view.drift.toPaise)}, update?</Label>
        <View style={{ flexDirection: 'row' }}><Action compact variant="leaf" title="Update" disabled={busy} onPress={() => void acceptDrift()} /></View>
      </View> : null}
    </View> : null}

    <View style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 22 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Caption>{base.direction === 'debit' ? 'Paid to' : 'Received from'}</Caption>
        <Label style={{ fontSize: 16, marginTop: 2 }}><Text numberOfLines={2}>{payeeName}</Text></Label>
        {accountName ? <Caption>{base.direction === 'debit' ? 'from' : 'into'} {accountName}</Caption> : null}
      </View>
      <Action compact variant="secondary" title="Name" onPress={() => router.push({ pathname: '/name', params: { kind: 'payee', id: base.payeeId } })} />
    </View>

    {!ended ? <View style={{ gap: 21 }}>
      <View style={{ gap: 9 }}><Label>Repeats</Label><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {INTERVALS.map(c => <Pressable key={c.interval} accessibilityRole="radio" accessibilityState={{ checked: interval === c.interval }} onPress={() => pickInterval(c.interval)} style={chip(interval === c.interval)}>
          <Text style={chipText(interval === c.interval)}>{INTERVAL_LABEL[c.interval]}</Text></Pressable>)}
      </View></View>
      {weekly(interval) ? <View style={{ gap: 9 }}><Label>On</Label><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {WEEKDAYS.map((d, i) => <Pressable key={d} accessibilityRole="radio" accessibilityState={{ checked: anchorDay === i }} onPress={() => setAnchorDay(i)} style={chip(anchorDay === i)}><Text style={chipText(anchorDay === i)}>{d}</Text></Pressable>)}
      </View></View> : <Field label="Day of the month" value={dayText} onChangeText={setDayText} numeric placeholder="1–31" />}
      {interval === 'quarterly' ? <View style={{ gap: 9 }}><Label>In</Label><View style={{ gap: 8 }}>
        {QUARTER_MONTHS.map((label, i) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: anchorMonth === i + 1 }} onPress={() => setAnchorMonth(i + 1)} style={chip(anchorMonth === i + 1)}><Text style={chipText(anchorMonth === i + 1)}>{label}</Text></Pressable>)}
      </View></View> : null}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}><Field label="From ₹" value={minText} onChangeText={setMinText} numeric /></View>
        <View style={{ flex: 1 }}><Field label="To ₹" value={maxText} onChangeText={setMaxText} numeric /></View>
      </View>
      <Note>A payment within ±{INTERVALS.find(c => c.interval === interval)!.margin} days of the expected date and inside this range counts. No reminders are sent.</Note>
      <Action title={busy ? 'Saving…' : existingId ? 'Save changes' : 'Track it'} disabled={busy} onPress={() => void save()} />
      {existingId ? <Action title="Stop tracking" variant="ghost" disabled={busy} onPress={stop} /> : null}
    </View> : null}

    {view && existingId ? <View style={{ marginTop: 30 }}>
      <SectionTitle>Matched · {view.history.length}</SectionTitle>
      <View style={{ marginTop: 8 }}>{view.history.length ? view.history.map(t => <TransactionRow key={t.id} transaction={t} />) : <Caption>Nothing matched yet.</Caption>}</View>
    </View> : null}
  </Screen>;
}
