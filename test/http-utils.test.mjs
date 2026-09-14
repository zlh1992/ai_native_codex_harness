import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from '../src/http-utils.mjs';

test('raw file ranges support suffix, open end, clipping, and arbitrary decimal bounds', () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=8-999', 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-99999999999999999999', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=0-99999999999999999999', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=00-00', 10), { start: 0, end: 0 });
});

test('raw file ranges reject empty, zero suffix, reversed, multi-range and unsatisfiable ranges', () => {
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=4-3', 'bytes=0-1,3-4', 'items=0-1', 'bytes=x-4', 'bytes=99999999999999999999-']) {
    assert.throws(() => parseByteRange(range, 10), error => error.status === 416 && error.code === 'INVALID_RANGE', range);
  }
  assert.throws(() => parseByteRange('bytes=0-', 0), error => error.status === 416);
  assert.throws(() => parseByteRange('bytes=-1', 0), error => error.status === 416);
});
