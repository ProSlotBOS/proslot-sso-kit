/**
 * @proslot/sso-kit — framework-agnostic SSO client
 *
 * The protocol half of the kit: build the hub redirect, exchange the auth
 * code, resolve the user's role. No React, so it is testable in isolation and
 * reusable from native shells.
 */

import type { SSOKitConfig, SSOClientConfig, SSOTokenResponse, GlobalProfile } from './types';
import { DEFAULTS } from './types';

const cfgApi = (c: SSOKitConfig) => c.apiBase ?? DEFAULTS.apiBase;
const cfgHub = (c: SSOKitConfig) => c.hubUrl ?? DEFAULTS.hubUrl;

/**
 * The redirect URI this app will be sent back to. MUST exactly match one of
 * the client's registered allowedRedirectUris — including the '#' for
 * HashRouter apps, which is the single most common integration mistake.
 *
 * `origin` is explicit-able so this stays callable outside a browser (tests,
 * SSR, and native shells where the callback is a custom scheme such as
 * `com.proslot.bos://auth/callback`).
 */
export function buildRedirectUri(config: SSOKitConfig, origin?: string): string {
  const base =
    origin ??
    config.nativeRedirectUri ??
    (typeof window !== 'undefined' ? window.location.origin : '');
  // A native custom-scheme URI is already complete — don't append a path.
  if (!origin && config.nativeRedirectUri) return config.nativeRedirectUri;
  const path = config.callbackPath ?? DEFAULTS.callbackPath;
  return config.hashRouter ? `${base}/#${path}` : `${base}${path}`;
}

/** Send the browser to the hub to authenticate. */
export function initiateSSO(
  config: SSOKitConfig,
  opts: { mode?: 'login' | 'signup'; returnTo?: string } = {}
): void {
  const redirectUri = buildRedirectUri(config);
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri });
  if (config.appName) params.set('app_name', config.appName);
  if (opts.mode === 'signup') params.set('mode', 'signup');
  if (opts.returnTo) params.set('state', opts.returnTo);
  window.location.href = `${cfgHub(config)}/auth/sso?${params.toString()}`;
}

/** Fetch branding/role config from the hub (Firestore-backed source of truth). */
export async function fetchClientConfig(config: SSOKitConfig): Promise<SSOClientConfig | null> {
  try {
    const res = await fetch(`${cfgApi(config)}/api/sso/client-config/${encodeURIComponent(config.clientId)}`);
    return res.ok ? ((await res.json()) as SSOClientConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Read the auth code from the URL. Handles plain query strings AND the
 * hash-router form (`/#/auth/callback?code=...`), which several satellites
 * had to hand-roll individually.
 */
export function readAuthCodeFromUrl(href = window.location.href): { code: string | null; returnTo: string | null } {
  const url = new URL(href);
  const search = new URLSearchParams(url.search);
  const hashQuery = new URLSearchParams(url.hash.includes('?') ? url.hash.split('?')[1] : '');
  return {
    code: search.get('code') ?? hashQuery.get('code'),
    returnTo: search.get('returnTo') ?? hashQuery.get('returnTo') ?? search.get('state') ?? hashQuery.get('state'),
  };
}

/** Exchange a single-use auth code for a Firebase custom token + profile. */
export async function exchangeCode(config: SSOKitConfig, code: string): Promise<SSOTokenResponse> {
  const res = await fetch(`${cfgApi(config)}/api/sso/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId: config.clientId,
      redirectUri: buildRedirectUri(config),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Token exchange failed (HTTP ${res.status})`);
  return data as SSOTokenResponse;
}

/**
 * Resolve the user's role for this org.
 *
 * Prefers the token response (authoritative — the hub just computed it), then
 * the profile's org membership, then the root role. Satellites previously
 * disagreed here: some re-fetched /api/users/by-firebase-uid on every login,
 * costing a round trip and occasionally racing the write that had just
 * happened during auto-join.
 */
export function resolveRole(token: SSOTokenResponse, clientOrgId?: string): string {
  const orgId = clientOrgId ?? token.orgId;
  if (token.role) return token.role.toUpperCase();
  const membership = (token.globalProfile?.organizations || []).find((o) => o.orgId === orgId);
  return (membership?.role || token.globalProfile?.role || 'USER').toUpperCase();
}

/** Choose the post-login destination for a role. `returnTo` always wins. */
export function resolveDestination(
  config: SSOKitConfig,
  role: string,
  returnTo?: string | null
): string {
  if (returnTo && returnTo.startsWith('/')) return returnTo; // never allow off-site redirects
  return config.postLoginRoutes[role.toUpperCase()] ?? config.postLoginRoutes.default;
}

/** Cache the profile so the app's auth context can render immediately. */
export function primeProfile(config: SSOKitConfig, profile: GlobalProfile, role: string): void {
  if (config.primeLocalStorage === false) return;
  try {
    const key = config.profileStorageKey ?? DEFAULTS.profileStorageKey;
    localStorage.setItem(key, JSON.stringify({ ...profile, role, cachedAt: Date.now() }));
  } catch {
    /* private browsing / quota — non-fatal */
  }
}

export function readPrimedProfile(config: SSOKitConfig): (GlobalProfile & { role?: string }) | null {
  try {
    const raw = localStorage.getItem(config.profileStorageKey ?? DEFAULTS.profileStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
