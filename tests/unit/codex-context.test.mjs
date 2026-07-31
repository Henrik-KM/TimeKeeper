import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexDevelopmentContext } from '../../src/features/codex/context.mjs';

test('buildCodexDevelopmentContext exposes project usage without private domains', () => {
  const context = buildCodexDevelopmentContext(
    {
      updatedAt: '2026-07-30T08:00:00.000Z',
      projects: [
        {
          id: 'project-a',
          name: 'Actual Project',
          client: 'Actual Client',
          scheduleType: 'weekly',
          weeklyExpectedHours: 10,
          hourlyRate: 1500
        }
      ],
      entries: [
        {
          id: 'entry-a',
          projectId: 'project-a',
          description: 'Real workflow',
          startTime: '2026-07-29T10:00:00.000Z',
          endTime: '2026-07-29T11:00:00.000Z',
          duration: 5400,
          elapsedSeconds: 1800,
          focusFactor: 1.5,
          source: 'manual'
        }
      ],
      timerPresets: [{ id: 'preset-a' }],
      groceries: [{ name: 'Private purchase' }],
      wealthHistory: [{ amount: 123456 }],
      workouts: { entries: [{ name: 'Private workout' }] },
      codexIntegration: { token: 'secret-token' }
    },
    { now: new Date('2026-07-30T12:00:00.000Z') }
  );

  assert.equal(context.schema, 'timekeeper-codex-development-context/v1');
  assert.equal(context.coverage.totalProjects, 1);
  assert.equal(context.coverage.totalEntries, 1);
  assert.equal(context.coverage.sourceEntries, 1);
  assert.equal(context.coverage.rejectedEntries, 0);
  assert.equal(context.usage.windows['7d'].effectiveHours, 1.5);
  assert.equal(context.usage.windows['7d'].wallClockHours, 0.5);
  assert.equal(context.projects[0].name, 'Actual Project');
  assert.equal(context.projects[0].weeklyExpectedHours, 10);
  assert.equal(context.projects[0].usage['7d'].effectiveHours, 1.5);
  assert.equal(context.entries[0].description, 'Real workflow');
  assert.equal(context.entries[0].focusFactor, 1.5);
  assert.equal(context.entries[0].timestampIntervalSeconds, 3600);
  assert.doesNotMatch(JSON.stringify(context), /1500|Private|secret-token/);
});

test('buildCodexDevelopmentContext includes the complete entry history', () => {
  const entries = Array.from({ length: 4 }, (_, index) => ({
    id: `entry-${index}`,
    projectId: 'project-a',
    description: `Entry ${index}`,
    startTime:
      index === 3
        ? '2020-01-01T10:00:00.000Z'
        : `2026-07-${String(29 - index).padStart(2, '0')}T10:00:00.000Z`,
    endTime:
      index === 3
        ? '2020-01-01T11:00:00.000Z'
        : `2026-07-${String(29 - index).padStart(2, '0')}T11:00:00.000Z`,
    duration: 3600
  }));
  const context = buildCodexDevelopmentContext({
    projects: [{ id: 'project-a', name: 'Project' }],
    entries
  });

  assert.equal(context.usage.windows.all.entries, 4);
  assert.equal(context.entries.length, 4);
  assert.equal(context.coverage.entriesIncluded, 4);
  assert.equal(context.coverage.entriesTruncated, false);
  assert.equal(context.coverage.sourceEntries, 4);
  assert.equal(context.coverage.rejectedEntries, 0);
});

test('buildCodexDevelopmentContext preserves legacy start and end aliases', () => {
  const context = buildCodexDevelopmentContext({
    entries: [
      {
        id: 'legacy-entry',
        start: '2026-07-29T10:00:00.000Z',
        end: '2026-07-29T11:00:00.000Z',
        duration: 3600
      }
    ]
  });

  assert.equal(context.coverage.totalEntries, 1);
  assert.equal(context.entries[0].id, 'legacy-entry');
});

test('buildCodexDevelopmentContext advances active running totals from their last update', () => {
  const context = buildCodexDevelopmentContext(
    {
      entries: [
        {
          id: 'running-entry',
          startTime: '2026-07-30T10:00:00.000Z',
          endTime: null,
          isRunning: true,
          effectiveSeconds: 1800,
          elapsedSeconds: 1200,
          lastUpdateTime: '2026-07-30T11:00:00.000Z',
          focusFactor: 0.5
        }
      ]
    },
    { now: new Date('2026-07-30T12:00:00.000Z') }
  );

  assert.equal(context.entries[0].effectiveSeconds, 3600);
  assert.equal(context.entries[0].wallClockSeconds, 4800);
  assert.equal(context.entries[0].timestampIntervalSeconds, 7200);
});
