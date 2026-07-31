import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeUnionSeconds,
  getCapacityShareForDateRange,
  getEntryElapsedSeconds,
  getEntryIntegrityReasons,
  getWeekdayCapacityProfile,
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

test('long and cross-day entries require review until confirmed', () => {
  const entry = {
    startTime: '2026-07-29T20:00:00.000Z',
    endTime: '2026-07-30T09:00:00.000Z',
    elapsedSeconds: 13 * 3600,
    isRunning: false
  };
  assert.deepEqual(getEntryIntegrityReasons(entry), ['long', 'crosses-day']);
  assert.deepEqual(
    getEntryIntegrityReasons({
      ...entry,
      integrityReviewedAt: '2026-07-31T10:00:00.000Z'
    }),
    []
  );
  assert.deepEqual(
    getEntryIntegrityReasons({
      startTime: '2026-07-30T00:00:00.000Z',
      endTime: '2026-07-30T13:00:00.000Z',
      elapsedSeconds: 60,
      isRunning: false
    }),
    ['long']
  );
});

test('learned weekday capacity allocates less work to Friday', () => {
  const entries = [];
  for (let week = 0; week < 4; week += 1) {
    for (let weekday = 1; weekday <= 5; weekday += 1) {
      const start = new Date(Date.UTC(2026, 6, 6 + week * 7 + weekday - 1, 8));
      const hours = weekday === 5 ? 4 : 8;
      entries.push({
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + hours * 3600000).toISOString(),
        duration: hours * 3600,
        elapsedSeconds: hours * 3600,
        isRunning: false
      });
    }
  }
  const profile = getWeekdayCapacityProfile(entries, {
    now: new Date('2026-08-02T12:00:00.000Z')
  });
  assert.equal(profile.learned, true);
  assert.ok(profile.weights[5] < profile.weights[1]);
  const share = getCapacityShareForDateRange(
    new Date(2026, 6, 31, 8),
    new Date(2026, 7, 3),
    profile.weights
  );
  assert.equal(share.totalWeight, share.todayWeight);
});
