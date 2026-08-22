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
  readAuthCodeFromUrl, exchangeCode, resolveDestination, primeProfile, buildPostLoginContext,
} from './client.js';

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

export function SSOCallback({
  config, auth, navigate, renderPending, renderError, onSuccess,
}: SSOCallbackProps) {
  const [error, setError] = useState<string>('');
  const exchanged = useRef(false);

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
      if (!code) {
        setError('No authorization code received. Please try signing in again.');
        return;
      }
      try {
        const token = await exchangeCode(config, code);
        await signInWithCustomToken(auth, token.customToken);

        const ctx = buildPostLoginContext(token, returnTo, token.orgId);

        primeProfile(config, token.globalProfile, ctx.role);
        onSuccess?.({ role: ctx.role, orgId: ctx.orgId, isNewUser: ctx.isNewUser });

        const gated = config.onboardingGate?.({
          role: ctx.role, profile: ctx.profile, isNewUser: ctx.isNewUser,
        });
        go(gated ?? resolveDestination(config, ctx));
      } catch (err: any) {
        console.error('[sso-kit] exchange failed:', err);
        setError(err?.message || 'Failed to complete sign-in. Please try again.');
      }
    })();
    // Intentionally run once — config/auth are stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => go('/');

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
};

export default SSOCallback;
