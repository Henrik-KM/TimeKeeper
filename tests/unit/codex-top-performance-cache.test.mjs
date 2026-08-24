import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCodexAnalyticsDataSignature,
  readCodexTopPerformanceCache,
  writeCodexTopPerformanceCache
} from '../../src/features/codex/top-performance-cache.mjs';

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

test('analytics signature ignores timestamp-only quota polls', () => {
  const base = {
    updatedAt: '2026-08-24T18:00:00.000Z',
    entries: [{ id: 'entry-1' }],
    codexIntegration: {
      usageLimits: {
        observedAt: '2026-08-24T18:00:00.000Z',
        primary: {
          usedPercent: 26,
          remainingPercent: 74,
          windowMinutes: 10080,
          resetsAt: '2026-08-31T04:37:18.000Z'
        }
      }
    }
  };
  const laterPoll = structuredClone(base);
  laterPoll.codexIntegration.usageLimits.observedAt =
    '2026-08-24T18:01:00.000Z';
  assert.equal(
    getCodexAnalyticsDataSignature(base),
    getCodexAnalyticsDataSignature(laterPoll)
  );
});

test('top performance cache round trips both range winners', () => {
  const storage = makeStorage();
  const rows = {
    7: { model: 'gpt-5.6-sol', effort: 'high' },
    30: { model: 'gpt-5.6-luna', effort: 'max' }
  };
  assert.equal(
    writeCodexTopPerformanceCache(
      {
        signature: 'signature-1',
        computedAt: '2026-08-24T18:00:00.000Z',
        rows
      },
      storage
    ),
    true
  );
  assert.deepEqual(readCodexTopPerformanceCache(storage), {
    version: 1,
    signature: 'signature-1',
    computedAt: '2026-08-24T18:00:00.000Z',
    rows
  });
});

test('top performance cache rejects malformed stored data', () => {
  const storage = makeStorage();
  storage.setItem('timekeeperCodexTopPerformanceCacheV1', '{bad json');
  assert.equal(readCodexTopPerformanceCache(storage), null);
});
