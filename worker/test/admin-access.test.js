import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin } from '../src/admin-access.js';

test('admin requires the sole permitted, verified account', () => {
  assert.equal(isAdmin({ email: 'natquinson@gmail.com', emailVerified: true }), true);
  assert.equal(isAdmin({ email: 'NatQuinson@gmail.com', emailVerified: true }), true);
  for (const user of [null, {}, { email: 'natquinson@gmail.com' },
    { email: 'natquinson@gmail.com', emailVerified: false },
    { email: 'natquinson@gmail.com', emailVerified: 'true' },
    { email: 'someone@gmail.com', emailVerified: true },
    { email: 'natquinson+admin@gmail.com', emailVerified: true }]) {
    assert.equal(isAdmin(user), false);
  }
});

test('internal workflow identity remains supported after separate API-key verification', () => {
  assert.equal(isAdmin({ uid: 'admin-api-key', email: 'natquinson@gmail.com', emailVerified: true, _viaApiKey: true }), true);
  assert.equal(isAdmin({ _viaApiKey: true }), false);
});
