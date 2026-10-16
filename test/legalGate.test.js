/**
 * The Terms / Privacy check a signed-in page runs (LegalGate's helpers): it
 * reads what the account still owes, fails open when the check cannot be made,
 * and records acceptance with the method the hub would use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLegalStatus, recordLegalAcceptance } from '../dist/LegalGate.js';

const realFetch = globalThis.fetch;
const withFetch = async (impl, fn) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return impl(url, init); };
  try { return await fn(calls); } finally { globalThis.fetch = realFetch; }
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const token = ['test', 'id', 'token'].join('-');

test('reads what the account still owes, with the bearer token and no cache', async () => {
  await withFetch(() => json(200, { outstanding: ['privacy'], documents: { privacy: { title: 'ProSlot Privacy Policy', url: 'https://x/p', version: '2026-09-07' } }, hasRecord: true }), async (calls) => {
    const s = await fetchLegalStatus('https://api.test/', token);
    assert.deepEqual(s.outstanding, ['privacy']);
    assert.equal(s.hasRecord, true);
    assert.equal(calls[0].url, 'https://api.test/api/legal/status');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[0].init.cache, 'no-store');
  });
});

test('fails open: a failed or unreachable check returns null, never an outstanding list', async () => {
  await withFetch(() => json(500, { error: 'down' }), async () => {
    assert.equal(await fetchLegalStatus('https://api.test', token), null);
  });
  await withFetch(() => { throw new Error('offline'); }, async () => {
    assert.equal(await fetchLegalStatus('https://api.test', token), null);
  });
});

test('records acceptance of exactly the outstanding documents, with the method and client', async () => {
  await withFetch(() => json(201, { success: true }), async (calls) => {
    await recordLegalAcceptance('https://api.test', token, { documents: ['terms', 'privacy'], clientId: 'hometeamsports', method: 'catchup' });
    assert.equal(calls[0].url, 'https://api.test/api/legal/accept');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { documents: ['terms', 'privacy'], method: 'catchup', clientId: 'hometeamsports' });
  });
});

test('a refused acceptance throws the API message (e.g. staff signed in as someone else)', async () => {
  await withFetch(() => json(403, { error: 'Cannot accept legal documents on behalf of another user' }), async () => {
    await assert.rejects(
      recordLegalAcceptance('https://api.test', token, { documents: ['terms'], method: 'reaccept' }),
      /on behalf of another user/,
    );
  });
});
