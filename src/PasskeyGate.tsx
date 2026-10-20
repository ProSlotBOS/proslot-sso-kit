/**
 * @proslotbosllc/sso-kit — <PasskeyGate />
 *
 * The passkey second factor for a site's admin and staff pages, on the API's
 * per-org switch (proslot: organizations/{orgId}/settings/passkey_mfa,
 * middleware/requireSchoolPasskey.js). When the org requires it, the API
 * refuses its staff routes to a staff sign-in until that sign-in has been
 * confirmed with a passkey (Face ID, Touch ID, a phone's fingerprint or PIN)
 * made for the site's own domain. Wrapped around those pages, this asks first,
 * so a page never half-loads into refusals: "Set up a passkey" the first time,
 * "Confirm it's you" after, then the page.
 *
 *   <PasskeyGate
 *     apiUrl={API_URL}
 *     org="yourorgid"                            // the org whose switch applies
 *     appName="Your Site"
 *     userKey={user?.uid}                         // null or undefined when signed out
 *     getIdToken={() => auth.currentUser?.getIdToken() ?? Promise.resolve(null)}
 *     onSignOut={() => signOut(auth)}
 *     onSignInAgain={() => signOut(auth).then(() => initiateSSO(ssoConfig, { returnTo: location.pathname }))}
 *   >
 *     <AdminConsole />
 *   </PasskeyGate>
 *
 * It checks again on window focus, every 10 minutes, and at once when any API
 * request comes back passkey_required, since a confirmation lasts the
 * policy's maxAgeHours (12 by default). People the API does not ask (families,
 * signed-out visitors) see the page with no delay beyond one status call. If
 * the status call fails, the page renders: the API is what enforces, so a
 * failed check here can only surface the page's own errors, never let
 * anything through.
 *
 * The domain the page is served on must be one of the API's relying parties
 * (services/passkeys.js TENANT_RPS); on any other host the API refuses to
 * make a passkey and this shows its message.
 *
 * Copied from KingdomMontessori's and ProslotBOS's own gates, which predate
 * it; new sites use this one.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

export interface PasskeyStatus { required: boolean; enrolled: boolean; verified: boolean; maxAgeHours: number }

const RECHECK_MS = 10 * 60 * 1000;
const REFUSAL_RECHECK_MS = 30 * 1000;
const REFUSED_EVENT = 'proslot:passkey-required';

class PasskeyApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const base = (apiUrl: string) => apiUrl.replace(/\/$/, '');

async function call<T>(apiUrl: string, token: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${base(apiUrl)}/api/auth/passkeys${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PasskeyApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data as T;
}

/** Where this sign-in stands for the org's site. Null when the check could not be made (the page then renders). */
export async function fetchPasskeyStatus(apiUrl: string, idToken: string, org: string): Promise<PasskeyStatus | null> {
  try {
    const s = await call<PasskeyStatus>(apiUrl, idToken, `/status?school=${encodeURIComponent(org)}`);
    return { required: !!s.required, enrolled: !!s.enrolled, verified: !!s.verified, maxAgeHours: Number(s.maxAgeHours) || 12 };
  } catch {
    return null;
  }
}

/** Is this API answer the passkey refusal? (403 with error passkey_required) */
export function isPasskeyRefusal(status: number, body: unknown): boolean {
  return status === 403 && !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'passkey_required';
}

const watched = new Set<string>();
/** Announces the API's passkey refusal the moment any request to it meets one (wraps fetch once per API address). */
function watchForRefusal(apiUrl: string) {
  const prefix = base(apiUrl);
  if (watched.has(prefix) || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  watched.add(prefix);
  const original = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const response = await original.call(window, input, init);
    const url = response.url || (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (response.status === 403 && url.startsWith(prefix)) {
      response.clone().json().then((b) => { if (isPasskeyRefusal(403, b)) window.dispatchEvent(new Event(REFUSED_EVENT)); }).catch(() => undefined);
    }
    return response;
  };
}

function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

function friendly(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out. Try again.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for your account. Use “Confirm it’s you” instead.';
  return e?.message || 'Something went wrong. Try again.';
}

export interface PasskeyGateProps {
  apiUrl: string;
  /** The org whose passkey switch applies (organizations/{org}/settings/passkey_mfa). */
  org: string;
  appName: string;
  /** Changes when the signed-in account changes (its uid); null or undefined when signed out. */
  userKey?: string | null;
  /** The signed-in account's Firebase ID token, or null. */
  getIdToken: () => Promise<string | null | undefined>;
  /** "Sign out" under the prompt. */
  onSignOut: () => void | Promise<void>;
  /** Setting up the first passkey needs a sign-in from the last 15 minutes; this starts one. */
  onSignInAgain: () => void | Promise<void>;
  /** Why the site asks, shown the first time. Defaults to a line naming appName. */
  reason?: string;
  /** A line at the foot, e.g. who to call for help. */
  help?: string;
  /** Button colour. */
  accent?: string;
  children?: React.ReactNode;
}

const C = { ink: '#121211', soft: '#6b675d', line: '#e8e4dc', bg: '#f4f2ec', error: '#b91c1c', errorBg: '#fef2f2' };

export function PasskeyGate({ apiUrl, org, appName, userKey, getIdToken, onSignOut, onSignInAgain, reason, help, accent = C.ink, children }: PasskeyGateProps) {
  const [status, setStatus] = useState<PasskeyStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsFreshSignIn, setNeedsFreshSignIn] = useState(false);

  const refresh = useCallback(async () => {
    const token = await getIdToken().catch(() => null);
    if (!token) { setChecked(true); return; }
    setStatus(await fetchPasskeyStatus(apiUrl, token, org));
    setChecked(true);
    // getIdToken is usually an inline arrow; the account (userKey) is what should re-trigger the check.
  }, [apiUrl, org, userKey]);

  useEffect(() => {
    setStatus(null);
    setChecked(false);
    setError(null);
    setNeedsFreshSignIn(false);
    if (!userKey) return undefined;
    void Promise.resolve().then(refresh);
    watchForRefusal(apiUrl);
    const timer = setInterval(refresh, RECHECK_MS);
    const onFocus = () => void refresh();
    let last = 0;
    const onRefused = () => {
      if (Date.now() - last < REFUSAL_RECHECK_MS) return;
      last = Date.now();
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(REFUSED_EVENT, onRefused);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(REFUSED_EVENT, onRefused);
    };
  }, [userKey, apiUrl, refresh]);

  const run = async (kind: 'enroll' | 'verify') => {
    setBusy(true);
    setError(null);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('You are signed out. Sign in again to continue.');
      if (kind === 'enroll') {
        const optionsJSON = await call<Parameters<typeof startRegistration>[0]['optionsJSON']>(apiUrl, token, '/registration/options', 'POST', {});
        const response = await startRegistration({ optionsJSON });
        await call(apiUrl, token, '/registration/verify', 'POST', { response, label: deviceLabel() });
      } else {
        const optionsJSON = await call<Parameters<typeof startAuthentication>[0]['optionsJSON']>(apiUrl, token, '/authentication/options', 'POST', {});
        const response = await startAuthentication({ optionsJSON });
        await call(apiUrl, token, '/authentication/verify', 'POST', { response });
      }
      await refresh();
    } catch (err) {
      if (err instanceof PasskeyApiError && err.code === 'REAUTH_REQUIRED') setNeedsFreshSignIn(true);
      else if (err instanceof PasskeyApiError && err.code === 'PASSKEY_VERIFY') await refresh();
      else setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  // Signed out: the page decides (it sends a visitor to sign in).
  if (!userKey) return <>{children}</>;
  if (!checked) {
    return (
      <div aria-busy="true" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', border: `3px solid ${C.line}`, borderTopColor: accent, animation: 'proslot-pk-spin .8s linear infinite' }} />
        <style>{'@keyframes proslot-pk-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){[aria-busy="true"]>div{animation:none!important}}'}</style>
      </div>
    );
  }
  if (!status || !status.required || status.verified) return <>{children}</>;

  const supported = browserSupportsWebAuthn();
  const firstTime = !status.enrolled;
  const button = (disabled: boolean): React.CSSProperties => ({
    width: '100%', minHeight: 44, padding: '12px 0', border: 0, borderRadius: 999, fontSize: 15, fontWeight: 600, color: '#fff',
    background: accent, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
  });

  return (
    <div data-testid="passkey-gate" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: C.bg, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <div role="dialog" aria-labelledby="proslot-passkey-title" style={{ width: '100%', maxWidth: 420, background: '#fff', borderRadius: 16, border: `1px solid ${C.line}`, padding: '32px 28px 24px', textAlign: 'center' }}>
        <div aria-hidden="true" style={{ width: 56, height: 56, margin: '0 auto 18px', borderRadius: '50%', background: C.bg, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <h1 id="proslot-passkey-title" style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: C.ink }}>{firstTime ? 'Set up a passkey' : 'Confirm it’s you'}</h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, color: C.soft }}>
          {firstTime
            ? reason || `${appName}’s admin pages hold families’ information, so each sign-in is confirmed with a passkey. Use Face ID, Touch ID, or your phone’s fingerprint or PIN. Nothing is typed.`
            : `Use your passkey (Face ID, Touch ID, or your phone’s fingerprint or PIN) to continue. You’ll be asked again after ${status.maxAgeHours} hours or when you next sign in.`}
        </p>
        {!supported && <p role="alert" style={{ margin: '0 0 14px', padding: 12, borderRadius: 12, fontSize: 13, color: C.error, background: C.errorBg }}>This browser can’t use passkeys. Open this page in Safari, Chrome or Edge.</p>}
        {error && <p role="alert" style={{ margin: '0 0 14px', padding: 12, borderRadius: 12, fontSize: 13, color: C.error, background: C.errorBg }}>{error}</p>}
        {needsFreshSignIn ? (
          <>
            <p style={{ margin: '0 0 14px', fontSize: 14, color: C.ink }}>For safety, setting up your first passkey needs a fresh sign-in.</p>
            <button type="button" onClick={() => { void onSignInAgain(); }} style={button(false)}>Sign in again</button>
          </>
        ) : (
          <button type="button" data-testid="passkey-gate-action" disabled={busy || !supported} onClick={() => { void run(firstTime ? 'enroll' : 'verify'); }} style={button(busy || !supported)}>
            {busy ? 'Waiting for your passkey…' : firstTime ? 'Set up passkey' : 'Use passkey'}
          </button>
        )}
        <button type="button" onClick={() => { void onSignOut(); }} style={{ marginTop: 14, minHeight: 44, background: 'none', border: 0, fontSize: 13, color: C.soft, textDecoration: 'underline', cursor: 'pointer' }}>
          Sign out
        </button>
        {help && <p style={{ margin: '10px 0 0', fontSize: 12, color: C.soft }}>{help}</p>}
      </div>
    </div>
  );
}

export default PasskeyGate;
