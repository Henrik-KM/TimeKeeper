import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDefaultWealthHistory,
  normalizeWealthEntry,
  parseOptionalWealthAmount,
  validateWealthGoal
} from '../../src/features/wealth/core.mjs';

test('new wealth installations start with an empty history', () => {
  assert.deepEqual(getDefaultWealthHistory(), []);
});

test('wealth normalization preserves imported fields and rejects invalid optional amounts', () => {
  const entry = normalizeWealthEntry({
    id: 'wealth-1',
    date: '2026-08-31',
    amount: '100 000',
    note: 'Opening balance',
    importedField: 'keep'
  });

  assert.deepEqual(entry, {
    id: 'wealth-1',
    date: '2026-08-31',
    amount: 100000,
    note: 'Opening balance',
    importedField: 'keep'
  });
  assert.equal(parseOptionalWealthAmount(''), null);
  assert.equal(parseOptionalWealthAmount('not money'), null);
  assert.equal(parseOptionalWealthAmount('12abc'), null);
  assert.equal(parseOptionalWealthAmount('1 250,50'), 1250.5);
  assert.equal(parseOptionalWealthAmount('-1'), -1);
});

test('wealth goals require a positive amount and validate an optional ISO date', () => {
  assert.deepEqual(validateWealthGoal('0', ''), {
    ok: false,
    reason: 'amount'
  });
  assert.deepEqual(validateWealthGoal('250000', '2027-08-31'), {
    ok: true,
    goal: { amount: 250000, date: '2027-08-31' }
  });
  assert.deepEqual(validateWealthGoal('250000', '2027-02-30'), {
    ok: false,
    reason: 'date'
  });
});
