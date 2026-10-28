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

function setup(t) {
  const original = ReCaptchaEnterpriseProvider.prototype.getToken;
  ReCaptchaEnterpriseProvider.prototype.getToken = firebaseGetToken;
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
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
