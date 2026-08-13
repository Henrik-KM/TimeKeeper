import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexAnalytics,
  computeCodexUsageIntervals,
  normalizeCodexSessions
} from '../../src/features/codex/analytics.mjs';

const RESET_ONE = '2026-08-20T00:00:00.000Z';
const RESET_TWO = '2026-08-27T00:00:00.000Z';

function sample(observedAt, usedPercent, resetsAt = RESET_ONE) {
  return {
    observedAt,
    primary: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes: 10080,
      resetsAt
    }
  };
}

function codexEntry({
  id,
  startTime,
  endTime,
  model,
  effort = 'high',
  wallSeconds = 3600,
  effectiveSeconds = 1800,
  projectId = 'project-1'
}) {
  return {
    id,
    externalId: id,
    source: 'Codex',
    projectId,
    startTime,
    endTime,
    elapsedSeconds: wallSeconds,
    duration: effectiveSeconds,
    focusFactor: effectiveSeconds / wallSeconds,
    codexModelBreakdown: [
      {
        role: 'parent',
        model,
        effort,
        wallSeconds,
        effectiveSeconds
      }
    ]
  };
}

test('usage intervals exclude quota resets and preserve positive deltas', () => {
  const result = computeCodexUsageIntervals([
    sample('2026-08-13T08:00:00.000Z', 10),
    sample('2026-08-13T09:00:00.000Z', 12),
    sample('2026-08-13T10:00:00.000Z', 1, RESET_TWO),
    sample('2026-08-13T11:00:00.000Z', 3, RESET_TWO)
  ]);

  assert.equal(result.intervals.length, 2);
  assert.equal(result.totalUsagePoints, 4);
  assert.equal(result.resetTransitions, 1);
});

test('normalizes imported TimeKeeper Codex entries and their model breakdown', () => {
  const sessions = normalizeCodexSessions(
    [
      codexEntry({
        id: 'codex-a',
        startTime: '2026-08-13T08:00:00.000Z',
        endTime: '2026-08-13T09:00:00.000Z',
        model: 'GPT-5.6-Luna',
        effectiveSeconds: 2700
      })
    ],
    [{ id: 'project-1', name: 'IFLAI' }]
  );

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].projectName, 'IFLAI');
  assert.equal(sessions[0].modelBreakdown[0].model, 'gpt-5.6-luna');
  assert.equal(sessions[0].modelBreakdown[0].effectiveSeconds, 2700);
});

test('ranks quota burn and effective-time yield by model', () => {
  const entries = [
    codexEntry({
      id: 'codex-a',
      startTime: '2026-08-13T08:00:00.000Z',
      endTime: '2026-08-13T09:00:00.000Z',
      model: 'model-a',
      effectiveSeconds: 1800
    }),
    codexEntry({
      id: 'codex-b',
      startTime: '2026-08-13T09:00:00.000Z',
      endTime: '2026-08-13T10:00:00.000Z',
      model: 'model-b',
      effectiveSeconds: 3600
    })
  ];
  const usageHistory = [
    sample('2026-08-13T08:00:00.000Z', 10),
    sample('2026-08-13T09:00:00.000Z', 13),
    sample('2026-08-13T10:00:00.000Z', 14)
  ];
  const analytics = buildCodexAnalytics({
    entries,
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory,
    rangeDays: 1,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  const modelA = analytics.byModel.find((row) => row.key === 'model-a');
  const modelB = analytics.byModel.find((row) => row.key === 'model-b');
  assert.equal(modelA.usagePoints, 3);
  assert.equal(modelB.usagePoints, 1);
  assert.equal(modelA.usagePerWallHour, 3);
  assert.equal(modelB.usagePerWallHour, 1);
  assert.equal(modelA.effectiveHoursPerUsagePoint, 0.1667);
  assert.equal(modelB.effectiveHoursPerUsagePoint, 1);
  assert.equal(analytics.overall.attributionRate, 1);
  assert.equal(analytics.measurementState, 'partial');
});

test('allocates a mixed-session quota delta by model active time', () => {
  const entry = {
    id: 'codex-mixed',
    externalId: 'codex-mixed',
    source: 'Codex',
    projectId: 'project-1',
    startTime: '2026-08-13T08:00:00.000Z',
    endTime: '2026-08-13T09:00:00.000Z',
    elapsedSeconds: 3600,
    duration: 2400,
    codexModelBreakdown: [
      {
        role: 'parent',
        model: 'model-a',
        effort: 'high',
        wallSeconds: 2700,
        effectiveSeconds: 1800
      },
      {
        role: 'subagent',
        model: 'model-b',
        effort: 'medium',
        wallSeconds: 900,
        effectiveSeconds: 600
      }
    ]
  };
  const analytics = buildCodexAnalytics({
    entries: [entry],
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory: [
      sample('2026-08-13T08:00:00.000Z', 10),
      sample('2026-08-13T09:00:00.000Z', 14)
    ],
    rangeDays: 1,
    now: new Date('2026-08-13T09:00:00.000Z')
  });

  const modelA = analytics.byModel.find((row) => row.key === 'model-a');
  const modelB = analytics.byModel.find((row) => row.key === 'model-b');
  assert.equal(modelA.usagePoints, 3);
  assert.equal(modelB.usagePoints, 1);
  assert.equal(analytics.overall.subagentWallShare, 0.25);
});

test('reports collecting state before two usage samples exist', () => {
  const analytics = buildCodexAnalytics({
    entries: [],
    usageHistory: [sample('2026-08-13T09:00:00.000Z', 10)],
    rangeDays: 7,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(analytics.measurementState, 'collecting');
  assert.equal(analytics.overall.totalUsagePoints, 0);
  assert.equal(analytics.coverage.sampleCount, 1);
});

test('keeps full-range time totals separate from measured quota denominators', () => {
  const entries = [
    codexEntry({
      id: 'codex-old',
      startTime: '2026-08-13T02:00:00.000Z',
      endTime: '2026-08-13T03:00:00.000Z',
      model: 'model-a',
      effectiveSeconds: 1800
    }),
    codexEntry({
      id: 'codex-measured',
      startTime: '2026-08-13T09:00:00.000Z',
      endTime: '2026-08-13T10:00:00.000Z',
      model: 'model-a',
      effectiveSeconds: 3600
    })
  ];
  const analytics = buildCodexAnalytics({
    entries,
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory: [
      sample('2026-08-13T09:00:00.000Z', 10),
      sample('2026-08-13T10:00:00.000Z', 12)
    ],
    rangeDays: 1,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  const model = analytics.byModel.find((row) => row.key === 'model-a');
  assert.equal(model.effectiveHours, 1.5);
  assert.equal(model.measuredEffectiveHours, 1);
  assert.equal(model.usagePoints, 2);
  assert.equal(model.effectiveHoursPerUsagePoint, 0.5);
  assert.equal(analytics.overall.totalEffectiveHours, 1.5);
  assert.equal(analytics.overall.measuredEffectiveHours, 1);
});
