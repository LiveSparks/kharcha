import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Action } from '@/ui/Kit';
import { fonts, usePalette } from '@/ui/theme';
import { closeDialog, subscribeDialogs } from '@/ui/dialog';
import type { DialogRequest } from '@/ui/dialog';

// Draws the first queued message or confirmation as a card over the current screen.
export function DialogHost() {
  const p = usePalette();
  const [queue, setQueue] = useState<readonly DialogRequest[]>([]);
  useEffect(() => subscribeDialogs(setQueue), []);
  const current = queue[0];
  if (!current) return null;
  const dismiss = () => closeDialog(current.id, false);
  return <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={dismiss}>
    <Pressable accessibilityLabel="Close" onPress={current.confirm ? dismiss : undefined}
      style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'center', padding: 24 }}>
      <Pressable accessibilityViewIsModal accessibilityRole="alert"
        style={{ backgroundColor: p.surface, borderRadius: 20, borderWidth: 1, borderColor: p.line, padding: 22, gap: 10, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
        <Text accessibilityRole="header" style={{ fontFamily: fonts.displayMedium, fontSize: 21, lineHeight: 27, color: p.ink }}>{current.title}</Text>
        {current.message ? <Text style={{ fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: p.muted }}>{current.message}</Text> : null}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
          {current.confirm ? <>
            <Action compact variant="ghost" title="Cancel" onPress={dismiss} />
            <Pressable accessibilityRole="button" accessibilityLabel={current.confirm.action} onPress={() => closeDialog(current.id, true)}
              style={({ pressed }) => ({ minHeight: 38, paddingHorizontal: 14, borderRadius: 12, backgroundColor: p.debit, justifyContent: 'center', opacity: pressed ? .82 : 1 })}>
              <Text style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color: p.bg }}>{current.confirm.action}</Text>
            </Pressable>
          </> : <Action compact title="OK" onPress={dismiss} />}
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}
