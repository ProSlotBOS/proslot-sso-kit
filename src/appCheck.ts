/**
 * App Check that recovers from a refusal in minutes instead of a day.
 *
 * Firebase's ReCaptchaEnterpriseProvider blocks every new attempt for 24 hours once the
 * exchange endpoint answers 403 ("App attestation failed"). A real person can meet one such
 * refusal: a coach's league tab left open all day had a background refresh refused on
 * 2026-10-26 and again on 10-27 (Tracer 1373cc53be10d39c, 884ee4d121027c7f). While App Check
 * only watches that costs nothing, but once Firebase enforces it the tab would be unable to
 * read anything from Firebase until the next day, and signing in again would not help: the
 * check is about the browser, not the account.
 *
 * This is the same provider with that one rule changed. After a refusal it tries again with
 * a fresh reCAPTCHA check after 30 seconds, then 1, 2, 5 and 15 minutes, then hourly. Every
 * attempt is still judged by Google, so a bot gains nothing it did not have before; a person
 * whose refusal was a passing thing is back within a minute or two.
 *
 * Start App Check with it where a site used ReCaptchaEnterpriseProvider:
 *
 *   initializeAppCheck(app, { provider: new RecoveringReCaptchaProvider(siteKey), isTokenAutoRefreshEnabled: true });
 *
 * A fallback for signed-in people (2026-11-03). Some real browsers never pass Google's check: Instagram's and
 * Facebook's built-in browsers block it, and so do ad blockers, privacy browsers and school or work filters. Once App
 * Check is enforced those people would be locked out of their own records. Give the provider a way to read the
 * signed-in person's ID token and, when reCAPTCHA fails, it asks proslot-api (POST /api/app-check/token) for the same
 * short-lived App Check token instead:
 *
 *   new RecoveringReCaptchaProvider(siteKey, { fallback: { getIdToken: () => auth.currentUser?.getIdToken() ?? null } })
 *
 * Nobody signed in, no fallback: a public page never needed one, since it reads through the API.
 *
 * The page-load gap (2026-11-05). On a fresh page load the first token is asked for before Firebase Auth has read
 * the signed-in person back from storage, so `auth.currentUser` was still null, the fallback found nobody and then
 * paused for a minute, and Firestore's first reads went out with Firebase's placeholder token. Under enforcement a
 * signed-in parent in Instagram's browser would have been refused on every page load. The fallback now waits (at
 * most 5 seconds) for Auth to finish restoring the session when the site has started Auth, and only a failed call
 * to the API pauses it: finding nobody signed in costs nothing, so the next request tries again.
 *
 * Lockout tracking (2026-11-05). watchAppCheckLockouts(app) reports, once per page load per kind, every time this
 * page sent Firestore a request while it held no valid App Check token: the requests that enforcement would refuse.
 * The provider starts it by itself; a site also calls it after its App Check block so pages without App Check, or
 * with another provider (the iOS and Android apps), are counted too. See its own comment.
 *
 * onAppCheckStatus(listener) reports each refusal, recovery, fallback and lockout, for a site that wants to tell
 * the person when their browser keeps being refused.
 *
 * It relies on details of Firebase that are not its public API: the throttle the provider keeps in `_throttleData`,
 * the `appCheck/initial-throttle` error carrying `customData.httpStatus`, `_getProvider` with the component names
 * 'auth' and 'app-check', and Auth's `authStateReady`. test/appCheck and test/appCheckLockouts pin all of them
 * against the installed Firebase, so an upgrade that changes them fails the kit's tests before a release. If they
 * ever went missing at runtime, the provider behaves exactly like Firebase's own and the watch stays silent.
 */
import type { FirebaseApp } from 'firebase/app';
import * as firebaseApp from 'firebase/app';
import { ReCaptchaEnterpriseProvider, onTokenChanged } from 'firebase/app-check';
import type { AppCheck } from 'firebase/app-check';

/** Wait before each new attempt after a refusal, by refusals in a row; the last repeats. */
export const APP_CHECK_RETRY_AFTER_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000];

export type AppCheckStatus =
  | { state: 'refused'; inARow: number; retryInMs: number }
  | { state: 'recovered'; afterRefusals: number }
  | { state: 'fallback' }
  | { state: 'locked_out'; signedIn: boolean; cause: string; inAppBrowser: string | null };

const listeners = new Set<(status: AppCheckStatus) => void>();

/** Hear about refusals, recoveries, fallbacks and lockouts. Returns a function that stops listening. */
export function onAppCheckStatus(listener: (status: AppCheckStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function tell(status: AppCheckStatus): void {
  for (const listener of listeners) {
    try { listener(status); } catch { /* a listener's failure is not App Check's */ }
  }
}

// ---------- Firebase services the site already started (never starts one) ----------

interface ComponentProvider {
  isInitialized(identifier?: string): boolean;
  getImmediate(options?: { optional?: boolean }): unknown;
}
type GetProvider = (app: FirebaseApp, name: string) => ComponentProvider;

/**
 * Firebase's own `name` service on this app, only when the site has already started it. Never starts one: getAuth()
 * here would pick default persistence on a site that calls initializeAuth() later, and initializeAppCheck() is the
 * site's call. `_getProvider` is Firebase's internal export (left out of its public types); the tests pin it.
 */
function startedService<T>(app: FirebaseApp | undefined, name: 'auth' | 'app-check'): T | null {
  if (!app) return null;
  try {
    const getProvider = (firebaseApp as unknown as { _getProvider?: GetProvider })._getProvider;
    if (typeof getProvider !== 'function') return null;
    const provider = getProvider(app, name);
    if (!provider || !provider.isInitialized()) return null;
    return (provider.getImmediate({ optional: true }) as T | null) ?? null;
  } catch {
    return null;
  }
}

interface AuthLike { currentUser?: unknown; authStateReady?: () => Promise<void> }

/** The longest the fallback waits for Firebase Auth to read the signed-in person back on page load. */
const AUTH_RESTORE_WAIT_MS = 5_000;

/** Wait until Auth has restored the session (at most 5 s), when the site started Auth for this app. */
async function signInRestored(app: FirebaseApp | undefined): Promise<void> {
  const auth = startedService<AuthLike>(app, 'auth');
  if (!auth || typeof auth.authStateReady !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => auth.authStateReady!()).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, AUTH_RESTORE_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isSignedIn(app: FirebaseApp): boolean {
  return startedService<AuthLike>(app, 'auth')?.currentUser != null;
}

// ---------- what the provider shares with the lockout watch, per app ----------

/** Apps whose App Check runs on this provider, and when it started (performance clock). */
const ourProviders = new WeakMap<FirebaseApp, { startedAt: number }>();

/** Why the provider's last attempt failed, in the fixed words a lockout report uses. */
interface Failure { check: string; backup: string | null; nobodySignedIn: boolean }
const lastFailure = new WeakMap<FirebaseApp, Failure>();

const REFUSED = 'Google refused this browser';
const COULD_NOT_RUN = "Google's check could not run";
const NO_BACKUP = 'no sign-in backup on this site';

function perfNow(): number {
  try { return globalThis.performance?.now?.() ?? 0; } catch { return 0; }
}

// ---------- the provider ----------

type Throttle = { backoffCount: number; allowRequestsAfter: number; httpStatus: number };
interface ProviderInternals {
  _throttleData?: Throttle | null;
  _app?: FirebaseApp;
  getToken(isLimitedUse?: boolean): Promise<unknown>;
  initialize(app: FirebaseApp): void;
}

export interface AppCheckFallback {
  /** The signed-in person's Firebase ID token, or null when nobody is signed in. */
  getIdToken: () => Promise<string | null | undefined> | string | null | undefined;
  /** proslot-api's address; defaults to the production API. */
  apiBase?: string;
}

type AppCheckTokenLike = { token: string; expireTimeMillis: number; issuedAtTimeMillis: number };
type FallbackResult =
  | { ok: true; token: AppCheckTokenLike }
  | { ok: false; backup: string | null; nobodySignedIn: boolean };

/** After a call to the API fails (refused, bad answer, offline), wait this long before asking it again. */
const FALLBACK_PAUSE_MS = 60_000;
const DEFAULT_API_BASE = 'https://proslot-api-473053764604.us-central1.run.app';
/** The longest App Check token Firebase issues is 7 days; anything longer is a bad answer. */
const MAX_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class RecoveringReCaptchaProvider extends ReCaptchaEnterpriseProvider {
  private refusalsInARow = 0;
  private readonly fallback: AppCheckFallback | null;
  private fallbackPausedUntil = 0;
  /** What the last call to the API came to, so a request inside the pause reports the reason for it. */
  private lastBackup: string | null = null;

  constructor(siteKey: string, options: { fallback?: AppCheckFallback } = {}) {
    super(siteKey);
    this.fallback = options.fallback ?? null;
  }

  /** @internal Called by Firebase when App Check starts; also starts the lockout watch for this app. */
  initialize(app: FirebaseApp): void {
    (ReCaptchaEnterpriseProvider.prototype as unknown as ProviderInternals).initialize.call(this, app);
    ourProviders.set(app, { startedAt: perfNow() });
    // Outside Firebase's own start-up: initializeAppCheck is still running when it calls this.
    setTimeout(() => {
      try { watchAppCheckLockouts(app); } catch { /* the watch never breaks App Check */ }
    }, 0);
  }

  /** A token from proslot-api for the signed-in person, or why there is none. Never throws. */
  private async fallbackToken(): Promise<FallbackResult> {
    if (!this.fallback) return { ok: false, backup: NO_BACKUP, nobodySignedIn: false };
    if (Date.now() < this.fallbackPausedUntil) return { ok: false, backup: this.lastBackup, nobodySignedIn: false };
    const app = (this as unknown as ProviderInternals)._app;
    const appId = app?.options?.appId;
    if (!appId) return { ok: false, backup: null, nobodySignedIn: false };

    // On page load Auth may not have read the signed-in person back yet: wait for it rather than find nobody.
    await signInRestored(app);
    let idToken: string | null | undefined;
    try {
      idToken = await this.fallback.getIdToken();
    } catch {
      // Auth could not refresh the ID token (offline, or the sign-in was revoked). No call to the API was made, so
      // nothing pauses; the next attempt tries again.
      return { ok: false, backup: 'sign-in backup could not get an ID token', nobodySignedIn: false };
    }
    // Nobody signed in costs no request, so it does not pause the fallback: the next attempt asks again.
    if (!idToken) return { ok: false, backup: null, nobodySignedIn: true };

    const pause = (backup: string): FallbackResult => {
      this.fallbackPausedUntil = Date.now() + FALLBACK_PAUSE_MS;
      this.lastBackup = backup;
      return { ok: false, backup, nobodySignedIn: false };
    };
    let res: Response;
    try {
      const base = (this.fallback.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
      res = await fetch(`${base}/api/app-check/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ appId }),
      });
    } catch {
      return pause('sign-in backup unreachable');
    }
    if (!res.ok) {
      const status = Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? ` (HTTP ${res.status})` : '';
      return pause(`sign-in backup refused${status}`);
    }
    let body: { token?: unknown; expireTimeMillis?: unknown; issuedAtTimeMillis?: unknown } | null;
    try {
      body = await res.json() as typeof body;
    } catch {
      body = null;
    }
    if (!body || typeof body.token !== 'string' || typeof body.expireTimeMillis !== 'number') {
      return pause('sign-in backup gave an unreadable answer');
    }
    this.lastBackup = null;
    console.info('[app-check] reCAPTCHA failed; using the signed-in fallback');
    tell({ state: 'fallback' });
    // Timed on this device's clock, as Firebase times its own tokens: with the API's clock, a phone set an hour
    // slow would keep sending the token for an hour after it expired, and one set fast would ask for a new one on
    // every request until the API's hourly limit refused it.
    const now = Date.now();
    const lifetime = typeof body.issuedAtTimeMillis === 'number' ? body.expireTimeMillis - body.issuedAtTimeMillis : NaN;
    const expireTimeMillis = lifetime > 0 && lifetime <= MAX_TOKEN_LIFETIME_MS ? now + lifetime : body.expireTimeMillis;
    return { ok: true, token: { token: body.token, expireTimeMillis, issuedAtTimeMillis: now } };
  }

  /** @internal Called by Firebase; same contract as ReCaptchaEnterpriseProvider.getToken. */
  async getToken(isLimitedUse = false): Promise<unknown> {
    const base = ReCaptchaEnterpriseProvider.prototype as unknown as ProviderInternals;
    try {
      const token = await base.getToken.call(this, isLimitedUse);
      if (this.refusalsInARow > 0) {
        const afterRefusals = this.refusalsInARow;
        this.refusalsInARow = 0;
        console.info(`[app-check] recovered after ${afterRefusals} refused ${afterRefusals === 1 ? 'check' : 'checks'}`);
        tell({ state: 'recovered', afterRefusals });
      }
      return token;
    } catch (err) {
      const e = err as { code?: string; customData?: { httpStatus?: number } } | null;
      const self = this as unknown as ProviderInternals;
      // Only the refusal itself (403) gets the shorter wait. A 404 means the site is
      // misconfigured, and Firebase's day-long pause is right for that.
      if (e?.code === 'appCheck/initial-throttle' && e.customData?.httpStatus === 403 && self._throttleData) {
        const retryInMs = APP_CHECK_RETRY_AFTER_MS[Math.min(this.refusalsInARow, APP_CHECK_RETRY_AFTER_MS.length - 1)];
        this.refusalsInARow += 1;
        self._throttleData = { ...self._throttleData, allowRequestsAfter: Date.now() + retryInMs };
        tell({ state: 'refused', inARow: this.refusalsInARow, retryInMs });
      }
      // Any failure (a refusal, a blocked or timed-out reCAPTCHA, the wait after one): a signed-in person gets the
      // fallback token instead, while reCAPTCHA keeps its own retry schedule for the next refresh.
      const fallback = await this.fallbackToken();
      if (fallback.ok) return fallback.token;
      if (self._app) {
        // A refusal (403), or the wait after one, is Google judging this browser; anything else (reCAPTCHA blocked
        // or timed out, Google unreachable) means the check never ran.
        const refused = (e?.code === 'appCheck/initial-throttle' || e?.code === 'appCheck/throttled') && e.customData?.httpStatus === 403;
        lastFailure.set(self._app, { check: refused ? REFUSED : COULD_NOT_RUN, backup: fallback.backup, nobodySignedIn: fallback.nobodySignedIn });
      }
      throw err;
    }
  }
}

// ---------- lockout tracking ----------

/** One kind of lockout this page met, as reported. Every field is a fixed phrase: no address, person or token. */
export interface AppCheckLockout {
  /** Someone was signed in on the page when it was seen. */
  signedIn: boolean;
  /** Why the page held no App Check token, e.g. "Google refused this browser · no sign-in backup on this site". */
  cause: string;
  /** The app whose built-in browser this is (Instagram, Facebook, TikTok, ...), or null. */
  inAppBrowser: string | null;
  /** The line written to the console, which Tracer records as one error per kind. */
  message: string;
}

const IN_APP_BROWSERS: Array<[string, RegExp]> = [
  // Instagram's browser carries Facebook's FBAN/FBAV tokens too, so it is checked first.
  ['Instagram', /Instagram/],
  ['Facebook', /FBAN|FBAV|FB_IAB|FBIOS/],
  ['LINE', /\bLine\//],
  ['TikTok', /TikTok|musical_ly/],
  ['Snapchat', /Snapchat/],
  ['LinkedIn', /LinkedInApp/],
  ['Twitter', /Twitter for/],
];

function inAppBrowserName(): string | null {
  try {
    const ua = typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    return IN_APP_BROWSERS.find(([, pattern]) => pattern.test(ua))?.[0] ?? null;
  } catch {
    return null;
  }
}

/** A developer's own machine: nothing there is a real person. The iOS and Android apps also serve from localhost. */
function isLocalDevelopment(): boolean {
  const location = (window as { location?: { hostname?: string; protocol?: string } }).location;
  const host = String(location?.hostname ?? '').toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  if (!local) return false;
  const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  let native = location?.protocol === 'capacitor:' || location?.protocol === 'ionic:';
  try { native = native || capacitor?.isNativePlatform?.() === true; } catch { /* not a native shell */ }
  return !native;
}

/** A token's claims, read without checking its signature (that is Google's job); null if it is not a JWT. */
function tokenClaims(token: string): { exp?: unknown; iat?: unknown } | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const claims = JSON.parse(atob(base64)) as unknown;
    return claims && typeof claims === 'object' ? claims as { exp?: unknown; iat?: unknown } : null;
  } catch {
    return null;
  }
}

/** Assumed lifetime of a token whose expiry cannot be read. */
const UNREADABLE_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/**
 * How long the page has held this token and how long it stays valid, measured on this device's clock. When the
 * device's clock disagrees with the token's own times (a clock set wrong), Firebase still judged the token valid by
 * its own clock, so it counts as just issued and valid for its full lifetime.
 */
function tokenWindow(token: string, now: number): { heldForMs: number; remainingMs: number } {
  const claims = tokenClaims(token);
  const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : NaN;
  const iat = typeof claims?.iat === 'number' ? claims.iat * 1000 : NaN;
  if (!Number.isFinite(exp)) return { heldForMs: 0, remainingMs: UNREADABLE_TOKEN_LIFETIME_MS };
  const remaining = exp - now;
  if (Number.isFinite(iat) && exp > iat) {
    const lifetime = exp - iat;
    const age = now - iat;
    if (remaining > 0 && remaining <= lifetime && age >= 0) return { heldForMs: age, remainingMs: remaining };
    return { heldForMs: 0, remainingMs: lifetime };
  }
  return { heldForMs: 0, remainingMs: remaining > 0 ? remaining : UNREADABLE_TOKEN_LIFETIME_MS };
}

// Every time here is on the page's performance clock, the one resource timing uses. The wall clock (Date.now)
// jumps when a computer sleeps or its clock is set, and the performance clock can stop while the computer sleeps
// (browsers on Macs do this): compared with wall-clock token times, every request in a tab left open overnight
// would look hours old and be reported as a lockout. Token lifetimes are measured once, on arrival, and added to the page's clock.

/** Firebase may hand a token to Firestore a moment before the page hears of it. */
const TOKEN_GRACE_MS = 5_000;
const KEEP_WINDOWS = 8;

interface Span { from: number; until: number }
interface Watch {
  refs: number;
  callbacks: Set<{ fn: (lockout: AppCheckLockout) => void }>;
  /** When the page held a valid App Check token (performance clock). */
  held: Span[];
  /** When Firebase had no valid token and handed out its placeholder (performance clock; until is Infinity while open). */
  gaps: Span[];
  /** The error code of the last failed token request, for providers other than this kit's. */
  lastErrorCode: string | null;
  tokenSubscription: (() => void) | null;
  blind: boolean;
  observer: PerformanceObserver | null;
  /** Start times of Firestore requests waiting to be judged (the entries themselves are not kept). */
  pending: number[];
  flushScheduled: boolean;
}

const watches = new WeakMap<FirebaseApp, Watch>();
/** Messages already reported on this page load (keyed by the page's time origin). */
const reported = new Set<string>();

function noop(): void { /* nothing to stop */ }

function trim(spans: Span[]): void {
  while (spans.length > KEEP_WINDOWS) spans.shift();
}

/** A request to this app's Firestore. The address itself is never kept, logged or reported: it carries tokens. */
function isFirestoreRequest(name: string, projectId: string | null): boolean {
  if (typeof name !== 'string' || !name.includes('firestore.googleapis.com')) return false;
  let url: URL;
  try { url = new URL(name); } catch { return false; }
  if (url.hostname !== 'firestore.googleapis.com') return false;
  if (!projectId) return true;
  // Another Firebase project's database on the same page is not this app's to judge. When the address shows no
  // project, it is counted.
  const where = url.searchParams.get('database') ?? url.pathname;
  const match = /projects\/([^/]+)\//.exec(where);
  if (!match) return true;
  let project = match[1];
  try { project = decodeURIComponent(project); } catch { /* compare as written */ }
  return project === projectId;
}

function tokenSeen(watch: Watch, token: string): void {
  const now = perfNow();
  const { heldForMs, remainingMs } = tokenWindow(token, Date.now());
  watch.held.push({ from: now - heldForMs - TOKEN_GRACE_MS, until: now + remainingMs });
  trim(watch.held);
  const open = watch.gaps[watch.gaps.length - 1];
  if (open && open.until === Infinity) open.until = now;
}

function tokenFailed(watch: Watch, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  watch.lastErrorCode = typeof code === 'string' && /^[a-z]+\/[a-z0-9-]+$/i.test(code) ? code : null;
  const open = watch.gaps[watch.gaps.length - 1];
  if (!open || open.until !== Infinity) {
    watch.gaps.push({ from: perfNow(), until: Infinity });
    trim(watch.gaps);
  }
}

/** Follow App Check's tokens, once the site has started App Check for this app. */
function followTokens(app: FirebaseApp, watch: Watch): void {
  if (watch.tokenSubscription || watch.blind) return;
  const appCheck = startedService<AppCheck>(app, 'app-check');
  if (!appCheck) return;
  try {
    watch.tokenSubscription = onTokenChanged(appCheck, {
      next: (result) => { if (result && typeof result.token === 'string') tokenSeen(watch, result.token); },
      error: (err) => tokenFailed(watch, err),
    });
  } catch {
    // A second copy of Firebase on the page, say: this watch cannot tell when the page held a token, so it says
    // nothing rather than report every request.
    watch.blind = true;
    console.warn('[app-check] lockout watch could not follow App Check tokens');
  }
}

function causeOf(app: FirebaseApp, watch: Watch, start: number, signedIn: boolean): string {
  if (!startedService<AppCheck>(app, 'app-check')) return 'App Check not running on this page';
  const ours = ourProviders.get(app);
  if (!ours) return watch.lastErrorCode ?? 'token request failed';
  if (start < ours.startedAt) return 'App Check started after Firestore';
  const failure = lastFailure.get(app);
  if (!failure) return 'no valid App Check token';
  const backup = failure.backup
    ?? (failure.nobodySignedIn && signedIn ? 'sign-in backup saw nobody signed in' : null);
  return backup ? `${failure.check} · ${backup}` : failure.check;
}

function judge(app: FirebaseApp, watch: Watch, starts: number[], pageKey: string): void {
  for (const start of starts) {
    // Sent before this kit's provider started App Check, or while Firebase had only its placeholder token: no token
    // went with it, whatever the token times say. Otherwise it is fine when the page held a valid token then.
    const ours = ourProviders.get(app);
    const beforeAppCheck = ours !== undefined && start < ours.startedAt;
    const inGap = watch.gaps.some((gap) => start >= gap.from && start < gap.until);
    if (!beforeAppCheck && !inGap && watch.held.some((span) => start >= span.from && start <= span.until)) continue;
    if (watch.blind && startedService<AppCheck>(app, 'app-check')) continue;

    const signedIn = isSignedIn(app);
    const cause = causeOf(app, watch, start, signedIn);
    const inAppBrowser = inAppBrowserName();
    const message = `[app-check] Locked out: ${signedIn ? 'signed in' : 'signed out'} · ${cause}${inAppBrowser ? ` · ${inAppBrowser} in-app browser` : ''}`;
    const key = `${pageKey} ${message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    console.error(message);
    const lockout: AppCheckLockout = { signedIn, cause, inAppBrowser, message };
    for (const callback of watch.callbacks) {
      try { callback.fn(lockout); } catch { /* a callback's failure is not the watch's */ }
    }
    tell({ state: 'locked_out', signedIn, cause, inAppBrowser });
  }
}

/**
 * Report every kind of App Check lockout this page meets, before enforcement makes it real.
 *
 * App Check only watches until Firebase enforces it; then any Firestore request sent without a valid App Check token
 * is refused, and the person cannot read their own records. This watches the page's Firestore requests (resource
 * timing; only their start times) against the times the page held a valid token (App Check's own token events), and
 * for each request that went out without one writes, once per page load per kind:
 *
 *   [app-check] Locked out: signed in · Google refused this browser · sign-in backup refused (HTTP 429) · Instagram in-app browser
 *
 * to console.error, which Tracer records as one error per kind; calls `onLockout`; and tells onAppCheckStatus
 * listeners `{ state: 'locked_out', ... }`. The message is fixed words only, never an address, person, token, time or
 * count. Call it once, right after the site's App Check block, whether or not App Check started (native apps and
 * pages with App Check off are counted as 'App Check not running on this page'). RecoveringReCaptchaProvider starts
 * it by itself; calling it again for the same app adds `onLockout` to the same watch. It never starts App Check or
 * Auth, and does nothing on a developer's machine (localhost) or outside a browser. Returns a function that stops it.
 */
export function watchAppCheckLockouts(app: FirebaseApp, options: { onLockout?: (lockout: AppCheckLockout) => void } = {}): () => void {
  if (typeof window === 'undefined' || !app) return noop;
  const perf = globalThis.performance;
  const Observer = globalThis.PerformanceObserver;
  if (!perf || typeof perf.now !== 'function' || typeof Observer !== 'function') return noop;
  try { if (isLocalDevelopment()) return noop; } catch { return noop; }

  let watch = watches.get(app);
  if (!watch) {
    const fresh: Watch = {
      refs: 0, callbacks: new Set(), held: [], gaps: [], lastErrorCode: null,
      tokenSubscription: null, blind: false, observer: null, pending: [], flushScheduled: false,
    };
    const projectId = typeof app.options?.projectId === 'string' ? app.options.projectId : null;
    const pageKey = String(perf.timeOrigin ?? '');
    const take = (entries: PerformanceEntryList): void => {
      for (const entry of entries) {
        // Firestore's channel addresses carry the ID token and the App Check token: only the start time is kept.
        if (typeof entry.startTime === 'number' && isFirestoreRequest(entry.name, projectId)) fresh.pending.push(entry.startTime);
      }
      if (!fresh.pending.length || fresh.flushScheduled) return;
      // App Check may have started since the watch did; and Firebase tells a new listener about the token it holds
      // a moment later. Judge after that.
      followTokens(app, fresh);
      fresh.flushScheduled = true;
      setTimeout(() => {
        fresh.flushScheduled = false;
        const batch = fresh.pending.splice(0);
        if (watches.get(app) === fresh) judge(app, fresh, batch, pageKey);
      }, 0);
    };
    try {
      const observer = new Observer((list) => take(list.getEntries()));
      try {
        observer.observe({ type: 'resource', buffered: true });
      } catch {
        // Browsers from before `type`/`buffered`: watch from now and read what is already there.
        observer.observe({ entryTypes: ['resource'] });
        if (typeof perf.getEntriesByType === 'function') take(perf.getEntriesByType('resource'));
      }
      fresh.observer = observer;
    } catch {
      return noop;
    }
    followTokens(app, fresh);
    watches.set(app, fresh);
    watch = fresh;
  }

  const current = watch;
  // App Check may have started since this watch did (the provider's own call arrives just after it starts).
  followTokens(app, current);
  current.refs += 1;
  const callback = options.onLockout ? { fn: options.onLockout } : null;
  if (callback) current.callbacks.add(callback);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (callback) current.callbacks.delete(callback);
    current.refs -= 1;
    if (current.refs > 0) return;
    try { current.observer?.disconnect(); } catch { /* already gone */ }
    try { current.tokenSubscription?.(); } catch { /* already gone */ }
    if (watches.get(app) === current) watches.delete(app);
  };
}
