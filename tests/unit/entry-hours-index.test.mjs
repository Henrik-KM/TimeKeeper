import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntryHoursIndex,
  getProjectPlannedHoursForPeriod,
  getProjectPlanningSnapshot,
  sumEntryHours
} from '../../src/shared/runtime-helpers.mjs';

test('indexed history matches range scans across unsorted and duplicate timestamps', () => {
  const entries = Array.from({ length: 1200 }, (_, index) => ({
    startTime: new Date(
      Date.UTC(2026, 8, 1) + ((index * 37) % 90) * 86400000
    ).toISOString(),
    duration: index % 19 === 0 ? 0 : index * 3.25
  }));
  entries.push({ startTime: 'invalid', duration: 3600 });
  const original = JSON.stringify(entries);
  const sumHours = createEntryHoursIndex(entries);
  for (let first = 0; first < 95; first += 5) {
    for (let last = first; last < 100; last += 7) {
      const from = new Date(Date.UTC(2026, 8, first));
      const to = new Date(Date.UTC(2026, 8, last));
      assert.ok(
        Math.abs(sumHours(from, to) - sumEntryHours(entries, from, to)) < 1e-8
      );
    }
  }
  assert.equal(sumHours(), sumEntryHours(entries));
  assert.equal(sumHours(new Date('2027-01-01')), 0);
  assert.equal(sumHours(null, new Date('2026-01-01')), 0);
  assert.equal(JSON.stringify(entries), original);
});

test('indexed ranges preserve inclusive starts, exclusive ends and local DST days', () => {
  const entries = [
    { startTime: '2026-10-25T00:00:00+02:00', duration: 3600 },
    { startTime: '2026-10-25T02:30:00+02:00', duration: 1800 },
    { startTime: '2026-10-25T02:30:00+01:00', duration: 900 },
    { startTime: '2026-10-26T00:00:00+01:00', duration: 7200 }
  ];
  const sumHours = createEntryHoursIndex(entries);
  const from = new Date('2026-10-25T00:00:00+02:00');
  const to = new Date('2026-10-26T00:00:00+01:00');
  assert.equal(sumHours(from, to), 1.75);
  assert.equal(sumHours(to, from), 0);
  assert.equal(sumHours(from, from), 0);
  assert.equal(createEntryHoursIndex([])(), 0);
});

test('indexed planning agrees with ordinary planning and refreshes after history edits', () => {
  const entries = [
    { startTime: '2026-11-02T09:00:00', duration: 3600 },
    { startTime: '2026-11-09T09:00:00', duration: 7200 }
  ];
  const snapshot = new Date('2026-11-09T00:00:00');
  const periodEnd = new Date('2026-11-16T00:00:00');
  for (const project of [
    { startDate: '2026-11-01', deadline: '2026-12-31', budgetHours: 100 },
    { startDate: '2026-11-01', scheduleType: 'weekly', weeklyExpectedHours: 20 }
  ]) {
    const sumHours = createEntryHoursIndex(entries);
    assert.deepEqual(
      getProjectPlanningSnapshot(project, entries, snapshot, sumHours),
      getProjectPlanningSnapshot(project, entries, snapshot)
    );
    assert.equal(
      getProjectPlannedHoursForPeriod(
        project,
        entries,
        snapshot,
        periodEnd,
        sumHours
      ),
      getProjectPlannedHoursForPeriod(project, entries, snapshot, periodEnd)
    );
  }
  const previous = createEntryHoursIndex(entries);
  entries[0].duration = 18000;
  entries.push({ startTime: '2026-11-10T09:00:00', duration: 3600 });
  assert.equal(previous(), 3);
  assert.equal(createEntryHoursIndex(entries)(), 8);
  assert.equal(sumEntryHours(entries), 8);
});

test('legacy nonnumeric durations retain the existing summation behavior', () => {
  const entries = [{ startTime: '2026-11-01T09:00:00', duration: '3600' }];
  assert.equal(createEntryHoursIndex(entries)(), sumEntryHours(entries));
});
