/**
 * In-app browser detection and the hand-off between initiateSSO and a mounted
 * InAppBrowserNotice. TC Black Hawks, Oct 2026: parents arriving from the
 * Instagram bio link were refused by App Check (Tracer 22ed329ed986077a).
 * User agents below are the shapes Tracer recorded, trimmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInAppBrowser, chromeIntentUrl, confirmSignInBrowser, pendingInAppSignIn, registerInAppNotice,
} from '../dist/InAppBrowser.js';

const IG_ANDROID = 'Mozilla/5.0 (Linux; Android 10; SM-A605GN; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0 Mobile Safari/537.36 Instagram 453.0.0.57.79 Android (29/10; 420dpi)';
const IG_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0';
const FB_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]';
const MESSENGER = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/470.0]';
const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Mobile Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('names the app and platform for in-app browsers, null for real browsers', () => {
  assert.deepEqual(detectInAppBrowser(IG_ANDROID), { app: 'Instagram', platform: 'android' });
  assert.deepEqual(detectInAppBrowser(IG_IOS), { app: 'Instagram', platform: 'ios' });
  assert.deepEqual(detectInAppBrowser(FB_IOS), { app: 'Facebook', platform: 'ios' });
  assert.deepEqual(detectInAppBrowser(MESSENGER), { app: 'Messenger', platform: 'android' });
  assert.equal(detectInAppBrowser(CHROME), null);
  assert.equal(detectInAppBrowser(SAFARI), null);
});

test('the Chrome intent keeps the whole address and falls back to it', () => {
  const url = 'https://www.example.test/classes?utm_source=ig#top';
  const intent = chromeIntentUrl(url);
  assert.ok(intent.startsWith('intent://www.example.test/classes?utm_source=ig#top#Intent;scheme=https;package=com.android.chrome;'));
  assert.ok(intent.includes(`S.browser_fallback_url=${encodeURIComponent(url)}`));
  assert.equal(chromeIntentUrl('javascript:alert(1)'), null);
  assert.equal(chromeIntentUrl('not a url'), null);
});

test('without a mounted notice, sign-in goes straight on', async () => {
  await confirmSignInBrowser(IG_ANDROID);
  assert.equal(pendingInAppSignIn(), null);
});

test('with a notice mounted, an in-app sign-in waits for Continue and a real browser goes straight on', async () => {
  const unmount = registerInAppNotice();
  try {
    await confirmSignInBrowser(CHROME);
    assert.equal(pendingInAppSignIn(), null);
    let resumed = false;
    const waiting = confirmSignInBrowser(IG_IOS).then(() => { resumed = true; });
    await Promise.resolve();
    assert.equal(resumed, false);
    assert.deepEqual(pendingInAppSignIn().browser, { app: 'Instagram', platform: 'ios' });
    pendingInAppSignIn().proceed();
    await waiting;
    assert.equal(resumed, true);
  } finally {
    unmount();
  }
  assert.equal(pendingInAppSignIn(), null);
});
