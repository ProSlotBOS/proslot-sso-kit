/**
 * @proslot/sso-kit — <SSOCallback />
 *
 * The one correct callback implementation, replacing ~9 hand-diverged copies
 * (120–275 lines each) across the satellite fleet. Mount it at the app's
 * callback path; all per-site behaviour comes from SSOKitConfig.
 *
 * Handles, uniformly:
 *   - query-string AND hash-router (`/#/auth/callback?code=`) code extraction
 *   - StrictMode / re-render double-exchange guard (codes are single-use —
 *     a second exchange returns 401 and used to surface as a bogus error)
 *   - role resolution without an extra round trip
 *   - returnTo, restricted to same-site paths
 *   - optional onboarding gate for new users
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Auth } from 'firebase/auth';
import { signInWithCustomToken } from 'firebase/auth';
import type { SSOKitConfig } from './types.js';
import {
  readAuthCodeFromUrl, exchangeCode, resolveDestination, primeProfile, readPrimedProfile, buildPostLoginContext,
  initiateSSO,
} from './client.js';

/**
 * A one-time auth code that is gone, spent, or older than the hub's five-minute
 * TTL. This is not a fault: it is what a stale callback URL out of history, a
 * back button, or a browser left sitting on the callback looks like. The user
 * simply needs a fresh code.
 *
 * It used to surface as a red "Sign-In Failed · Auth code expired" with a Try
 * Again button that went to the home page rather than back into sign-in, and it
 * was logged with console.error, so Tracer opened a production error for it —
 * Stan Musial, 6 Sep 2026, zero affected users.
 */
const STALE_CODE = /auth code expired|invalid or expired auth code|auth code (not found|already used)/i;
export const isStaleAuthCode = (message: string): boolean => STALE_CODE.test(String(message || ''));

/**
 * The callback ran in a browsing context that never held the PKCE verifier.
 *
 * The verifier lives in sessionStorage, which is per-tab: if the hub comes back
 * in a different tab from the one that started sign-in — a link opened in a new
 * tab, a restored session — the code carries a challenge that this tab cannot
 * answer, and the hub correctly refuses the exchange.
 *
 * Like a stale code, this is not a fault and not something the person can act
 * on. Boys of Summer, 12 Sep 2026: a coach on iOS Safari was shown "Sign-In
 * Failed · code_verifier is required for this authorization code" — wording
 * that means nothing to them — for what one fresh attempt fixes.
 *
 * Recovering is safe precisely because it does NOT weaken the check: restarting
 * mints a new code with a new challenge and a verifier in THIS context. Nothing
 * is downgraded, and a code that was already intercepted is not made usable.
 */
const MISSING_VERIFIER = /code_verifier is required/i;
export const isMissingVerifier = (message: string): boolean =>
  MISSING_VERIFIER.test(String(message || ''));

/**
 * One-shot guard against restarting forever.
 *
 * Kept in sessionStorage on purpose: if storage is unavailable the flag cannot
 * persist, but neither can a verifier, so restarting could never succeed — the
 * read failing is itself the signal to stop and show the message instead.
 */
const PKCE_RETRY_KEY = 'proslot_sso_pkce_retry';

function mayRestartForVerifier(): boolean {
  try {
    if (sessionStorage.getItem(PKCE_RETRY_KEY)) return false;
    sessionStorage.setItem(PKCE_RETRY_KEY, '1');
    // Storage that silently discards writes would loop; confirm it took.
    return sessionStorage.getItem(PKCE_RETRY_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearPkceRetryFlag(): void {
  try { sessionStorage.removeItem(PKCE_RETRY_KEY); } catch { /* ignore */ }
}

export interface SSOCallbackProps {
  config: SSOKitConfig;
  /** The app's Firebase Auth instance. */
  auth: Auth;
  /** Navigation. Pass react-router's navigate, or omit for window.location. */
  navigate?: (to: string, opts?: { replace?: boolean }) => void;
  /** Optional custom UI. Defaults to a neutral spinner/error card. */
  renderPending?: () => React.ReactNode;
  renderError?: (error: string, retry: () => void) => React.ReactNode;
  /** Fires after successful sign-in, before redirect. */
  onSuccess?: (info: { role: string; orgId: string; isNewUser: boolean }) => void;
}

/** First name, last name, and phone are the account minimum fleet-wide. */
function missingProfileFields(profile: { firstName?: string; lastName?: string; phone?: string }) {
  const missing: ('firstName' | 'lastName' | 'phone')[] = [];
  if (!String(profile.firstName || '').trim()) missing.push('firstName');
  if (!String(profile.lastName || '').trim()) missing.push('lastName');
  if (!String(profile.phone || '').trim()) missing.push('phone');
  return missing;
}

export function SSOCallback({
  config, auth, navigate, renderPending, renderError, onSuccess,
}: SSOCallbackProps) {
  const [error, setError] = useState<string>('');
  const [profileGate, setProfileGate] = useState<{
    uid: string; destination: string;
    firstName: string; lastName: string; phone: string;
    role: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  /** The code was expired or already spent — recoverable, not a failure. */
  const [stale, setStale] = useState(false);
  const exchanged = useRef(false);
  const returnToRef = useRef<string | null>(null);

  const go = (to: string) => {
    if (navigate) navigate(to, { replace: true });
    else window.location.replace(to);
  };

  useEffect(() => {
    // Auth codes are single-use; React StrictMode mounts effects twice in dev
    // and a second exchange 401s. Guard before any async work.
    if (exchanged.current) return;
    exchanged.current = true;

    (async () => {
      const { code, returnTo } = readAuthCodeFromUrl();
      returnToRef.current = returnTo;
      if (!code) {
        setError('No authorization code received. Please try signing in again.');
        return;
      }
      try {
        const token = await exchangeCode(config, code);
        // Sign-in completed, so the one restart is spent and available again to
        // a later flow in this tab. Leaving it set would turn a real failure
        // weeks later into a dead end on its first occurrence.
        clearPkceRetryFlag();
        await signInWithCustomToken(auth, token.customToken);

        const ctx = buildPostLoginContext(token, returnTo, token.orgId);

        primeProfile(config, token.globalProfile, ctx.role);
        onSuccess?.({ role: ctx.role, orgId: ctx.orgId, isNewUser: ctx.isNewUser });

        const gated = config.onboardingGate?.({
          role: ctx.role, profile: ctx.profile, isNewUser: ctx.isNewUser,
        });
        const destination = gated ?? resolveDestination(config, ctx);

        // Profile-completion gate: every account needs a first name, last
        // name, and phone. Historical signup paths let accounts through
        // without them; repair here, before entering the app.
        const p = token.globalProfile || {};
        const uid = String(p.uid || auth.currentUser?.uid || '');
        if (config.requireCompleteProfile !== false && uid && missingProfileFields(p).length > 0) {
          setProfileGate({
            uid, destination,
            firstName: String(p.firstName || '').trim(),
            lastName: String(p.lastName || '').trim(),
            phone: String(p.phone || '').trim(),
            role: ctx.role,
          });
          return;
        }
        go(destination);
      } catch (err: any) {
        const message = err?.message || '';
        if (isStaleAuthCode(message)) {
          // Expected and self-correcting: warn (so Tracer does not open an
          // error for it) and offer a fresh sign-in in plain words.
          console.warn('[sso-kit] auth code no longer valid; asking for a fresh sign-in');
          setStale(true);
          return;
        }
        if (isMissingVerifier(message)) {
          // This tab never held the verifier. Start again rather than stranding
          // the person behind wording they cannot act on; the restart mints a
          // fresh code and challenge, so the check is not weakened.
          if (mayRestartForVerifier()) {
            console.warn('[sso-kit] no PKCE verifier in this context; restarting sign-in once');
            initiateSSO(config, { returnTo: returnToRef.current || undefined });
            return;
          }
          console.warn('[sso-kit] PKCE verifier still unavailable after a restart; asking for a fresh sign-in');
          setStale(true);
          return;
        }
        console.error('[sso-kit] exchange failed:', err);
        setError(err?.message || 'Failed to complete sign-in. Please try again.');
      }
    })();
    // Intentionally run once — config/auth are stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileGate) return;
    const firstName = profileGate.firstName.trim();
    const lastName = profileGate.lastName.trim();
    const phone = profileGate.phone.trim();
    if (!firstName || !lastName) { setSaveError('First and last name are required.'); return; }
    if (phone.replace(/\D/g, '').length < 10) { setSaveError('Please enter a valid phone number.'); return; }
    setSaving(true);
    setSaveError('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const apiBase = config.apiBase ?? 'https://proslot-api-473053764604.us-central1.run.app';
      const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(profileGate.uid)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ firstName, lastName, phone }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not save your details (${res.status}).`);
      }
      // Refresh the primed cache so the app boots with the completed profile.
      const primed = readPrimedProfile(config) || {};
      primeProfile(config, { ...primed, uid: profileGate.uid, firstName, lastName, phone }, profileGate.role);
      go(profileGate.destination);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not save your details. Please try again.');
      setSaving(false);
    }
  };

  const retry = () => go('/');
  /** Restart the flow at the hub so a fresh code is minted. */
  const signInAgain = () => initiateSSO(config, { returnTo: returnToRef.current || undefined });

  if (profileGate) {
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, textAlign: 'left', width: '100%', maxWidth: 420 }}>
          <h2 style={{ ...S.h2, textAlign: 'center' }}>Complete Your Profile</h2>
          <p style={{ ...S.sub, textAlign: 'center', marginBottom: 24 }}>
            We just need a couple of details before you continue.
          </p>
          <form onSubmit={submitProfile}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                style={S.input} placeholder="First name" autoComplete="given-name"
                value={profileGate.firstName}
                onChange={(e) => setProfileGate({ ...profileGate, firstName: e.target.value })}
              />
              <input
                style={S.input} placeholder="Last name" autoComplete="family-name"
                value={profileGate.lastName}
                onChange={(e) => setProfileGate({ ...profileGate, lastName: e.target.value })}
              />
            </div>
            <input
              style={{ ...S.input, marginTop: 10 }} placeholder="Phone number" type="tel" autoComplete="tel"
              value={profileGate.phone}
              onChange={(e) => setProfileGate({ ...profileGate, phone: e.target.value })}
            />
            {saveError && <p style={{ ...S.errText, margin: '12px 0 0' }}>{saveError}</p>}
            <button type="submit" disabled={saving} style={{ ...S.button, width: '100%', marginTop: 16, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Continue'}
            </button>
          </form>
        </div>
        <style>{`@keyframes proslot-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (stale) {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <h2 style={S.h2}>This sign-in link has expired</h2>
          <p style={S.sub}>
            Sign-in links are only good for a few minutes, and each one works once.
            Start again and you will be straight in.
          </p>
          <button onClick={signInAgain} style={S.button}>Sign In Again</button>
        </div>
      </div>
    );
  }

  if (error) {
    if (renderError) return <>{renderError(error, retry)}</>;
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.errIcon}>⚠</div>
          <h2 style={S.h2}>Sign-In Failed</h2>
          <p style={S.errText}>{error}</p>
          <button onClick={retry} style={S.button}>Try Again</button>
        </div>
      </div>
    );
  }

  if (renderPending) return <>{renderPending()}</>;
  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.spinner} />
        <h2 style={S.h2}>Establishing Session</h2>
        <p style={S.sub}>Completing secure sign-in…</p>
      </div>
      <style>{`@keyframes proslot-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#0B0B45' },
  card: { textAlign: 'center', maxWidth: 400 },
  spinner: { width: 48, height: 48, border: '3px solid rgba(148,163,184,0.15)', borderTopColor: '#10B981', borderRadius: '50%', animation: 'proslot-spin 0.8s linear infinite', margin: '0 auto 24px' },
  errIcon: { width: 48, height: 48, background: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', fontSize: 24 },
  h2: { color: '#F1F5F9', fontSize: 20, fontWeight: 700, margin: '0 0 8px' },
  sub: { color: '#94A3B8', fontSize: 14, margin: 0 },
  errText: { color: '#FCA5A5', fontSize: 14, margin: '0 0 24px' },
  button: { background: 'linear-gradient(135deg,#10B981,#059669)', color: '#FFF', border: 'none', borderRadius: 12, padding: '12px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  input: { flex: 1, width: '100%', boxSizing: 'border-box', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 10, padding: '12px 14px', fontSize: 14, color: '#F1F5F9', outline: 'none' },
};

export default SSOCallback;
