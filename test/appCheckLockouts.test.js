/**
 * watchAppCheckLockouts: a report for every kind of request that App Check enforcement would refuse.
 *
 * Joe, 2026-11-05: App Check gets switched on only after five days with no real person locked out, so the kit has
 * to say when a page sent Firestore a request without a valid App Check token, and why, before anyone is refused.
 *
 * These tests run the real Firebase App Check (its token state, its listeners, its placeholder token) on a real
 * Firebase app, with the browser around it faked: window, navigator, performance and PerformanceObserver (resource
 * timing), and reCAPTCHA replaced by a scripted stand-in as in test/appCheck. The first block pins the Firebase
 * behaviour the watch relies on, so an upgrade that changes it fails here, before a release.
 *
 * How the watch judges a request (Joe, 2026-11-05): for this kit's provider, by what the provider's own token requests
 * came to (a token held for its lifetime from when it arrived, or a failure), all on Date.now(); for another provider,
 * by App Check's token events, followed from the first Firestore request on; with App Check not started, every
 * request. Each request's start is put on the wall clock when resource timing reports it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as firebaseApp from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { CustomProvider, ReCaptchaEnterpriseProvider, initializeAppCheck, getToken, getLimitedUseToken, onTokenChanged, setTokenAutoRefreshEnabled } from 'firebase/app-check';
import { RecoveringReCaptchaProvider, onAppCheckStatus, watchAppCheckLockouts } from '../dist/appCheck.js';

const APP_ID = '1:473053764604:web:f07562f648e3618b663079';
const PROJECT = 'demo-proslot';
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone15,2; iOS 18_0; en_US)';

// Tokens are built here, never written out: an App Check token is a JWT whose claims say when it was issued and expires.
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function appCheckToken(lifetimeMs = 60 * MINUTE, issuedAt = Date.now()) {
  return [part({ alg: 'RS256', typ: 'JWT' }), part({ iat: Math.floor(issuedAt / 1000), exp: Math.floor((issuedAt + lifetimeMs) / 1000) }), 'signature'].join('.');
}

// A Firestore channel address as the SDK builds it: the tokens ride in $httpHeaders. The watch must never repeat it.
const MARKER = 'CHANNEL-SECRET-MARKER';
function firestoreUrl(project = PROJECT) {
  const url = new URL('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel');
  url.searchParams.set('database', `projects/${project}/databases/(default)`);
  url.searchParams.set('$httpHeaders', `X-Firebase-AppCheck:${MARKER}\r\n`);
  url.searchParams.set('VER', '8');
  return url.toString();
}

let pages = 0;

/**
 * A browser page: window and navigator, a performance clock that (as browsers on a Mac can) stops while the
 * computer sleeps, resource timing with buffered entries, and console.error captured.
 */
function fakePage(t, { hostname = 'club.example.com', protocol = 'https:', userAgent = SAFARI, capacitor, withObserver = true, oldBrowser = false } = {}) {
  pages += 1;
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const page = { observers: [], entries: [], slept: 0, errors: [], heard: [] };
  const timeOrigin = NOW - 10 * MINUTE + pages; // a new page load each test
  const performance = {
    timeOrigin,
    now: () => Date.now() - timeOrigin - page.slept,
    getEntriesByType: (type) => (type === 'resource' ? page.entries.slice() : []),
  };
  class FakeObserver {
    constructor(callback) { this.callback = callback; page.observers.push(this); }
    observe(options) {
      if (oldBrowser && !options.entryTypes) throw new TypeError('entryTypes is required');
      this.options = options;
      const old = page.entries.slice();
      if (options.buffered && old.length) queueMicrotask(() => this.callback({ getEntries: () => old }, this));
    }
    disconnect() { this.disconnected = true; }
  }
  const window = { location: { hostname, protocol } };
  if (capacitor) window.Capacitor = capacitor;

  const saved = ['window', 'performance', 'PerformanceObserver', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
  set('window', window);
  set('performance', performance);
  set('navigator', { userAgent });
  if (withObserver) set('PerformanceObserver', FakeObserver);
  else delete globalThis.PerformanceObserver;

  t.mock.method(console, 'error', (...args) => { page.errors.push(args.join(' ')); });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const stopHearing = onAppCheckStatus((status) => page.heard.push(status));
  t.after(() => {
    stopHearing();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    mock.timers.reset();
  });

  /** Firestore sent a request (started `startedAgoMs` before now) and resource timing reports it. */
  page.request = (url = firestoreUrl(), startedAgoMs = 0) => {
    const entry = { name: url, entryType: 'resource', initiatorType: 'xmlhttprequest', startTime: performance.now() - startedAgoMs, duration: 40 };
    page.entries.push(entry);
    for (const observer of page.observers) if (!observer.disconnected) observer.callback({ getEntries: () => [entry] }, observer);
  };
  /** Time passes; while asleep only the wall clock moves. */
  page.wait = (ms) => mock.timers.tick(ms);
  page.sleep = (ms) => { page.slept += ms; mock.timers.tick(ms); };
  page.lockouts = () => page.heard.filter((status) => status.state === 'locked_out');
  return page;
}

/** Let the page's queued work run (the watch judges requests just after resource timing reports them). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

let apps = 0;
function newApp(t) {
  apps += 1;
  const app = firebaseApp.initializeApp({ apiKey: ['not', 'a', 'key'].join('-'), projectId: PROJECT, appId: APP_ID }, `lockouts-${apps}`);
  t.after(() => firebaseApp.deleteApp(app).catch(() => {}));
  return app;
}

/**
 * Firebase Auth started on the app, with someone signed in (or not). The stand-in person goes in only once Auth has
 * finished starting: Firebase 11 sets currentUser itself while it starts (and would call the stand-in's
 * _stopProactiveRefresh), Firebase 12 does not.
 */
async function signIn(app, signedIn = true) {
  const auth = getAuth(app);
  await auth.authStateReady();
  const person = signedIn ? { uid: 'parent', _startProactiveRefresh() {}, _stopProactiveRefresh() {} } : null;
  Object.defineProperty(auth, 'currentUser', { get: () => person, set: () => {}, configurable: true });
  return auth;
}

/**
 * This kit's provider, with reCAPTCHA replaced by a stand-in that answers from `script`: 'ok' (a 60-minute token),
 * '403' (Google refused), 'recaptcha' (reCAPTCHA blocked or timed out), as Firebase's own provider would. `skew` is how
 * far this device's clock is ahead of Google's: the token's own iat and exp are on Google's clock, while Firebase times
 * the token on the device's (now + its time to live). `counter.calls` counts the times Firebase asked for a token.
 */
function withOurProvider(t, app, { script = [], fallback, skew = 0, counter = { calls: 0 }, autoRefresh = false } = {}) {
  const originals = { getToken: ReCaptchaEnterpriseProvider.prototype.getToken, initialize: ReCaptchaEnterpriseProvider.prototype.initialize };
  ReCaptchaEnterpriseProvider.prototype.initialize = function (a) { this._app = a; };
  ReCaptchaEnterpriseProvider.prototype.getToken = async function () {
    counter.calls += 1;
    if (this._throttleData && Date.now() < this._throttleData.allowRequestsAfter) {
      throw Object.assign(new Error('throttled'), { code: 'appCheck/throttled', customData: { httpStatus: this._throttleData.httpStatus } });
    }
    const next = script.shift() ?? 'ok';
    if (next === '403') {
      this._throttleData = { backoffCount: 1, allowRequestsAfter: Date.now() + 24 * 60 * MINUTE, httpStatus: 403 };
      throw Object.assign(new Error('initial-throttle'), { code: 'appCheck/initial-throttle', customData: { httpStatus: 403 } });
    }
    if (next === 'recaptcha') throw Object.assign(new Error('recaptcha-error'), { code: 'appCheck/recaptcha-error' });
    this._throttleData = null;
    return { token: appCheckToken(60 * MINUTE, Date.now() - skew), expireTimeMillis: Date.now() + 60 * MINUTE, issuedAtTimeMillis: Date.now() };
  };
  t.after(() => Object.assign(ReCaptchaEnterpriseProvider.prototype, originals));
  // Auto-refresh off by default: the test asks for each token itself, as Firestore does before each request.
  return initializeAppCheck(app, { provider: new RecoveringReCaptchaProvider('site-key', fallback ? { fallback } : {}), isTokenAutoRefreshEnabled: autoRefresh });
}

/** Firestore asking App Check for a token: always settles (Firebase hands out its placeholder on failure). */
const askForToken = (appCheck, forceRefresh = false) => getToken(appCheck, forceRefresh).then((r) => r.token, () => null);

/** The API's fallback route, answering `status` (or unreachable). */
function apiAnswers(t, status) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (status === 'offline') throw new TypeError('fetch failed');
    return { ok: status < 300, status, json: async () => (status < 300 ? { token: appCheckToken(30 * MINUTE), expireTimeMillis: Date.now() + 30 * MINUTE, issuedAtTimeMillis: Date.now() } : { error: 'no' }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

// ---------- the Firebase behaviour the watch relies on ----------

test('the installed Firebase: the "app-check" service, and App Check telling outside listeners about tokens', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  t.mock.method(console, 'warn', () => {});
  const app = newApp(t);
  const service = firebaseApp._getProvider(app, 'app-check');
  assert.equal(service.isInitialized(), false, 'asking does not start App Check');
  let fail = true;
  const appCheck = initializeAppCheck(app, {
    provider: new CustomProvider({ getToken: async () => { if (fail) throw new Error('no'); return { token: appCheckToken(), expireTimeMillis: Date.now() + 60 * MINUTE }; } }),
    isTokenAutoRefreshEnabled: false,
  });
  assert.equal(service.isInitialized(), true);
  assert.equal(service.getImmediate({ optional: true }), appCheck);

  const events = [];
  onTokenChanged(appCheck, { next: (r) => events.push(`next:${typeof r.token}`), error: () => events.push('error') });
  // A failed request: the outside listener hears error() before getToken settles, and Firestore gets a placeholder.
  await getToken(appCheck).then(() => events.push('resolved'), () => events.push('rejected'));
  assert.deepEqual(events, ['error', 'rejected']);
  // A valid token: next({ token }) before getToken settles.
  fail = false;
  events.length = 0;
  await getToken(appCheck).then(() => events.push('resolved'));
  assert.deepEqual(events, ['next:string', 'resolved']);
  // A listener added later hears the token App Check already holds.
  const late = [];
  onTokenChanged(appCheck, { next: (r) => late.push(typeof r.token), error: () => late.push('error') });
  await settle();
  assert.deepEqual(late, ['string']);
});

test('the installed Firebase asks the provider for a token only when it holds no valid one, judged on Date.now()', async (t) => {
  // The watch reads "the provider was not asked" as "Firebase sent a valid token it had", and times a token held from
  // when the provider handed it over, for expire - issued, on Date.now().
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  const app = newApp(t);
  let asked = 0;
  const appCheck = initializeAppCheck(app, {
    provider: new CustomProvider({ getToken: async () => { asked += 1; return { token: appCheckToken(), expireTimeMillis: Date.now() + 60 * MINUTE }; } }),
    isTokenAutoRefreshEnabled: false,
  });
  await getToken(appCheck);
  mock.timers.tick(59 * MINUTE);
  await getToken(appCheck);
  assert.equal(asked, 1, 'a valid token held: the provider is not asked');
  mock.timers.tick(2 * MINUTE);
  await getToken(appCheck);
  assert.equal(asked, 2, 'once it has run out on the device clock, it is');

  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@firebase/app-check/package.json');
  const source = readFileSync(pkgPath.replace(/package\.json$/, JSON.parse(readFileSync(pkgPath, 'utf8')).module), 'utf8');
  assert.match(source, /function isValid\(token\) \{\s*return token\.expireTimeMillis - Date\.now\(\) > 0;/, 'validity is expireTimeMillis against Date.now()');
  assert.match(source, /const now = Date\.now\(\);[\s\S]{0,300}expireTimeMillis: now \+ timeToLiveAsNumber,\s*issuedAtTimeMillis: now/, 'Firebase\'s own provider times a token on the device clock');
});

// ---------- this kit's provider: judged by what its own token requests came to ----------

test('the watch never listens to App Check\'s tokens for this kit\'s provider: a page that never reads Firestore asks for no token', async (t) => {
  // A listener would create Firebase's token refresher (and start it whenever auto-refresh is on), which asks Google
  // for a reCAPTCHA assessment and an exchange on pages that read only through the API and never needed a token.
  const page = fakePage(t);
  const app = newApp(t);
  const counter = { calls: 0 };
  const appCheck = withOurProvider(t, app, { counter });
  watchAppCheckLockouts(app); // the site's own call, besides the provider's
  await settle();
  assert.equal(page.observers.length, 1, 'watching all the same');
  setTokenAutoRefreshEnabled(appCheck, true); // starts a refresher if a listener had created one
  await settle();
  page.wait(10 * MINUTE);
  await settle();
  assert.equal(counter.calls, 0, 'no token was asked for');
  assert.deepEqual(page.errors, []);
});

test('the provider never asked before a request: Firebase sent a token it already had, not a lockout', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const counter = { calls: 0 };
  const appCheck = withOurProvider(t, app, { script: ['403'], counter });
  watchAppCheckLockouts(app);
  page.wait(1_000);
  page.request(); // with a token Firebase read back from storage
  await settle();
  assert.equal(counter.calls, 0);
  page.wait(MINUTE);
  assert.equal(await askForToken(appCheck), null); // a failure after that request says nothing about it
  await settle();
  assert.deepEqual(page.errors, []);
});

test('a device clock 40 minutes fast: a token is held for its lifetime from when it arrived, whatever its own times say', async (t) => {
  // Google's clock is right and this phone's is 40 minutes fast: by the token's own iat and exp it was issued 40
  // minutes ago and ends in 20. Firebase times it on the device clock, valid for the full hour from now, and so does
  // the watch.
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['ok'], skew: 40 * MINUTE });
  watchAppCheckLockouts(app);
  assert.ok(await askForToken(appCheck));
  page.wait(30 * MINUTE);
  page.request();
  page.wait(25 * MINUTE);
  assert.ok(await askForToken(appCheck), 'Firebase still holds it');
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
});

test('a refresh that fails while the last token is still held is not a lockout: Firebase keeps sending that token', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['ok', '403'] });
  watchAppCheckLockouts(app);
  assert.ok(await askForToken(appCheck));
  page.wait(40 * MINUTE);
  assert.equal(await askForToken(appCheck, true), null, 'the refresher\'s forced refresh, refused');
  assert.ok(await askForToken(appCheck), 'Firestore still gets the token from 40 minutes ago');
  page.request();
  page.wait(15 * MINUTE);
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
});

// ---------- when the page held a token ----------

test('a request sent while the page held a valid token is not a lockout', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['ok'] });
  watchAppCheckLockouts(app);
  assert.ok(await askForToken(appCheck));
  page.request();
  page.wait(30 * MINUTE);
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.lockouts(), []);
});

test('Google refused and the site has no sign-in backup: one report per kind, in fixed words only', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['403'] });
  const seen = [];
  watchAppCheckLockouts(app, { onLockout: (lockout) => seen.push(lockout) });
  assert.equal(await askForToken(appCheck), null);
  page.request();
  page.request();
  page.wait(MINUTE);
  page.request();
  await settle();

  const message = '[app-check] Locked out: signed out · Google refused this browser · no sign-in backup on this site';
  assert.deepEqual(page.errors, [message], 'once, however many requests');
  assert.deepEqual(seen, [{ signedIn: false, cause: 'Google refused this browser · no sign-in backup on this site', inAppBrowser: null, message }]);
  assert.deepEqual(page.lockouts(), [{ state: 'locked_out', signedIn: false, cause: 'Google refused this browser · no sign-in backup on this site', inAppBrowser: null }]);
  const everything = JSON.stringify([page.errors, seen, page.heard]);
  for (const leak of [MARKER, 'firestore.googleapis.com', 'https:', PROJECT, 'Listen']) assert.ok(!everything.includes(leak), `never repeats the request (${leak})`);
});

test('a request after the token ran out, when Firebase\'s request for a new one failed, is a lockout', async (t) => {
  // Firestore asks App Check for a token before each request; once the hour is up Firebase asks the provider again.
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['ok', '403'] });
  watchAppCheckLockouts(app);
  assert.ok(await askForToken(appCheck));
  page.wait(61 * MINUTE);
  assert.equal(await askForToken(appCheck), null);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · Google refused this browser · no sign-in backup on this site']);
});

test('a token got after a failure: requests from then on are not lockouts, the ones before it were', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['recaptcha', 'ok'] });
  watchAppCheckLockouts(app);
  assert.equal(await askForToken(appCheck), null);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ["[app-check] Locked out: signed out · Google's check could not run · no sign-in backup on this site"]);
  page.wait(MINUTE);
  assert.ok(await askForToken(appCheck));
  page.request();
  page.wait(30 * MINUTE);
  page.request();
  await settle();
  assert.equal(page.errors.length, 1);
});

test('a limited-use token request says nothing about the token Firebase keeps for Firestore', async (t) => {
  // Firebase 12 tells the provider a request is for a limited-use token; Firebase 11 and 10 do not, so there such a
  // request is recorded like any other (no ProSlot site asks for one).
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@firebase/app-check/package.json');
  const source = readFileSync(pkgPath.replace(/package\.json$/, JSON.parse(readFileSync(pkgPath, 'utf8')).module), 'utf8');
  if (!/provider\.getToken\(true/.test(source)) {
    t.skip('this Firebase does not tell the provider a request is limited-use');
    return;
  }
  const page = fakePage(t);
  const app = newApp(t);
  const counter = { calls: 0 };
  const appCheck = withOurProvider(t, app, { script: ['recaptcha'], counter });
  watchAppCheckLockouts(app);
  await assert.rejects(getLimitedUseToken(appCheck));
  assert.equal(counter.calls, 1);
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
});

test('the sign-in backup\'s answer names the cause, and the person is reported as signed in', async (t) => {
  for (const [answer, check, backup] of [
    [403, 'recaptcha', 'sign-in backup refused (HTTP 403)'],
    [429, '403', 'sign-in backup refused (HTTP 429)'],
    ['offline', 'recaptcha', 'sign-in backup unreachable'],
  ]) {
    await t.test(String(answer), async (st) => {
      const page = fakePage(st);
      const app = newApp(st);
      await signIn(app);
      apiAnswers(st, answer);
      const appCheck = withOurProvider(st, app, { script: [check], fallback: { getIdToken: async () => 'id-token', apiBase: 'https://api.example' } });
      watchAppCheckLockouts(app);
      assert.equal(await askForToken(appCheck), null);
      page.request();
      await settle();
      const google = check === '403' ? 'Google refused this browser' : "Google's check could not run";
      assert.deepEqual(page.errors, [`[app-check] Locked out: signed in · ${google} · ${backup}`]);
    });
  }
});

test('a signed-in person rescued by the sign-in backup is not locked out', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  await signIn(app);
  apiAnswers(t, 200);
  const appCheck = withOurProvider(t, app, { script: ['403'], fallback: { getIdToken: async () => 'id-token', apiBase: 'https://api.example' } });
  watchAppCheckLockouts(app);
  assert.ok(await askForToken(appCheck));
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
});

test('the backup found nobody signed in although Auth says someone is: that is named', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  await signIn(app);
  const appCheck = withOurProvider(t, app, { script: ['403'], fallback: { getIdToken: async () => null } });
  watchAppCheckLockouts(app);
  await askForToken(appCheck);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed in · Google refused this browser · sign-in backup saw nobody signed in']);
});

test('a signed-out visitor in Instagram\'s browser: who and which app are in the report', async (t) => {
  const page = fakePage(t, { userAgent: INSTAGRAM });
  const app = newApp(t);
  await signIn(app, false);
  const appCheck = withOurProvider(t, app, { script: ['recaptcha'], fallback: { getIdToken: async () => null } });
  const seen = [];
  watchAppCheckLockouts(app, { onLockout: (lockout) => seen.push(lockout) });
  await askForToken(appCheck);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ["[app-check] Locked out: signed out · Google's check could not run · Instagram in-app browser"]);
  assert.equal(seen[0].inAppBrowser, 'Instagram');
});

test('in-app browsers by name', async (t) => {
  for (const [ua, name] of [
    ['Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0;FBBV/1]', 'Facebook'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0;]', 'Facebook'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36 musical_ly_2023 BytedanceWebview', 'TikTok'],
    ['Mozilla/5.0 (iPhone) Mobile/15E148 Snapchat/12.0', 'Snapchat'],
    ['Mozilla/5.0 (iPhone) Mobile/15E148 Line/13.0.0', 'LINE'],
    ['Mozilla/5.0 (iPhone) Mobile/15E148 [LinkedInApp]', 'LinkedIn'],
    ['Mozilla/5.0 (iPhone) Mobile/15E148 Twitter for iPhone/10.0', 'Twitter'],
  ]) {
    await t.test(name, async (st) => {
      const page = fakePage(st, { userAgent: ua });
      const app = newApp(st);
      watchAppCheckLockouts(app);
      page.request();
      await settle();
      assert.deepEqual(page.errors, [`[app-check] Locked out: signed out · App Check not running on this page · ${name} in-app browser`]);
    });
  }
});

test('another provider (the native apps\'): the error code Firebase gave, or "token request failed"', async (t) => {
  for (const [error, cause] of [
    [Object.assign(new Error('x'), { code: 'appCheck/fetch-status-error' }), 'appCheck/fetch-status-error'],
    [new Error('App Check token took longer than 10000 ms'), 'token request failed'],
  ]) {
    await t.test(cause, async (st) => {
      const page = fakePage(st, { hostname: 'localhost', protocol: 'capacitor:' });
      const app = newApp(st);
      const appCheck = initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => { throw error; } }), isTokenAutoRefreshEnabled: false });
      watchAppCheckLockouts(app);
      page.request(); // the first Firestore request: App Check's tokens are followed from here
      await settle();
      await askForToken(appCheck);
      page.request();
      await settle();
      assert.deepEqual(page.errors, [`[app-check] Locked out: signed out · ${cause}`]);
    });
  }
});

test('another provider: followed only from the first Firestore request, then an error before a request is a lockout and a token is not', async (t) => {
  const page = fakePage(t, { hostname: 'localhost', protocol: 'capacitor:' });
  const app = newApp(t);
  let fail = true;
  let asked = 0;
  const appCheck = initializeAppCheck(app, {
    provider: new CustomProvider({ getToken: async () => {
      asked += 1;
      if (fail) throw Object.assign(new Error('x'), { code: 'appCheck/fetch-status-error' });
      return { token: appCheckToken(), expireTimeMillis: Date.now() + 60 * MINUTE };
    } }),
    isTokenAutoRefreshEnabled: false,
  });
  watchAppCheckLockouts(app);
  await settle();
  assert.equal(asked, 0, 'watching starts nothing');
  await askForToken(appCheck); // failed, before anything was followed
  page.request(); // the first request, with the placeholder: before the first event, so not judged
  await settle();
  page.request(); // no event yet either
  await settle();
  assert.deepEqual(page.errors, [], 'requests before the first event are not judged');

  await askForToken(appCheck); // error
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · appCheck/fetch-status-error']);

  fail = false;
  page.wait(MINUTE);
  assert.ok(await askForToken(appCheck)); // next
  page.request();
  page.wait(90 * MINUTE); // a token holds until the next error
  page.request();
  await settle();
  assert.equal(page.errors.length, 1);
  assert.equal(page.lockouts().length, 1);
});

test('App Check not started on the page: every Firestore request would be refused', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  await signIn(app);
  watchAppCheckLockouts(app);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed in · App Check not running on this page']);
  assert.equal(firebaseApp._getProvider(app, 'app-check').isInitialized(), false, 'the watch never starts App Check');
});

test('Firestore requests sent before the provider started App Check are named', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  page.request(); // Firestore read before the site's App Check block ran (seen later, from the buffer)
  page.wait(1_000);
  const appCheck = withOurProvider(t, app, { script: ['ok'] });
  watchAppCheckLockouts(app);
  await askForToken(appCheck);
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · App Check started after Firestore']);
});

test('the provider starts the watch by itself', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['403'] });
  await settle(); // the provider starts it just after App Check has started
  assert.equal(page.observers.length, 1);
  assert.deepEqual(page.observers[0].options, { type: 'resource', buffered: true });
  await askForToken(appCheck);
  page.request();
  await settle();
  assert.equal(page.errors.length, 1);
});

test('one watch per app: a second call adds its listener; each call stops only itself', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const first = [];
  const second = [];
  const stopFirst = watchAppCheckLockouts(app, { onLockout: (l) => first.push(l.cause) });
  const stopSecond = watchAppCheckLockouts(app, { onLockout: (l) => second.push(l.cause) });
  assert.equal(page.observers.length, 1);
  stopFirst();
  stopFirst();
  page.request();
  await settle();
  assert.deepEqual(first, []);
  assert.deepEqual(second, ['App Check not running on this page']);
  stopSecond();
  assert.equal(page.observers[0].disconnected, true, 'the last one out stops watching');
});

test('another Firebase project\'s Firestore on the same page is not this app\'s to judge', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  watchAppCheckLockouts(app);
  page.request(firestoreUrl('someone-else'));
  page.request('https://www.gstatic.com/firebasejs/app.js');
  await settle();
  assert.deepEqual(page.errors, []);
});

test('a computer that slept: a tab left open overnight is not misjudged', async (t) => {
  // The page's performance clock stops while a Mac sleeps; the wall clock does not.
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = withOurProvider(t, app, { script: ['ok', 'ok', 'ok'] });
  watchAppCheckLockouts(app);
  await askForToken(appCheck);
  page.wait(45 * MINUTE);
  page.request();
  page.sleep(10 * 60 * MINUTE);
  await askForToken(appCheck); // the old token ran out overnight: a new one on waking
  page.wait(35 * MINUTE);
  await askForToken(appCheck, true); // the refresh
  page.wait(35 * MINUTE);
  page.request();
  await settle();
  assert.deepEqual(page.errors, []);
});

test('a computer that slept: each request is put on the wall clock when it is seen, never at timeOrigin + startTime', async (t) => {
  // After ten hours asleep the performance clock is ten hours behind the wall clock, so timeOrigin + startTime puts a
  // request made on waking ten hours early, next to the page-load outcome. The watch works it out as
  // Date.now() - (performance.now() - startTime) when resource timing reports it.
  await t.test('refused at page load, a token on waking: requests after waking are not lockouts', async (st) => {
    const page = fakePage(st);
    const app = newApp(st);
    const appCheck = withOurProvider(st, app, { script: ['403', 'ok'] });
    watchAppCheckLockouts(app);
    assert.equal(await askForToken(appCheck), null);
    page.sleep(10 * 60 * MINUTE);
    assert.ok(await askForToken(appCheck));
    page.wait(MINUTE);
    page.request();
    await settle();
    assert.deepEqual(page.errors, []);
  });
  await t.test('a token at page load, refused on waking: requests after waking are lockouts', async (st) => {
    const page = fakePage(st);
    const app = newApp(st);
    const appCheck = withOurProvider(st, app, { script: ['ok', '403'] });
    watchAppCheckLockouts(app);
    assert.ok(await askForToken(appCheck));
    page.sleep(10 * 60 * MINUTE);
    assert.equal(await askForToken(appCheck), null);
    page.wait(MINUTE);
    page.request();
    await settle();
    assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · Google refused this browser · no sign-in backup on this site']);
  });
});

test('another provider: a token App Check already held when the watch started is not reported', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  const appCheck = initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => ({ token: appCheckToken(), expireTimeMillis: Date.now() + 60 * MINUTE }) }), isTokenAutoRefreshEnabled: false });
  await askForToken(appCheck);
  page.wait(5 * MINUTE);
  page.request(); // a Firestore read with that token, before the site called the watch
  page.wait(5 * MINUTE);
  watchAppCheckLockouts(app);
  await settle();
  assert.deepEqual(page.errors, []);
});

test('a device clock set wrong does not turn valid tokens into lockouts', async (t) => {
  for (const skew of [3 * 60 * MINUTE, -3 * 60 * MINUTE]) {
    await t.test(skew > 0 ? 'fast' : 'slow', async (st) => {
      const page = fakePage(st);
      const app = newApp(st);
      // Google's clock is right; this device's is three hours out. Firebase times the token on the device's clock.
      const appCheck = initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => ({ token: appCheckToken(60 * MINUTE, Date.now() - skew), expireTimeMillis: Date.now() + 60 * MINUTE }) }), isTokenAutoRefreshEnabled: false });
      watchAppCheckLockouts(app);
      await askForToken(appCheck);
      page.request(); // the first Firestore request: App Check's tokens are followed from here
      await settle();
      page.wait(50 * MINUTE);
      page.request();
      await settle();
      assert.deepEqual(page.errors, []);
    });
  }
});

// ---------- where it stays quiet ----------

test('nothing on a developer\'s machine, outside a browser, or without resource timing', async (t) => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'club.localhost']) {
    await t.test(hostname, async (st) => {
      const page = fakePage(st, { hostname, protocol: 'http:' });
      const app = newApp(st);
      const stop = watchAppCheckLockouts(app);
      assert.equal(typeof stop, 'function');
      page.request();
      await settle();
      assert.equal(page.observers.length, 0);
      assert.deepEqual(page.errors, []);
    });
  }
  await t.test('no PerformanceObserver', async (st) => {
    const page = fakePage(st, { withObserver: false });
    const app = newApp(st);
    assert.equal(typeof watchAppCheckLockouts(app), 'function');
    page.request();
    await settle();
    assert.deepEqual(page.errors, []);
  });
  await t.test('no window', async (st) => {
    const page = fakePage(st);
    delete globalThis.window;
    const app = newApp(st);
    watchAppCheckLockouts(app);
    assert.equal(page.observers.length, 0);
  });
});

test('the iOS and Android apps serve from localhost too, and are watched', async (t) => {
  for (const [name, options] of [
    ['iOS', { hostname: 'localhost', protocol: 'capacitor:' }],
    ['Android', { hostname: 'localhost', protocol: 'https:', capacitor: { isNativePlatform: () => true } }],
  ]) {
    await t.test(name, async (st) => {
      const page = fakePage(st, options);
      const app = newApp(st);
      watchAppCheckLockouts(app);
      page.request();
      await settle();
      assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · App Check not running on this page']);
    });
  }
});

test('the watch never throws into the page', async (t) => {
  const page = fakePage(t);
  const app = newApp(t);
  watchAppCheckLockouts(app, { onLockout: () => { throw new Error('a site\'s callback'); } });
  assert.doesNotThrow(() => page.observers[0].callback({ getEntries: () => { throw new Error('a broken entry list'); } }));
  assert.doesNotThrow(() => page.observers[0].callback({ getEntries: () => [{ get name() { throw new Error('a broken entry'); }, startTime: 1 }] }));
  page.request();
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · App Check not running on this page']);
});

test('a browser from before buffered resource timing: what is already there is read, and new requests watched', async (t) => {
  const page = fakePage(t, { oldBrowser: true });
  const app = newApp(t);
  page.request(); // before the watch
  watchAppCheckLockouts(app);
  assert.deepEqual(page.observers[0].options, { entryTypes: ['resource'] });
  await settle();
  assert.deepEqual(page.errors, ['[app-check] Locked out: signed out · App Check not running on this page']);
});
