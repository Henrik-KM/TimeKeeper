import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeUnionSeconds,
  getEntryElapsedSeconds,
  groupTimeEntries,
  normalizeEntryTiming
} from '../../src/features/time-usage/core.mjs';

test('elapsed seconds remain independent from effective duration and focus', () => {
  const entry = {
    startTime: '2026-07-30T08:00:00.000Z',
    endTime: '2026-07-30T09:00:00.000Z',
    duration: 5400,
    focusFactor: 1.5,
    elapsedSeconds: 3000
  };
  assert.equal(getEntryElapsedSeconds(entry), 3000);
  assert.equal(normalizeEntryTiming(entry).elapsedSeconds, 3000);
});

test('legacy entries add elapsed seconds without changing effective duration', () => {
  const entry = normalizeEntryTiming({
    startTime: '2026-07-30T08:00:00.000Z',
    endTime: '2026-07-30T10:00:00.000Z',
    duration: 2700,
    focusFactor: 0.75
  });
  assert.equal(entry.elapsedSeconds, 7200);
  assert.equal(entry.duration, 2700);
});

test('Codex records roll up by project-day while timer episodes respect gaps', () => {
  const entries = [
    {
      id: 'c1',
      projectId: 'p1',
      source: 'codex',
      startTime: '2026-07-30T08:00:00.000Z',
      endTime: '2026-07-30T08:05:00.000Z',
      duration: 150,
      elapsedSeconds: 300
    },
    {
      id: 'c2',
      projectId: 'p1',
      source: 'codex',
      startTime: '2026-07-30T12:00:00.000Z',
      endTime: '2026-07-30T12:10:00.000Z',
      duration: 300,
      elapsedSeconds: 600
    },
    {
      id: 't1',
      projectId: 'p2',
      startTime: '2026-07-30T13:00:00.000Z',
      endTime: '2026-07-30T13:30:00.000Z',
      duration: 1800,
      elapsedSeconds: 1800
    },
    {
      id: 't2',
      projectId: 'p2',
      startTime: '2026-07-30T13:35:00.000Z',
      endTime: '2026-07-30T14:00:00.000Z',
      duration: 1500,
      elapsedSeconds: 1500
    }
  ];
  const groups = groupTimeEntries(entries);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.count).sort(), [2, 2]);
});

test('union time does not double-count simultaneous entries', () => {
  assert.equal(
    computeUnionSeconds([
      {
        startTime: '2026-07-30T08:00:00.000Z',
        endTime: '2026-07-30T09:00:00.000Z'
      },
      {
        startTime: '2026-07-30T08:30:00.000Z',
        endTime: '2026-07-30T09:30:00.000Z'
      }
    ]),
    5400
  );
});
