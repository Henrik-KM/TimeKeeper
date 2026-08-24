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

test('top performance cache round trips the top three rows for both ranges', () => {
  const storage = makeStorage();
  const topRows = {
    7: [
      { model: 'gpt-5.6-sol', effort: 'high' },
      { model: 'gpt-5.6-luna', effort: 'max' }
    ],
    30: [
      { model: 'gpt-5.6-luna', effort: 'max' },
      { model: 'gpt-5.6-sol', effort: 'medium' },
      { model: 'gpt-5.6-sol', effort: 'high' }
    ]
  };
  assert.equal(
    writeCodexTopPerformanceCache(
      {
        signature: 'signature-1',
        computedAt: '2026-08-24T18:00:00.000Z',
        topRows
      },
      storage
    ),
    true
  );
  assert.deepEqual(readCodexTopPerformanceCache(storage), {
    version: 2,
    signature: 'signature-1',
    computedAt: '2026-08-24T18:00:00.000Z',
    topRows,
    rows: {
      7: topRows[7][0],
      30: topRows[30][0]
    }
  });
});

test('top performance cache migrates a legacy single-row cache', () => {
  const storage = makeStorage();
  storage.setItem(
    'timekeeperCodexTopPerformanceCacheV1',
    JSON.stringify({
      version: 1,
      signature: 'legacy',
      computedAt: '2026-08-24T18:00:00.000Z',
      rows: {
        7: { model: 'gpt-5.6-sol', effort: 'high' },
        30: { model: 'gpt-5.6-luna', effort: 'max' }
      }
    })
  );
  assert.deepEqual(readCodexTopPerformanceCache(storage)?.topRows, {
    7: [{ model: 'gpt-5.6-sol', effort: 'high' }],
    30: [{ model: 'gpt-5.6-luna', effort: 'max' }]
  });
});

test('top performance cache rejects malformed stored data', () => {
  const storage = makeStorage();
  storage.setItem('timekeeperCodexTopPerformanceCacheV1', '{bad json');
  assert.equal(readCodexTopPerformanceCache(storage), null);
});
