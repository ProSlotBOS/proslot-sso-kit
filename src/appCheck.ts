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
 * The provider records what each of its token requests came to (a token held for its lifetime, or a failure), and
 * the watch judges this page's Firestore requests against that record; it never listens to App Check's tokens for
 * this provider. The provider starts the watch by itself; a site also calls it after its App Check block so pages
 * without App Check, or with another provider (the iOS and Android apps), are counted too. See its own comment.
 *
 * onAppCheckStatus(listener) reports each refusal, recovery, fallback and lockout, for a site that wants to tell
 * the person when their browser keeps being refused.
 *
 * It relies on details of Firebase that are not its public API: the throttle the provider keeps in `_throttleData`
 * (replaced by a new one on each refusal), the refusal error (`appCheck/initial-throttle`, or `appCheck/throttled` in
 * Firebase 10) carrying `customData.httpStatus`, Firebase asking the provider for a token only when it holds no valid
 * one, `_getProvider` with the component names 'auth' and 'app-check', and Auth's `authStateReady`. test/appCheck
 * and test/appCheckLockouts pin all of them against the installed Firebase, so an upgrade that changes them fails the
 * kit's tests before a release. If they ever went missing at runtime, the provider behaves exactly like Firebase's
 * own and the watch stays silent.
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

// ---------- what the provider records for the lockout watch, per app ----------
//
// Every time here is Date.now(), the clock Firebase's own isValid() judges its tokens by. A token's own times (the
// JWT's iat and exp, on Google's clock) are never read: on a phone whose clock is set wrong they disagree with the
// device clock Firebase uses, and would turn valid tokens into lockouts.

/** Apps whose App Check runs on this provider, and when it started (wall clock). */
const ourProviders = new WeakMap<FirebaseApp, { startedAt: number }>();

/** Why a token request failed, in the fixed words a lockout report uses. */
interface Failure { check: string; backup: string | null; nobodySignedIn: boolean }

/** A token this provider handed Firebase, held from `from` until `until` (its lifetime, counted from receipt). */
interface Held { seq: number; from: number; until: number }
/** A token request this provider failed (it threw, and the fallback had nothing either). */
interface Failed { seq: number; at: number; failure: Failure }
interface Outcomes { held: Held[]; failed: Failed[] }

/** What this provider's token requests came to, per app: the last few of each kind, in the order they happened. */
const providerOutcomes = new WeakMap<FirebaseApp, Outcomes>();
const KEEP_OUTCOMES = 20;
let outcomeSeq = 0;

function outcomesOf(app: FirebaseApp): Outcomes {
  let outcomes = providerOutcomes.get(app);
  if (!outcomes) {
    outcomes = { held: [], failed: [] };
    providerOutcomes.set(app, outcomes);
  }
  return outcomes;
}

function keepLast<T>(list: T[]): void {
  while (list.length > KEEP_OUTCOMES) list.shift();
}

/** The provider handed Firebase `token`: held from now for its lifetime (expire - issued, as Firebase counts it). */
function recordHeld(app: FirebaseApp | undefined, token: unknown): void {
  if (!app) return;
  try {
    const times = token as { expireTimeMillis?: unknown; issuedAtTimeMillis?: unknown } | null;
    const lifetime = typeof times?.expireTimeMillis === 'number' && typeof times?.issuedAtTimeMillis === 'number'
      ? times.expireTimeMillis - times.issuedAtTimeMillis
      : NaN;
    const from = Date.now();
    const held = outcomesOf(app).held;
    held.push({ seq: ++outcomeSeq, from, until: from + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 0) });
    keepLast(held);
  } catch { /* the record never breaks App Check */ }
}

/** The provider failed a token request: Firebase hands Firestore its placeholder unless it still holds a valid token. */
function recordFailed(app: FirebaseApp | undefined, failure: Failure): void {
  if (!app) return;
  try {
    const failed = outcomesOf(app).failed;
    failed.push({ seq: ++outcomeSeq, at: Date.now(), failure });
    keepLast(failed);
  } catch { /* the record never breaks App Check */ }
}

const REFUSED = 'Google refused this browser';
const COULD_NOT_RUN = "Google's check could not run";
const NO_BACKUP = 'no sign-in backup on this site';

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
    ourProviders.set(app, { startedAt: Date.now() });
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
    const self = this as unknown as ProviderInternals;
    // What the request came to is recorded for the lockout watch. A limited-use token is not the one Firebase keeps
    // and hands to Firestore, so it is not (Firebase 12 says which a request is; 11 and 10 do not, and no ProSlot site
    // asks for one).
    const app = isLimitedUse ? undefined : self._app;
    const throttleBefore = self._throttleData;
    try {
      const token = await base.getToken.call(this, isLimitedUse);
      if (this.refusalsInARow > 0) {
        const afterRefusals = this.refusalsInARow;
        this.refusalsInARow = 0;
        console.info(`[app-check] recovered after ${afterRefusals} refused ${afterRefusals === 1 ? 'check' : 'checks'}`);
        tell({ state: 'recovered', afterRefusals });
      }
      recordHeld(app, token);
      return token;
    } catch (err) {
      const e = err as { code?: string; customData?: { httpStatus?: number } } | null;
      const refusal = (e?.code === 'appCheck/initial-throttle' || e?.code === 'appCheck/throttled') && e.customData?.httpStatus === 403;
      // Only a new refusal (403) gets the shorter wait. Firebase 11 and later report one as 'initial-throttle';
      // Firebase 10 as 'throttled', the code it also gives each call it turns away inside the wait. A new refusal is
      // the one that has just set a new throttle; a call turned away inside the wait leaves it as it was, and must not
      // count as another refusal. A 404 means the site is misconfigured, and Firebase's day-long pause is right for that.
      if (refusal && self._throttleData && self._throttleData !== throttleBefore) {
        const retryInMs = APP_CHECK_RETRY_AFTER_MS[Math.min(this.refusalsInARow, APP_CHECK_RETRY_AFTER_MS.length - 1)];
        this.refusalsInARow += 1;
        self._throttleData = { ...self._throttleData, allowRequestsAfter: Date.now() + retryInMs };
        tell({ state: 'refused', inARow: this.refusalsInARow, retryInMs });
      }
      // Any failure (a refusal, a blocked or timed-out reCAPTCHA, the wait after one): a signed-in person gets the
      // fallback token instead, while reCAPTCHA keeps its own retry schedule for the next refresh.
      const fallback = await this.fallbackToken();
      if (fallback.ok) {
        recordHeld(app, fallback.token);
        return fallback.token;
      }
      // A refusal (403), or the wait after one, is Google judging this browser; anything else (reCAPTCHA blocked or
      // timed out, Google unreachable) means the check never ran.
      recordFailed(app, { check: refusal ? REFUSED : COULD_NOT_RUN, backup: fallback.backup, nobodySignedIn: fallback.nobodySignedIn });
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

// ---------- judging a Firestore request ----------
//
// A request's start is put on the wall clock (Date.now(), the clock the provider's outcomes are on) when resource
// timing reports it: Date.now() - (performance.now() - entry.startTime). Never performance.timeOrigin + startTime:
// the performance clock can stop while the computer sleeps (browsers on Macs do this), so after a night asleep that
// sum is hours behind the wall clock, and every request after waking would be judged against the night before.

/**
 * Date.now() counts whole milliseconds and browsers coarsen performance.now() (to 1 ms in Safari and Firefox, to 100 ms
 * in privacy modes), so a request's start can come out a little before the outcome that came just before it. An
 * outcome this close after a request counts as before it, and a token as held from this long before it arrived.
 */
const CLOCK_SLACK_MS = 250;

const NOT_RUNNING = 'App Check not running on this page';
const STARTED_LATE = 'App Check started after Firestore';

/**
 * For an app on this kit's provider: why a request that started at wall time `t` went out without a valid App Check
 * token (the failure, or a fixed cause), or null when it did not.
 *
 * It did when the provider's most recent outcome at or before `t` was a failure and no token the provider handed
 * Firebase was held at `t`:
 *   - the provider was never asked before `t`: Firebase sent a valid token it already had (read back from storage);
 *   - a refresh failed while an earlier token was still held: Firebase kept sending that token;
 *   - a failure with no token held: Firebase sent its placeholder, which enforcement refuses.
 * This errs toward counting in one case, on purpose. A token Firebase read back from storage (IndexedDB) on page load
 * never passes through the provider, so its expiry is unknown here: when its refresh fails, the requests sent between
 * that failure and its expiry are counted although they carried a valid token. A missed lockout would be a person
 * refused under enforcement; a counted one that was not is only a report to look into.
 */
function ourVerdict(app: FirebaseApp, t: number): Failure | string | null {
  const ours = ourProviders.get(app);
  if (ours && t < ours.startedAt - CLOCK_SLACK_MS) return STARTED_LATE;
  const outcomes = providerOutcomes.get(app);
  if (!outcomes) return null;
  if (outcomes.held.some((span) => t >= span.from - CLOCK_SLACK_MS && t <= span.until)) return null;
  let latest: Held | Failed | null = null;
  for (const span of outcomes.held) if (span.from <= t + CLOCK_SLACK_MS && (!latest || span.seq > latest.seq)) latest = span;
  for (const failed of outcomes.failed) if (failed.at <= t + CLOCK_SLACK_MS && (!latest || failed.seq > latest.seq)) latest = failed;
  return latest && 'failure' in latest ? latest.failure : null;
}

function describeFailure(failure: Failure, signedIn: boolean): string {
  const backup = failure.backup
    ?? (failure.nobodySignedIn && signedIn ? 'sign-in backup saw nobody signed in' : null);
  return backup ? `${failure.check} · ${backup}` : failure.check;
}

/** One token event from another provider (the iOS and Android apps'), on the wall clock. */
interface TokenEvent { at: number; ok: boolean; code: string | null }

interface Watch {
  refs: number;
  callbacks: Set<{ fn: (lockout: AppCheckLockout) => void }>;
  /** Another provider's token events, once followed: the last few, in order. */
  events: TokenEvent[];
  tokenSubscription: (() => void) | null;
  /** Another provider's tokens could not be followed (a second copy of Firebase on the page, say). */
  blind: boolean;
  observer: PerformanceObserver | null;
  /** Wall-clock start times of Firestore requests waiting to be judged (the entries themselves are not kept). */
  pending: number[];
  flushScheduled: boolean;
}

const watches = new WeakMap<FirebaseApp, Watch>();
/** Messages already reported on this page load (keyed by the page's time origin). */
const reported = new Set<string>();

function noop(): void { /* nothing to stop */ }

function noteEvent(watch: Watch, ok: boolean, err: unknown): void {
  try {
    const code = ok ? null : (err as { code?: unknown } | null)?.code;
    watch.events.push({ at: Date.now(), ok, code: typeof code === 'string' && /^[a-z]+\/[a-z0-9-]+$/i.test(code) ? code : null });
    keepLast(watch.events);
  } catch { /* the watch never throws into App Check */ }
}

/**
 * Follow another provider's tokens with App Check's public onTokenChanged. Only from the first Firestore request on,
 * never earlier: by then Firestore has added its own listener, so this one starts nothing Firestore had not. (This
 * kit's provider is never followed this way: it records its own outcomes, and a listener on a page that never reads
 * Firestore would have Firebase fetch tokens nobody needs.) `next` is a token held, until the next error; `error` is a
 * failed token request.
 */
function followTokens(watch: Watch, appCheck: AppCheck): void {
  try {
    watch.tokenSubscription = onTokenChanged(appCheck, {
      next: () => noteEvent(watch, true, null),
      error: (err) => noteEvent(watch, false, err),
    });
  } catch {
    // This watch cannot tell when the page held a token, so it says nothing rather than report every request.
    watch.blind = true;
    try { console.warn('[app-check] lockout watch could not follow App Check tokens'); } catch { /* no console */ }
  }
}

/** For another provider: a request is a lockout when the latest token event at or before it was an error. */
function otherVerdict(watch: Watch, t: number): string | null {
  let latest: TokenEvent | null = null;
  for (const event of watch.events) if (event.at <= t + CLOCK_SLACK_MS) latest = event;
  // Before the first event nothing is known: not judged.
  if (!latest || latest.ok) return null;
  return latest.code ?? 'token request failed';
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

function judge(app: FirebaseApp, watch: Watch, starts: number[], pageKey: string): void {
  const appCheck = startedService<AppCheck>(app, 'app-check');
  const ours = ourProviders.has(app);
  if (appCheck && !ours && !watch.tokenSubscription && !watch.blind) {
    // Another provider, seen for the first time: follow its tokens from now on. These requests went out before its
    // first event, so they are not judged.
    followTokens(watch, appCheck);
    return;
  }
  for (const start of starts) {
    let verdict: Failure | string | null;
    if (ours) verdict = ourVerdict(app, start);
    else if (!appCheck) verdict = NOT_RUNNING;
    else if (watch.blind) verdict = null;
    else verdict = otherVerdict(watch, start);
    if (verdict === null) continue;

    const signedIn = isSignedIn(app);
    const cause = typeof verdict === 'string' ? verdict : describeFailure(verdict, signedIn);
    const inAppBrowser = inAppBrowserName();
    const message = `[app-check] Locked out: ${signedIn ? 'signed in' : 'signed out'} · ${cause}${inAppBrowser ? ` · ${inAppBrowser} in-app browser` : ''}`;
    const key = `${pageKey} ${message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    try { console.error(message); } catch { /* no console */ }
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
 * timing; only their start times) and judges each against what App Check had at that moment, and for each request
 * that went out without a valid token writes, once per page load per kind:
 *
 *   [app-check] Locked out: signed in · Google refused this browser · sign-in backup refused (HTTP 429) · Instagram in-app browser
 *
 * to console.error, which Tracer records as one error per kind; calls `onLockout`; and tells onAppCheckStatus
 * listeners `{ state: 'locked_out', ... }`. The message is fixed words only, never an address, person, token, time or
 * count.
 *
 * How a request is judged:
 *   - App Check on this kit's provider: by what the provider's own token requests came to (see ourVerdict). The watch
 *     never listens to App Check's tokens for it.
 *   - App Check on another provider (the iOS and Android apps): by App Check's token events, followed from the first
 *     Firestore request on; a request after an error event, with no token since, is a lockout.
 *   - App Check not started: every request ('App Check not running on this page').
 *
 * Call it once, right after the site's App Check block, whether or not App Check started. RecoveringReCaptchaProvider
 * starts it by itself; calling it again for the same app adds `onLockout` to the same watch. It never starts App Check
 * or Auth, never throws into the page, and does nothing on a developer's machine (localhost), outside a browser, or
 * if Firebase's internal _getProvider is gone. Returns a function that stops it.
 */
export function watchAppCheckLockouts(app: FirebaseApp, options: { onLockout?: (lockout: AppCheckLockout) => void } = {}): () => void {
  if (typeof window === 'undefined' || !app) return noop;
  const perf = globalThis.performance;
  const Observer = globalThis.PerformanceObserver;
  if (!perf || typeof perf.now !== 'function' || typeof Observer !== 'function') return noop;
  try { if (isLocalDevelopment()) return noop; } catch { return noop; }
  // Without Firebase's _getProvider the watch cannot tell whether App Check is running, and would report every request.
  if (typeof (firebaseApp as unknown as { _getProvider?: unknown })._getProvider !== 'function') return noop;

  let watch = watches.get(app);
  if (!watch) {
    const fresh: Watch = {
      refs: 0, callbacks: new Set(), events: [], tokenSubscription: null, blind: false,
      observer: null, pending: [], flushScheduled: false,
    };
    const projectId = typeof app.options?.projectId === 'string' ? app.options.projectId : null;
    const pageKey = String(perf.timeOrigin ?? '');
    const flush = (): void => {
      try {
        fresh.flushScheduled = false;
        const batch = fresh.pending.splice(0);
        if (batch.length && watches.get(app) === fresh) judge(app, fresh, batch, pageKey);
      } catch { /* the watch never throws into the page */ }
    };
    const take = (entries: PerformanceEntryList): void => {
      try {
        // Each start on the wall clock, from how long ago it was on the performance clock (see above).
        const wallNow = Date.now();
        const perfNow = perf.now();
        for (const entry of entries) {
          // Firestore's channel addresses carry the ID token and the App Check token: only the start time is kept.
          if (typeof entry.startTime === 'number' && isFirestoreRequest(entry.name, projectId)) {
            fresh.pending.push(wallNow - (perfNow - entry.startTime));
          }
        }
        if (!fresh.pending.length || fresh.flushScheduled) return;
        fresh.flushScheduled = true;
        setTimeout(flush, 0);
      } catch { /* the watch never throws into the page */ }
    };
    try {
      const observer = new Observer((list) => {
        try { take(list.getEntries()); } catch { /* the watch never throws into the page */ }
      });
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
    watches.set(app, fresh);
    watch = fresh;
  }

  const current = watch;
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
