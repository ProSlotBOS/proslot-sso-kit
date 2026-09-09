/**
 * @proslot/sso-kit — framework-agnostic SSO client
 *
 * The protocol half of the kit: build the hub redirect, exchange the auth
 * code, resolve the user's role. No React, so it is testable in isolation and
 * reusable from native shells.
 */

import type { SSOKitConfig, SSOClientConfig, SSOTokenResponse, GlobalProfile, PostLoginContext } from './types.js';
import { DEFAULTS, isPrivilegedRole } from './types.js';

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
const REDIRECT_MEMO_KEY = 'proslot_sso_redirect_uri';
const VERIFIER_MEMO_KEY = 'proslot_sso_code_verifier';

/**
 * PKCE (RFC 7636). Most ProSlot SSO clients are public — no usable secret in a
 * browser bundle — and the native ones come back on a custom scheme
 * (com.example://auth/callback) that any app on the device can claim. Without
 * PKCE an intercepted code is exchangeable on its own, which is account
 * takeover; with it the interceptor also needs a verifier they never saw.
 * RFC 8252 requires this for native apps.
 *
 * The verifier stays in sessionStorage and never leaves the device until the
 * exchange; only its SHA-256 hash travels through the hub and the redirect.
 */
const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function createCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return b64url(bytes); // 64 chars, inside RFC 7636's 43-128
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export async function initiateSSO(
  config: SSOKitConfig,
  opts: { mode?: 'login' | 'signup'; returnTo?: string } = {}
): Promise<void> {
  const redirectUri = buildRedirectUri(config);
  // Remember EXACTLY what we sent to /authorize. The hub re-verifies
  // redirect_uri on /token when it is provided, and a native flow starts from
  // a custom scheme (com.example://auth/callback) that a web-derived URI would
  // never match. Round-tripping the real value keeps the stricter check on
  // without breaking native.
  try { sessionStorage.setItem(REDIRECT_MEMO_KEY, redirectUri); } catch { /* ignore */ }
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri });
  if (config.appName) params.set('app_name', config.appName);
  if (opts.mode === 'signup') params.set('mode', 'signup');
  if (opts.returnTo) params.set('state', opts.returnTo);

  // Best-effort: a browser without WebCrypto (or with storage blocked) simply
  // completes the flow without PKCE, exactly as before. The hub only demands a
  // verifier for a code that was issued with a challenge, so degrading here
  // cannot strand a user — and a client whose sso_clients doc sets
  // requirePkce will refuse the flow rather than silently accept less.
  try {
    const verifier = createCodeVerifier();
    const challenge = await codeChallengeFor(verifier);
    sessionStorage.setItem(VERIFIER_MEMO_KEY, verifier);
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  } catch {
    try { sessionStorage.removeItem(VERIFIER_MEMO_KEY); } catch { /* ignore */ }
  }

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

/**
 * Exchange a single-use auth code for a Firebase custom token + profile.
 *
 * `redirectUri` is sent only when we know the exact value used at /authorize
 * (memoised by initiateSSO). The hub validated it there already and tolerates
 * its absence; sending a *guessed* value would break native custom-scheme
 * logins, which is why several satellites omitted it entirely.
 */
export async function exchangeCode(config: SSOKitConfig, code: string): Promise<SSOTokenResponse> {
  let memoisedRedirect: string | null = null;
  let codeVerifier: string | null = null;
  try { memoisedRedirect = sessionStorage.getItem(REDIRECT_MEMO_KEY); } catch { /* ignore */ }
  try { codeVerifier = sessionStorage.getItem(VERIFIER_MEMO_KEY); } catch { /* ignore */ }

  const payload: Record<string, unknown> = {
    code,
    clientId: config.clientId,
    grant_type: 'authorization_code',
  };
  if (memoisedRedirect) payload.redirectUri = memoisedRedirect;
  if (codeVerifier) payload.codeVerifier = codeVerifier;
  // Some clients have a secret configured on the hub. Note this is NOT a real
  // secret in a browser bundle — it is a legacy compatibility knob, not a
  // security boundary.
  if (config.clientSecret) payload.clientSecret = config.clientSecret;

  const res = await fetch(`${cfgApi(config)}/api/sso/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Token exchange failed (HTTP ${res.status})`);
  try { sessionStorage.removeItem(REDIRECT_MEMO_KEY); } catch { /* ignore */ }
  // The verifier is single-use; leaving it behind would let the next flow
  // present a verifier that does not match its own fresh challenge.
  try { sessionStorage.removeItem(VERIFIER_MEMO_KEY); } catch { /* ignore */ }
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

/**
 * Build the full context used for post-login routing.
 *
 * `isAdmin` deliberately considers BOTH the org role and the root role: a
 * platform admin whose org membership says PARENT is still an admin, and
 * every satellite was independently re-deriving that rule.
 */
export function buildPostLoginContext(
  token: SSOTokenResponse,
  returnTo: string | null,
  clientOrgId?: string
): PostLoginContext {
  const orgId = clientOrgId ?? token.orgId;
  const role = resolveRole(token, orgId);
  const globalRole = String(token.globalProfile?.role || '').toUpperCase();
  const isNewUser = !(token.globalProfile?.organizations || [])
    .some((o) => o.orgId === orgId && o.role);

  return {
    role,
    globalRole,
    isAdmin: isPrivilegedRole(role) || isPrivilegedRole(globalRole),
    isNewUser,
    orgId,
    profile: token.globalProfile,
    returnTo,
  };
}

/**
 * Choose the post-login destination.
 *
 * Precedence: same-site `returnTo` > function/map result. Only same-site
 * paths are honoured, so a crafted `?returnTo=https://evil.com` cannot turn
 * the callback into an open redirect.
 */
export function resolveDestination(
  config: SSOKitConfig,
  ctx: PostLoginContext
): string {
  if (ctx.returnTo && ctx.returnTo.startsWith('/') && !ctx.returnTo.startsWith('//')) {
    return ctx.returnTo;
  }
  const routes = config.postLoginRoutes;
  if (typeof routes === 'function') return routes(ctx);

  // Admin status outranks the org role. A platform admin whose membership in
  // THIS org happens to say PARENT should still land in the admin area —
  // matching the org role first would strand them on the parent dashboard.
  // Sites that genuinely want the org role to win can use the function form.
  if (ctx.isAdmin) {
    const adminRoute = routes[ctx.role] && (ctx.role === 'ADMIN' || ctx.role === 'OWNER')
      ? routes[ctx.role]
      : routes.ADMIN ?? routes.OWNER;
    if (adminRoute) return adminRoute;
  }
  return routes[ctx.role] ?? routes.default;
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
