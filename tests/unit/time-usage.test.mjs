import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeRollingPersonalHourlyRate,
  computeUnionSeconds,
  getEntryElapsedSeconds,
  groupTimeEntries,
  normalizeEntryTiming
} from '../../src/features/time-usage/core.mjs';

test('rolling personal hourly rate weights only eligible hours and projects', () => {
  const projects = [
    { id: 'low', hourlyRate: 80 },
    { id: 'high', hourlyRate: 180 },
    { id: 'unpaid', hourlyRate: 0 }
  ];
  const entries = [
    {
      projectId: 'low',
      startTime: '2026-07-10T08:00:00.000Z',
      duration: 3600
    },
    {
      projectId: 'high',
      manual: true,
      startTime: '2026-07-10T09:00:00.000Z',
      duration: 7200
    },
    {
      projectId: 'unpaid',
      startTime: '2026-07-10T11:00:00.000Z',
      duration: 14400
    },
    {
      projectId: 'high',
      source: 'codex',
      startTime: '2026-07-10T12:00:00.000Z',
      duration: 18000
    },
    {
      projectId: 'low',
      source: 'claude',
      startTime: '2026-07-10T13:00:00.000Z',
      duration: 10800
    },
    {
      projectId: 'high',
      startTime: '2026-06-20T08:00:00.000Z',
      duration: 7200
    },
    {
      projectId: 'high',
      startTime: '2026-07-10T14:00:00.000Z',
      duration: 3600,
      isRunning: true
    }
  ];

  const result = computeRollingPersonalHourlyRate(entries, projects, {
    start: new Date('2026-07-01T00:00:00.000Z'),
    endExclusive: new Date('2026-08-01T00:00:00.000Z')
  });

  assert.equal(result.hours, 3);
  assert.equal(result.totalEarned, 440);
  assert.equal(result.hourlyRate, 440 / 3);
});

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
