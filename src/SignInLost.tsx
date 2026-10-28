/**
 * @proslotbosllc/sso-kit — <SignInLostNotice /> and the lost-sign-in signal.
 *
 * Tells a signed-in person when their sign-in has stopped working, and lets
 * them sign in again. Boys of Summer, 28 Oct 2026: an admin's tab left open
 * overnight missed its token refresh during a five-second network drop. For
 * ten minutes every signed-in call was refused, a game edit included, while
 * the page went on showing him signed in, with nothing to say why nothing
 * loaded or saved.
 *
 * The api-client-kit decides when that has happened (a 401 that a fresh token
 * did not fix, while the site shows someone signed in) and reports it here:
 *
 *   createApiClient({ ..., getToken: firebaseTokenGetter(() => auth.currentUser),
 *     isSignedIn: () => !!auth.currentUser,
 *     onSignInLost: reportSignInLost, onSignInRestored: clearSignInLost });
 *
 *   // near the site's root, once
 *   <SignInLostNotice onSignInAgain={() => signOut(auth).then(() => initiateSSO(ssoConfig, { returnTo }))} />
 *
 * Signing in again goes through the SSO hub like any other sign-in; nothing
 * here keeps a session alive or extends one. Styles are inline, so it renders
 * the same whatever CSS the site uses.
 */

import React, { useState, useSyncExternalStore } from 'react';

let lost = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** The person's sign-in stopped working: the API refuses their requests as signed out. */
export function reportSignInLost(): void {
  if (lost) return;
  lost = true;
  emit();
}

/** Their requests are accepted again (a later refresh worked, or they signed in). */
export function clearSignInLost(): void {
  if (!lost) return;
  lost = false;
  emit();
}

export function isSignInLost(): boolean {
  return lost;
}

/** Calls listener whenever the lost-sign-in state changes; returns the unsubscribe. */
export function onSignInLostChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface SignInLostNoticeProps {
  /** Sign out and hand off to the SSO hub, returning to the current page. */
  onSignInAgain: () => void | Promise<void>;
  /** Button colour. Default near-black. */
  accent?: string;
}

const C = { ink: '#121211', soft: '#6b675d', line: '#e8e4dc' };

export function SignInLostNotice({ onSignInAgain, accent = C.ink }: SignInLostNoticeProps) {
  const isLost = useSyncExternalStore(onSignInLostChange, isSignInLost, () => false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!isLost || hidden) return null;

  const signInAgain = async () => {
    setBusy(true);
    try {
      await onSignInAgain();
    } catch (err) {
      console.warn('[sso-kit] Signing in again did not start:', err instanceof Error ? err.message : 'unknown');
      setBusy(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="sign-in-lost"
      style={{
        position: 'fixed', zIndex: 2147483000, left: 16, right: 16,
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        margin: '0 auto', maxWidth: 520, boxSizing: 'border-box',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
        padding: '14px 16px', borderRadius: 12, background: '#fff', border: `1px solid ${C.line}`,
        boxShadow: '0 8px 24px rgba(18,18,17,.18)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.ink }}>Your sign-in has expired</p>
        <p style={{ margin: '2px 0 0', fontSize: 14, lineHeight: 1.45, color: C.soft }}>
          Sign in again to keep working. Changes made until then are not saved.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button
          type="button"
          onClick={() => setHidden(true)}
          style={{ minHeight: 44, padding: '0 14px', borderRadius: 10, border: `1px solid ${C.line}`, background: '#fff', color: C.ink, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="sign-in-lost-action"
          disabled={busy}
          onClick={() => { void signInAgain(); }}
          style={{ minHeight: 44, padding: '0 16px', borderRadius: 10, border: 0, background: accent, color: '#fff', fontSize: 14, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}
        >
          {busy ? 'Opening sign-in…' : 'Sign in again'}
        </button>
      </div>
    </div>
  );
}
