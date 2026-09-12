/**
 * The SSO callback's handling of a code that is no longer good, plus the URL
 * and destination logic around it.
 *
 * A one-time auth code that has expired, been spent, or come out of browser
 * history is a normal thing for a callback page to meet. It used to be treated
 * as a crash: a red "Sign-In Failed · Auth code expired" panel whose Try Again
 * button went to the home page rather than back into sign-in, logged with
 * console.error so Tracer opened a production error for it (Stan Musial,
 * 6 Sep 2026, zero affected users).
 *
 * These tests pin the classifier that separates that recoverable case from a
 * genuine sign-in failure, and cover the neighbouring pure logic the callback
 * depends on, which had no tests at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaleAuthCode, isMissingVerifier } from '../dist/SSOCallback.js';
import { readAuthCodeFromUrl, resolveDestination, createCodeVerifier, codeChallengeFor } from '../dist/client.js';
import { createHash } from 'node:crypto';

test('a spent, missing or expired code is recognised as recoverable', () => {
  for (const m of [
    'Auth code expired',
    'auth code expired',
    'Invalid or expired auth code',
    'Auth code not found',
    'Auth code already used',
  ]) assert.equal(isStaleAuthCode(m), true, m);
});

test('a real sign-in failure is NOT swallowed as recoverable', () => {
  for (const m of [
    'Auth code was not issued for this client',
    'Redirect URI mismatch',
    'SSO client misconfigured (no orgId): stanmusialmensleague',
    'Token exchange failed (HTTP 500)',
    'Failed to fetch',
    '',
    undefined,
  ]) assert.equal(isStaleAuthCode(m), false, String(m));
});

test('the code is read from a query string, a hash route, or state', () => {
  assert.deepEqual(
    readAuthCodeFromUrl('https://www.listanmusial.com/auth/callback?code=abc&returnTo=/leagues'),
    { code: 'abc', returnTo: '/leagues' },
  );
  // Hash-router satellites (East Coast) put the query after the hash.
  assert.deepEqual(
    readAuthCodeFromUrl('https://www.eastcoastyouthbaseball.com/#/auth/callback?code=xyz&state=/teams'),
    { code: 'xyz', returnTo: '/teams' },
  );
  assert.deepEqual(
    readAuthCodeFromUrl('https://www.liboysofsummer.com/auth/callback'),
    { code: null, returnTo: null },
  );
});

test('returnTo is honoured only when it is a same-site path', () => {
  const config = { postLoginRoutes: { ADMIN: '/admin', PARENT: '/dashboard', default: '/' } };
  const ctx = (over) => ({ role: 'PARENT', isAdmin: false, ...over });

  assert.equal(resolveDestination(config, ctx({ returnTo: '/leagues?register=abc' })), '/leagues?register=abc');
  // Protocol-relative is an off-site redirect wearing a leading slash.
  assert.equal(resolveDestination(config, ctx({ returnTo: '//evil.example.com' })), '/dashboard');
  assert.equal(resolveDestination(config, ctx({ returnTo: 'https://evil.example.com' })), '/dashboard');
  assert.equal(resolveDestination(config, ctx({ returnTo: null })), '/dashboard');
});

test('a platform admin lands in the admin area even when the org role says otherwise', () => {
  const config = { postLoginRoutes: { ADMIN: '/admin', PARENT: '/dashboard', default: '/' } };
  assert.equal(resolveDestination(config, { role: 'PARENT', isAdmin: true, returnTo: null }), '/admin');
  assert.equal(resolveDestination(config, { role: 'PARENT', isAdmin: false, returnTo: null }), '/dashboard');
  assert.equal(resolveDestination(config, { role: 'UMPIRE', isAdmin: false, returnTo: null }), '/');
});

/**
 * PKCE (RFC 7636).
 *
 * Most ProSlot SSO clients are public and the native ones return on a custom
 * scheme any app can claim, so an intercepted code used to be exchangeable on
 * its own. The verifier never leaves the device — only its SHA-256 hash
 * travels through the hub and the redirect — so an interceptor holding the
 * code still cannot complete the exchange.
 */
test('a code verifier is high-entropy, unique, and inside the RFC 7636 length range', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const v = createCodeVerifier();
    assert.match(v, /^[A-Za-z0-9\-._~]+$/, 'must be unreserved characters only');
    assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length} outside 43-128`);
    assert.ok(!seen.has(v), 'verifiers must not repeat');
    seen.add(v);
  }
});

test('the challenge is the base64url SHA-256 of the verifier, and is not the verifier', async () => {
  const verifier = createCodeVerifier();
  const challenge = await codeChallengeFor(verifier);

  const expected = createHash('sha256').update(verifier, 'ascii').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);

  // The whole point: what travels over the wire does not reveal the secret.
  assert.notEqual(challenge, verifier);
  assert.equal(challenge.length, 43);
});

test('a different verifier produces a different challenge', async () => {
  const a = await codeChallengeFor(createCodeVerifier());
  const b = await codeChallengeFor(createCodeVerifier());
  assert.notEqual(a, b);
});

/**
 * A callback that ran in a browsing context which never held the PKCE verifier.
 *
 * sessionStorage is per-tab, so a hub that returns in a different tab from the
 * one that started sign-in carries a code whose challenge this tab cannot
 * answer. Boys of Summer, 12 Sep 2026: a coach on iOS Safari was shown
 * "Sign-In Failed · code_verifier is required for this authorization code" —
 * wording that means nothing to them — for what one fresh attempt fixes.
 */
test('a missing PKCE verifier is recognised as recoverable', () => {
  for (const m of [
    'code_verifier is required for this authorization code',
    'Code_Verifier Is Required',
  ]) assert.equal(isMissingVerifier(m), true, m);
});

test('a failed PKCE check is NOT treated as recoverable', () => {
  // A verifier that does not match the challenge is a real failure — possibly
  // an intercepted code — and must never be retried around.
  assert.equal(isMissingVerifier('Invalid code_verifier'), false);
});

test('unrelated failures stay real failures', () => {
  for (const m of [
    'Unknown client: boysofsummerleague',
    'Redirect URI mismatch',
    'Client is deactivated',
    'Token exchange failed (HTTP 500)',
  ]) {
    assert.equal(isMissingVerifier(m), false, m);
    assert.equal(isStaleAuthCode(m), false, m);
  }
});

test('the two recoverable classes do not overlap', () => {
  assert.equal(isStaleAuthCode('code_verifier is required for this authorization code'), false);
  assert.equal(isMissingVerifier('Auth code expired'), false);
});

test('an empty or missing message is not recoverable', () => {
  for (const m of ['', null, undefined]) {
    assert.equal(isMissingVerifier(m), false);
    assert.equal(isStaleAuthCode(m), false);
  }
});
