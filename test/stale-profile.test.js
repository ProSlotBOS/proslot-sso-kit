// Stale-read audit SSO-1: pins the source pattern (SSOCallback is a React component with an
// effect-driven flow; no renderer is installed, so the logic is checked from source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/SSOCallback.tsx', import.meta.url), 'utf8');

test('SSO-1: after the profile gate PUT succeeds the site is told the profile changed (or the page fully reloads)', () => {
  const start = src.indexOf('const submitProfile');
  assert.ok(start > 0);
  const end = src.indexOf('const retry', start);
  const body = src.slice(start, end);
  const afterPut = body.slice(body.indexOf("method: 'PUT'"));
  // The site hydrated its own profile (without name/phone) before the gate form appeared and
  // keeps that copy in memory through an in-app navigate(). It needs a callback to refresh it.
  const notifiesSite = /onProfileSaved\??\.?\(|config\.onProfileSaved/.test(afterPut);
  const fullReload = /window\.location\.(replace|assign)\(\s*profileGate\.destination/.test(afterPut);
  assert.ok(notifiesSite || fullReload, 'submitProfile persists name/phone and navigates in-app; the site profile copy stays stale');
});
