import test from 'node:test';
import assert from 'node:assert/strict';
import { digestToken, hashPassword, newSessionToken, verifyPassword } from '../src/auth.mjs';

test('passwords use salted scrypt hashes', async () => {
  const first = await hashPassword('a-strong-password-123');
  const second = await hashPassword('a-strong-password-123');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a-strong-password-123', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
});

test('session digest never stores the bearer token verbatim', () => {
  const token = newSessionToken();
  assert.notEqual(digestToken(token), token);
  assert.equal(digestToken(token).length, 64);
});
