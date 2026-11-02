import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEmailNotConfirmed, resendEmailConfirmation, refreshEmailConfirmed } from '../dist/emailConfirmation.js';

test('recognises the API refusal by reason, or by status and wording', () => {
  assert.equal(isEmailNotConfirmed({ code: 'email_not_verified' }), true);
  assert.equal(isEmailNotConfirmed({ reason: 'email_not_verified' }), true);
  assert.equal(isEmailNotConfirmed({ status: 403, message: 'Verify your email address to answer this invitation.' }), true);
  assert.equal(isEmailNotConfirmed({ status: 403, message: 'This invitation is not for you' }), false);
  assert.equal(isEmailNotConfirmed(new Error('Verify your email address')), false); // no status: not an API refusal
  assert.equal(isEmailNotConfirmed(null), false);
});

test('resend posts the site to the hub route and reads each answer', async () => {
  const calls = [];
  const answer = (status, body) => async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
  globalThis.fetch = answer(200, { sent: true });
  assert.deepEqual(await resendEmailConfirmation({ clientId: 'kingdommontessori', apiBase: 'https://api.example/' }, 'tok'), { status: 'sent' });
  assert.equal(calls[0].url, 'https://api.example/api/sso/verify-email');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { clientId: 'kingdommontessori' });
  globalThis.fetch = answer(200, { sent: false, alreadyVerified: true });
  assert.deepEqual(await resendEmailConfirmation({ clientId: 'x' }, 't'), { status: 'already-confirmed' });
  globalThis.fetch = answer(429, { error: 'A verification email was just sent.' });
  assert.deepEqual(await resendEmailConfirmation({ clientId: 'x' }, 't'), { status: 'wait', message: 'A verification email was just sent.' });
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await resendEmailConfirmation({ clientId: 'x' }, 't')).status, 'failed');
});

test('refresh forces a new token only once the address is confirmed', async () => {
  let forced = 0;
  const user = (verifiedAfterReload) => ({ emailVerified: false, async reload() { this.emailVerified = verifiedAfterReload; }, async getIdToken(force) { if (force) forced += 1; return 't'; } });
  assert.equal(await refreshEmailConfirmed(user(false)), false);
  assert.equal(forced, 0);
  assert.equal(await refreshEmailConfirmed(user(true)), true);
  assert.equal(forced, 1);
});
