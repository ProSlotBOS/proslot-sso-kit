/**
 * The lost-sign-in signal behind SignInLostNotice: reported once, cleared once,
 * and every change reaches the notice. Fed by api-client-kit's onSignInLost /
 * onSignInRestored (Boys of Summer, 28 Oct 2026: an admin's tab went on
 * showing him signed in while every signed-in call was refused).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportSignInLost, clearSignInLost, isSignInLost, onSignInLostChange } from '../dist/SignInLost.js';

test('a lost sign-in is reported once, and its clearing once', () => {
  const seen = [];
  const stop = onSignInLostChange(() => seen.push(isSignInLost()));
  try {
    assert.equal(isSignInLost(), false);
    reportSignInLost();
    reportSignInLost();
    assert.equal(isSignInLost(), true);
    clearSignInLost();
    clearSignInLost();
    assert.equal(isSignInLost(), false);
    assert.deepEqual(seen, [true, false]);
  } finally {
    stop();
  }
});

test('an unsubscribed listener hears nothing more', () => {
  let calls = 0;
  const stop = onSignInLostChange(() => { calls += 1; });
  stop();
  reportSignInLost();
  clearSignInLost();
  assert.equal(calls, 0);
});
