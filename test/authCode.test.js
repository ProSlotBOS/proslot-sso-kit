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
import { isStaleAuthCode } from '../dist/SSOCallback.js';
import { readAuthCodeFromUrl, resolveDestination } from '../dist/client.js';

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
