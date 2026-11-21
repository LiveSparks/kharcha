import React from 'react';
import { Text, View } from 'react-native';
import { fonts, usePalette } from '@/ui/theme';
import { Caption } from '@/ui/Kit';
import { useScanProgress } from '@/state/LedgerProvider';
import type { ScanStatus } from '@/state/LedgerProvider';

const count = new Intl.NumberFormat('en-IN');

// One bar for the whole read. Each step fills its own stretch: opening the inbox is a short
// lead-in, then parsing, checking against the ledger, and adding the new rows (the long
// one on a first scan, when everything is new).
const STRETCH = { reading: [0, 0.03], parsing: [0.03, 0.35], checking: [0.35, 0.5], adding: [0.5, 1] } as const;

export function scanFraction(s: ScanStatus): number {
  const [from, to] = STRETCH[s.phase];
  return from + (to - from) * (s.total ? Math.min(1, s.done / s.total) : 0);
}

export function scanLabel(s: ScanStatus): string {
  const of = `${count.format(s.done)} of ${count.format(s.total)}`;
  if (s.phase === 'reading') return 'Opening your inbox…';
  if (s.phase === 'parsing') return `Reading bank messages · ${of}`;
  if (s.phase === 'checking') return `Checking against your ledger · ${of}`;
  return `Adding new entries · ${of}`;
}

// Shown while a whole-inbox read runs (the first scan, or Read new bank SMS).
export function ScanProgressBar() {
  const p = usePalette();
  const status = useScanProgress();
  if (!status) return null;
  const percent = Math.round(scanFraction(status) * 100);
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={scanLabel(status)}
    accessibilityValue={{ min: 0, max: 100, now: percent }}
    style={{ backgroundColor: p.surface, borderRadius: 12, padding: 15, marginBottom: 17, gap: 10 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Text style={{ fontFamily: fonts.bodyMedium, color: p.ink, flexShrink: 1 }}>{scanLabel(status)}</Text>
      <Text style={{ fontFamily: fonts.mono, color: p.muted }}>{percent}%</Text>
    </View>
    <View style={{ height: 6, borderRadius: 3, backgroundColor: p.line, overflow: 'hidden' }}>
      <View style={{ width: `${percent}%`, height: 6, borderRadius: 3, backgroundColor: p.leaf }} />
    </View>
    <Caption>Reading every bank message on this phone. You can keep using the app.</Caption>
  </View>;
}
