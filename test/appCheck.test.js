/**
 * RecoveringReCaptchaProvider: App Check that retries a refusal within minutes.
 *
 * Firebase's reCAPTCHA Enterprise provider blocks every new attempt for a day after a 403
 * ("App attestation failed"). Two coaches with league tabs open all day had one background
 * refresh refused on 2026-10-26/27 (Tracer 1373cc53be10d39c, 884ee4d121027c7f): once App
 * Check is enforced, that day-long block would leave them unable to read anything from
 * Firebase. These tests pin the provider that shortens it.
 *
 * The first block checks the installed Firebase still has the two details the provider
 * relies on, so an upgrade that changes them fails here, before a release. The rest drive
 * the provider with Firebase's own provider replaced by a stand-in that behaves as Firebase
 * does after a 403: it sets a day-long throttle and refuses every call inside it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as firebaseApp from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { RecoveringReCaptchaProvider, onAppCheckStatus, APP_CHECK_RETRY_AFTER_MS } from '../dist/appCheck.js';

const DAY = 24 * 60 * 60 * 1000;

test('the installed Firebase still throttles a 403 the way the provider expects', () => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@firebase/app-check/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  // The build file's name differs by version (index.esm2017.js in 0.10, index.esm.js in 0.12).
  const source = readFileSync(pkgPath.replace(/package\.json$/, pkg.module), 'utf8');
  const provider = source.slice(source.indexOf('class ReCaptchaEnterpriseProvider'), source.indexOf('class CustomProvider'));
  assert.match(provider, /throwIfThrottled\(this\._throttleData\)/, 'the provider checks its throttle in _throttleData');
  assert.match(provider, /this\._throttleData = setBackoff\(/, 'a failed exchange sets _throttleData');
  assert.match(provider, /"initial-throttle"[\s\S]{0,200}httpStatus: this\._throttleData\.httpStatus/, 'the error carries the status');
  assert.match(source, /if \(httpStatus === 404 \|\| httpStatus === 403\)[\s\S]{0,120}ONE_DAY/, 'a 403 still means a day');
  assert.equal(new ReCaptchaEnterpriseProvider('k')._throttleData, null, 'a new provider starts unthrottled');
});

// A stand-in for Firebase's getToken, written to the code checked above: a scripted
// exchange result ('403', '404' or 'ok'), a throttle in _throttleData, and the same errors.
let script = [];
let exchanges = 0;
function refuse(code, httpStatus) {
  return Object.assign(new Error(code), { code: `appCheck/${code}`, customData: { httpStatus } });
}
async function firebaseGetToken() {
  if (this._throttleData && Date.now() < this._throttleData.allowRequestsAfter) {
    throw refuse('throttled', this._throttleData.httpStatus);
  }
  exchanges += 1;
  const next = script.shift() ?? 'ok';
  if (next === '403' || next === '404') {
    this._throttleData = { backoffCount: 1, allowRequestsAfter: Date.now() + DAY, httpStatus: Number(next) };
    throw refuse('initial-throttle', Number(next));
  }
  this._throttleData = null;
  return { token: 'app-check-token', expireTimeMillis: Date.now() + 3_600_000, issuedAtTimeMillis: Date.now() };
}

function setup(t, { timers = ['Date'] } = {}) {
  const original = ReCaptchaEnterpriseProvider.prototype.getToken;
  ReCaptchaEnterpriseProvider.prototype.getToken = firebaseGetToken;
  mock.timers.enable({ apis: timers, now: 1_800_000_000_000 });
  const heard = [];
  const stop = onAppCheckStatus((s) => heard.push(s));
  script = [];
  exchanges = 0;
  t.after(() => {
    ReCaptchaEnterpriseProvider.prototype.getToken = original;
    mock.timers.reset();
    stop();
  });
  return { provider: new RecoveringReCaptchaProvider('site-key'), heard };
}

test('for comparison, Firebase\'s own provider waits a full day after a refusal', async (t) => {
  setup(t);
  const firebase = new ReCaptchaEnterpriseProvider('site-key');
  script = ['403'];
  await assert.rejects(firebase.getToken(), { code: 'appCheck/initial-throttle' });
  mock.timers.tick(DAY - 60_000);
  await assert.rejects(firebase.getToken(), { code: 'appCheck/throttled' });
  assert.equal(exchanges, 1);
});

test('after a refusal the next check is 30 seconds away, not a day', async (t) => {
  const { provider, heard } = setup(t);
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.deepEqual(heard, [{ state: 'refused', inARow: 1, retryInMs: 30_000 }]);

  mock.timers.tick(29_000);
  await assert.rejects(provider.getToken(), { code: 'appCheck/throttled' });
  mock.timers.tick(1_000);
  assert.equal((await provider.getToken()).token, 'app-check-token');
  assert.equal(exchanges, 2);
  assert.deepEqual(heard.at(-1), { state: 'recovered', afterRefusals: 1 });
});

test('refusals in a row wait longer each time, then hourly', async (t) => {
  const { provider, heard } = setup(t);
  script = Array(8).fill('403');
  for (let i = 0; i < 8; i++) {
    await assert.rejects(provider.getToken());
    mock.timers.tick(heard.at(-1).retryInMs);
  }
  assert.deepEqual(heard.map((s) => s.retryInMs), [...APP_CHECK_RETRY_AFTER_MS, 3_600_000, 3_600_000]);
  assert.deepEqual(APP_CHECK_RETRY_AFTER_MS, [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000]);
});

test('a success starts the waits over', async (t) => {
  const { provider, heard } = setup(t);
  script = ['403', '403', 'ok', '403'];
  await assert.rejects(provider.getToken());
  mock.timers.tick(30_000);
  await assert.rejects(provider.getToken());
  mock.timers.tick(60_000);
  await provider.getToken();
  await assert.rejects(provider.getToken());
  assert.deepEqual(heard.at(-1), { state: 'refused', inARow: 1, retryInMs: 30_000 });
});

test('a 404, a misconfigured site, keeps Firebase\'s day-long pause', async (t) => {
  const { provider, heard } = setup(t);
  script = ['404'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(heard.length, 0);
  mock.timers.tick(DAY - 1_000);
  await assert.rejects(provider.getToken(), { code: 'appCheck/throttled' });
});

test('a call refused inside the wait is not counted as another refusal', async (t) => {
  const { provider, heard } = setup(t);
  script = ['403'];
  await assert.rejects(provider.getToken());
  await assert.rejects(provider.getToken(), { code: 'appCheck/throttled' });
  await assert.rejects(provider.getToken(), { code: 'appCheck/throttled' });
  assert.equal(heard.length, 1);
  assert.equal(exchanges, 1);
});

test('without Firebase\'s throttle field it behaves exactly like Firebase\'s provider', async (t) => {
  const { provider, heard } = setup(t);
  ReCaptchaEnterpriseProvider.prototype.getToken = async function () {
    throw refuse('initial-throttle', 403); // a future Firebase that keeps its throttle elsewhere
  };
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(heard.length, 0);
  assert.equal(provider._throttleData, null);
});

test('it is still Firebase\'s provider as far as Firebase can tell', () => {
  const provider = new RecoveringReCaptchaProvider('site-key');
  assert.ok(provider instanceof ReCaptchaEnterpriseProvider);
  assert.equal(provider.isEqual(new ReCaptchaEnterpriseProvider('site-key')), true);
});

// ---------- the signed-in fallback (2026-11-03) ----------

const APP_ID = '1:473053764604:web:f07562f648e3618b663079';

function withFallback(t, {
  idToken = 'id-token',
  getIdToken = async () => idToken,
  answer = { status: 200, body: { token: 'fallback-token', expireTimeMillis: 1_800_001_800_000, issuedAtTimeMillis: 1_800_000_000_000 } },
  app = { options: { appId: APP_ID } },
  timers,
} = {}) {
  const { heard } = setup(t, { timers });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (answer === 'offline') throw new TypeError('fetch failed');
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const provider = new RecoveringReCaptchaProvider('site-key', {
    fallback: { getIdToken, apiBase: 'https://api.example/' },
  });
  provider._app = app;
  return { provider, heard, calls };
}

test('when reCAPTCHA is refused, a signed-in person gets the API\'s token instead of an error', async (t) => {
  const { provider, heard, calls } = withFallback(t);
  script = ['403'];
  const token = await provider.getToken();
  assert.equal(token.token, 'fallback-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example/api/app-check/token');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer id-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { appId: APP_ID });
  assert.deepEqual(heard.map((s) => s.state), ['refused', 'fallback']);
});

test('a blocked or timed-out reCAPTCHA (not a 403) falls back too, and the reCAPTCHA retry schedule stays', async (t) => {
  const { provider } = withFallback(t);
  const original = ReCaptchaEnterpriseProvider.prototype.getToken;
  ReCaptchaEnterpriseProvider.prototype.getToken = async () => { throw Object.assign(new Error('timeout'), { code: 'appCheck/recaptcha-error' }); };
  t.after(() => { ReCaptchaEnterpriseProvider.prototype.getToken = original; });
  assert.equal((await provider.getToken()).token, 'fallback-token');
});

test('nobody signed in: the original error stands and the API is not asked', async (t) => {
  const { provider, calls } = withFallback(t, { idToken: null });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(calls.length, 0);
});

test('a refused or unreachable fallback rethrows the original error and pauses a minute before asking again', async (t) => {
  for (const answer of [{ status: 403, body: { error: 'no' } }, 'offline']) await t.test(answer === 'offline' ? 'offline' : 'refused', async (st) => {
    const { provider, calls } = withFallback(st, { answer });
    script = ['403'];
    await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
    await assert.rejects(provider.getToken());
    assert.equal(calls.length, 1, 'no second request inside the pause');
    mock.timers.tick(60_000);
    script = ['403'];
    await assert.rejects(provider.getToken());
    assert.equal(calls.length, 2, 'asks again after the pause');
  });
});

test('without a fallback the provider behaves exactly as before', async (t) => {
  const { provider } = setup(t);
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
});

// ---------- the page-load gap (2026-11-05) ----------
//
// On a fresh page load Firebase asks for the first token before Auth has read the signed-in person back from
// storage. The fallback used to find auth.currentUser still null, give up, and pause for a minute, so the page's first
// Firestore reads went out with Firebase's placeholder token: under enforcement, a signed-in parent whose browser
// cannot pass reCAPTCHA (Instagram's, a blocker) would have been refused on every page load.

/**
 * Just enough of a Firebase app for Firebase's own _getProvider: a container whose 'auth' service is started (with
 * the given Auth) or not. Every other service is absent. Records each service asked for and anything started.
 */
function fakeApp(auth = null) {
  const started = [];
  const container = {
    getProvider(name) {
      if (name === 'auth' && auth) return { isInitialized: () => true, getImmediate: () => auth };
      return {
        isInitialized: () => false,
        getImmediate: (options) => {
          if (options?.optional) return null;
          started.push(name);
          throw new Error(`${name} was started`);
        },
      };
    },
  };
  return { app: { name: 'fake', options: { appId: APP_ID }, container }, started };
}

/** An Auth whose signed-in person comes back from storage only after `restoreAfterMs`. */
function restoringAuth(restoreAfterMs) {
  const auth = { currentUser: null, readyCalls: 0 };
  auth.authStateReady = () => {
    auth.readyCalls += 1;
    return new Promise((resolve) => setTimeout(() => { auth.currentUser = { uid: 'restored-parent' }; resolve(); }, restoreAfterMs));
  };
  return auth;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('page load: the fallback waits for Auth to read the signed-in person back, then gets the token', async (t) => {
  const auth = restoringAuth(20);
  const { app } = fakeApp(auth);
  const { provider, calls } = withFallback(t, { app, getIdToken: async () => (auth.currentUser ? 'id-token' : null) });
  script = ['403'];
  const token = await provider.getToken();
  assert.equal(token.token, 'fallback-token', 'without the wait, getIdToken would have found nobody');
  assert.equal(auth.readyCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer id-token');
});

test('page load: the wait for Auth is at most 5 seconds', async (t) => {
  const auth = { currentUser: null, authStateReady: () => new Promise(() => {}) }; // never restores
  const { app } = fakeApp(auth);
  let asked = 0;
  const { provider, calls } = withFallback(t, { app, timers: ['Date', 'setTimeout'], getIdToken: async () => { asked += 1; return null; } });
  script = ['403'];
  const pending = provider.getToken();
  await flush();
  mock.timers.tick(4_999);
  await flush();
  assert.equal(asked, 0, 'still waiting for Auth');
  mock.timers.tick(1);
  await assert.rejects(pending, { code: 'appCheck/initial-throttle' });
  assert.equal(asked, 1, 'asked once the 5 seconds were up');
  assert.equal(calls.length, 0);
});

test('a site that has not started Auth: no wait, and the provider never starts Auth itself', async (t) => {
  const { app, started } = fakeApp(null);
  let asked = 0;
  const { provider } = withFallback(t, { app, getIdToken: async () => { asked += 1; return null; } });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(asked, 1);
  assert.deepEqual(started, []);
});

test('the real Firebase: the fallback does not start Auth on an app that has none', async (t) => {
  const app = firebaseApp.initializeApp({ apiKey: ['not', 'a', 'key'].join('-'), projectId: 'demo-kit', appId: APP_ID }, 'no-auth-yet');
  t.after(() => firebaseApp.deleteApp(app));
  const { provider } = withFallback(t, { app, idToken: null });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(firebaseApp._getProvider(app, 'auth').isInitialized(), false);
});

test('finding nobody signed in does not pause the fallback: the next attempt asks again', async (t) => {
  let idToken = null;
  const { provider, calls } = withFallback(t, { getIdToken: async () => idToken });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  assert.equal(calls.length, 0, 'nobody signed in: the API is not asked');
  idToken = 'id-token'; // Auth caught up a moment later
  // Still inside reCAPTCHA's 30-second wait, so Firebase's provider refuses at once; the fallback answers.
  assert.equal((await provider.getToken()).token, 'fallback-token');
  assert.equal(calls.length, 1);
});

test('an ID token Auth cannot refresh does not pause the fallback either', async (t) => {
  let fail = true;
  const { provider, calls } = withFallback(t, { getIdToken: async () => { if (fail) throw new Error('auth/network-request-failed'); return 'id-token'; } });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  fail = false;
  assert.equal((await provider.getToken()).token, 'fallback-token');
  assert.equal(calls.length, 1);
});

test('an unreadable answer from the API pauses the fallback a minute, like a refusal', async (t) => {
  const { provider, calls } = withFallback(t, { answer: { status: 200, body: { nope: true } } });
  script = ['403'];
  await assert.rejects(provider.getToken(), { code: 'appCheck/initial-throttle' });
  await assert.rejects(provider.getToken());
  assert.equal(calls.length, 1, 'no second request inside the pause');
  mock.timers.tick(60_000);
  script = ['403'];
  await assert.rejects(provider.getToken());
  assert.equal(calls.length, 2);
});

test('the fallback token is timed on this device\'s clock, as Firebase times its own', async (t) => {
  // The API's clock says issued now and valid 30 minutes; this phone's clock is two hours slow. Timed by the API's
  // clock, Firebase would keep sending the token for two hours after it expired.
  const apiNow = 1_800_000_000_000 + 2 * 3_600_000;
  const { provider } = withFallback(t, { answer: { status: 200, body: { token: 'fallback-token', expireTimeMillis: apiNow + 1_800_000, issuedAtTimeMillis: apiNow } } });
  script = ['403'];
  const token = await provider.getToken();
  assert.equal(token.issuedAtTimeMillis, Date.now());
  assert.equal(token.expireTimeMillis, Date.now() + 1_800_000);
});

test('an answer without its issue time keeps the API\'s expiry, as before', async (t) => {
  const { provider } = withFallback(t, { answer: { status: 200, body: { token: 'fallback-token', expireTimeMillis: 1_800_001_000_000 } } });
  script = ['403'];
  assert.equal((await provider.getToken()).expireTimeMillis, 1_800_001_000_000);
});

// ---------- the Firebase internals the fallback relies on ----------

test('the installed Firebase still has _getProvider, the "auth" service and Auth\'s authStateReady', async (t) => {
  assert.equal(typeof firebaseApp._getProvider, 'function', 'firebase/app exports _getProvider');
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@firebase/app/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const browserBuild = readFileSync(pkgPath.replace(/package\.json$/, pkg.browser || pkg.module), 'utf8');
  assert.match(browserBuild, /export \{[^}]*\b_getProvider\b[^}]*\}/, 'the browser build exports _getProvider too');

  const app = firebaseApp.initializeApp({ apiKey: ['not', 'a', 'key'].join('-'), projectId: 'demo-kit', appId: APP_ID }, 'pin-auth');
  t.after(() => firebaseApp.deleteApp(app));
  const provider = firebaseApp._getProvider(app, 'auth');
  assert.equal(provider.isInitialized(), false, 'asking does not start Auth');
  const auth = getAuth(app);
  assert.equal(provider.isInitialized(), true);
  assert.equal(provider.getImmediate({ optional: true }), auth, 'the "auth" service is the Auth the site started');
  assert.equal(typeof auth.authStateReady, 'function');
  await auth.authStateReady(); // resolves once Auth has read its stored sign-in (none here)
  assert.equal(auth.currentUser, null);
});
