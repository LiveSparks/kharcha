import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { CATEGORIES } from '@/lib/model';
import type { Category } from '@/lib/model';
import { CategoryDot, Caption, Label } from './Kit';
import { fonts, usePalette } from './theme';

export function Field({ label, value, onChangeText, placeholder, numeric = false, multiline = false, autoCapitalize = 'sentences' }: {
  label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; numeric?: boolean; multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  const p = usePalette();
  return <View style={{ gap: 8 }}><Label>{label}</Label><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={p.muted}
    keyboardType={numeric ? 'decimal-pad' : 'default'} multiline={multiline} autoCapitalize={autoCapitalize} selectionColor={p.focus}
    style={{ minHeight: multiline ? 135 : 50, paddingHorizontal: 14, paddingVertical: 12, textAlignVertical: multiline ? 'top' : 'center', borderRadius: 11,
      borderWidth: 1, borderColor: p.strongLine, color: p.ink, backgroundColor: p.surface, fontFamily: multiline ? fonts.monoRegular : fonts.body, fontSize: 15, lineHeight: multiline ? 21 : undefined }} /></View>;
}

export function CategoryPicker({ value, onChange }: { value: Category; onChange: (category: Category) => void }) {
  const p = usePalette();
  return <View style={{ gap: 9 }}><Label>Category</Label><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {CATEGORIES.map(category => <Pressable accessibilityRole="radio" accessibilityState={{ checked: value === category }} key={category} onPress={() => onChange(category)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 35, paddingHorizontal: 10, borderRadius: 9,
      backgroundColor: value === category ? p.leaf : p.surface, borderWidth: value === category ? 0 : 1, borderColor: p.line }}><CategoryDot category={category} /><Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: value === category ? p.onLeaf : p.ink }}>{category}</Text></Pressable>)}
  </View></View>;
}

export function Note({ children }: { children: React.ReactNode }) { return <Caption style={{ lineHeight: 19 }}>{children}</Caption>; }

// Optional category (a payee's default): "None" keeps each row's own category.
export function OptionalCategoryPicker({ label, value, onChange }: { label: string; value: Category | null; onChange: (category: Category | null) => void }) {
  const p = usePalette();
  const options: (Category | null)[] = [null, ...CATEGORIES];
  return <View style={{ gap: 9 }}><Label>{label}</Label><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {options.map(category => <Pressable accessibilityRole="radio" accessibilityState={{ checked: value === category }} key={category ?? 'none'} onPress={() => onChange(category)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 35, paddingHorizontal: 10, borderRadius: 9,
      backgroundColor: value === category ? p.leaf : p.surface, borderWidth: value === category ? 0 : 1, borderColor: p.line }}>{category ? <CategoryDot category={category} /> : null}<Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: value === category ? p.onLeaf : p.ink }}>{category ?? 'None'}</Text></Pressable>)}
  </View></View>;
}
