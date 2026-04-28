import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLocalDateString } from '../../src/shared/runtime-helpers.mjs';

test('parseLocalDateString rejects impossible ISO-like dates', () => {
  assert.equal(parseLocalDateString('2026-02-31'), null);
  assert.equal(parseLocalDateString('2026-04-31T08:00:00.000Z'), null);
  assert.equal(parseLocalDateString('2026-04-01not-a-date'), null);
});

test('parseLocalDateString preserves valid local dates from date-like values', () => {
  const dateOnly = parseLocalDateString('2026-04-01');
  assert.equal(dateOnly.getFullYear(), 2026);
  assert.equal(dateOnly.getMonth(), 3);
  assert.equal(dateOnly.getDate(), 1);

  const timestamp = parseLocalDateString('2026-04-01T23:00:00.000Z');
  assert.equal(timestamp.getFullYear(), 2026);
  assert.equal(timestamp.getMonth(), 3);
  assert.equal(timestamp.getDate(), 1);
});
