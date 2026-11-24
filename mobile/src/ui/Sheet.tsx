import React from 'react';
import { Modal, Pressable, ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CategoryDot } from './Kit';
import { Icon } from './Icon';
import { fonts, usePalette } from './theme';
import type { Category } from '@/lib/model';

export interface PickerOption { key: string; label: string; on: boolean; dot?: Category; pick: () => void }

// A bottom sheet with one choice per row (Ledger filters, transfer accounts).
export function PickerSheet({ open, title, options, onClose }: {
  open: boolean; title: string; onClose: () => void;
  options: PickerOption[];
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  if (!open) return null;
  return <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.5)', justifyContent: 'flex-end' }}>
      <Pressable accessibilityViewIsModal style={{ backgroundColor: p.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 18, paddingBottom: 20 + insets.bottom, maxHeight: '75%' }}>
        <Text accessibilityRole="header" style={{ fontFamily: fonts.displayMedium, fontSize: 19, color: p.ink, paddingHorizontal: 20, marginBottom: 8 }}>{title}</Text>
        <ScrollView>
          {options.map(o => <Pressable key={o.key} accessibilityRole="radio" accessibilityState={{ checked: o.on }} onPress={o.pick}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, minHeight: 48, backgroundColor: pressed ? p.sunk : 'transparent' })}>
            {o.dot ? <CategoryDot category={o.dot} /> : null}
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: o.on ? fonts.bodyMedium : fonts.body, fontSize: 15, color: p.ink }}>{o.label}</Text>
            {o.on ? <Icon name="check" color={p.leaf} size={18} /> : null}
          </Pressable>)}
        </ScrollView>
      </Pressable>
    </Pressable>
  </Modal>;
}
