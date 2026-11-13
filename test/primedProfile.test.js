/**
 * The callback caches the signed-in profile (name, email, phone, role) in
 * localStorage. The kit had no way to remove it, so on a shared device it
 * outlived sign-out. clearPrimedProfile removes it; primeLocalStorage: false
 * stores nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const client = await import('../dist/client.js');
const profile = { uid: 'u1', email: 'parent@example.test', firstName: 'Pat', phone: '5550100' };

test('clearPrimedProfile removes the cached profile under the configured key', () => {
  const config = { clientId: 'x', appName: 'X', profileStorageKey: 'site_user_profile' };
  client.primeProfile(config, profile, 'PARENT');
  assert.equal(client.readPrimedProfile(config)?.email, 'parent@example.test');
  assert.equal(typeof client.clearPrimedProfile, 'function');
  client.clearPrimedProfile(config);
  assert.equal(client.readPrimedProfile(config), null);
});

test('clearPrimedProfile uses the default key when none is configured', () => {
  const config = { clientId: 'x', appName: 'X' };
  client.primeProfile(config, profile, 'PARENT');
  client.clearPrimedProfile(config);
  assert.equal(store.size, 0);
});

test('primeLocalStorage: false stores nothing', () => {
  client.primeProfile({ clientId: 'x', appName: 'X', primeLocalStorage: false }, profile, 'PARENT');
  assert.equal(store.size, 0);
});
