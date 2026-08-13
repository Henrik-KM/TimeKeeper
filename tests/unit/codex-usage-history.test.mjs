import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeUsageHistory,
  normalizeUsageCandidate
} from '../../scripts/codex-usage-history.mjs';

function candidate(
  observedAt,
  usedPercent,
  resetsAt = '2026-08-20T00:00:00.000Z'
) {
  return {
    observedAt,
    sourceMachineId: 'desktop-a',
    primary: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes: 10080,
      resetsAt
    },
    secondary: null
  };
}

test('normalizes the latest usage limits from a bridge inbox payload', () => {
  const normalized = normalizeUsageCandidate(
    {
      machineId: 'desktop-a',
      updatedAt: '2026-08-13T10:00:00.000Z',
      usageLimits: {
        observedAt: '2026-08-13T10:00:01.000Z',
        primary: {
          usedPercent: 18,
          remainingPercent: 82,
          windowMinutes: 10080,
          resetsAt: '2026-08-20T00:00:00.000Z'
        },
        secondary: null
      }
    },
    'desktop-a.json'
  );

  assert.equal(normalized.sourceMachineId, 'desktop-a');
  assert.equal(normalized.primary.usedPercent, 18);
  assert.equal(normalized.observedAt, '2026-08-13T10:00:01.000Z');
});

test('keeps state changes immediately but compresses unchanged heartbeats', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  const existing = [candidate('2026-08-13T10:00:00.000Z', 18)];

  const unchangedTooSoon = mergeUsageHistory(
    existing,
    [candidate('2026-08-13T10:20:00.000Z', 18)],
    { now, heartbeatMinutes: 60 }
  );
  assert.equal(unchangedTooSoon.length, 1);

  const stateChanged = mergeUsageHistory(
    existing,
    [candidate('2026-08-13T10:20:00.000Z', 19)],
    { now, heartbeatMinutes: 60 }
  );
  assert.equal(stateChanged.length, 2);

  const heartbeatDue = mergeUsageHistory(
    existing,
    [candidate('2026-08-13T11:01:00.000Z', 18)],
    { now, heartbeatMinutes: 60 }
  );
  assert.equal(heartbeatDue.length, 2);
});

test('retains a bounded, chronological history', () => {
  const existing = [
    candidate('2026-08-13T08:00:00.000Z', 10),
    candidate('2026-08-13T09:00:00.000Z', 11),
    candidate('2026-08-13T10:00:00.000Z', 12)
  ];
  const merged = mergeUsageHistory(
    existing,
    [candidate('2026-08-13T11:00:00.000Z', 13)],
    {
      now: new Date('2026-08-13T12:00:00.000Z'),
      maxSamples: 3
    }
  );

  assert.equal(merged.length, 3);
  assert.equal(merged[0].observedAt, '2026-08-13T09:00:00.000Z');
  assert.equal(merged[2].primary.usedPercent, 13);
});
