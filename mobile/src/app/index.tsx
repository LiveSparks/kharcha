import React from 'react';
import { Redirect } from 'expo-router';
import { useLedger } from '@/state/LedgerProvider';
import { Body, Caption, LoadingScreen, Screen, ScreenHead } from '@/ui/Kit';

export default function Index() {
  const { ready, preferences, error } = useLedger();
  if (!ready) return <LoadingScreen />;
  // A ledger that failed to open must not look like a fresh install: onboarding would
  // invite setting up again over data that is still there.
  if (error && !preferences.onboardingDone) return <Screen>
    <ScreenHead title="Couldn't open your ledger" />
    <Body muted>Your data is still on this phone. Update or reopen Kharcha; if this keeps happening, keep this message for support.</Body>
    <Caption style={{ marginTop: 16 }}>{error}</Caption>
  </Screen>;
  return <Redirect href={preferences.onboardingDone ? '/(tabs)/home' : '/onboarding'} />;
}
