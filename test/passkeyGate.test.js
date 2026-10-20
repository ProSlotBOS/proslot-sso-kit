/**
 * The passkey gate's helpers (PasskeyGate): the status check a staff page runs before it renders. It asks for the
 * org's own answer, fails open when the check cannot be made (the API is what enforces), and recognises the API's
 * passkey refusal and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPasskeyStatus, isPasskeyRefusal } from '../dist/PasskeyGate.js';

const realFetch = globalThis.fetch;
const withFetch = async (impl, fn) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return impl(url, init); };
  try { return await fn(calls); } finally { globalThis.fetch = realFetch; }
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const token = ['test', 'id', 'token'].join('-');

test("asks for the org's own answer, with the bearer token and no cache", async () => {
  await withFetch(() => json(200, { required: true, enrolled: false, verified: false, maxAgeHours: 12, passkeys: [] }), async (calls) => {
    const s = await fetchPasskeyStatus('https://api.test/', token, 'proslotplayernetwork');
    assert.deepEqual(s, { required: true, enrolled: false, verified: false, maxAgeHours: 12 });
    assert.equal(calls[0].url, 'https://api.test/api/auth/passkeys/status?school=proslotplayernetwork');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[0].init.cache, 'no-store');
  });
});

test('the org id is encoded into the query', async () => {
  await withFetch(() => json(200, {}), async (calls) => {
    await fetchPasskeyStatus('https://api.test', token, 'a b&c');
    assert.equal(calls[0].url, 'https://api.test/api/auth/passkeys/status?school=a%20b%26c');
  });
});

test('fails open: an error answer or an unreachable API returns null, never a "required"', async () => {
  await withFetch(() => json(500, { error: 'boom' }), async () => assert.equal(await fetchPasskeyStatus('https://api.test', token, 'org'), null));
  await withFetch(() => { throw new TypeError('network'); }, async () => assert.equal(await fetchPasskeyStatus('https://api.test', token, 'org'), null));
});

test("recognises the API's passkey refusal and nothing else", () => {
  assert.equal(isPasskeyRefusal(403, { error: 'passkey_required', code: 'PASSKEY_VERIFY' }), true);
  assert.equal(isPasskeyRefusal(403, { error: 'ProSlot staff only.' }), false);
  assert.equal(isPasskeyRefusal(401, { error: 'passkey_required' }), false);
  assert.equal(isPasskeyRefusal(403, null), false);
});
