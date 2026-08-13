import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexAnalytics,
  computeCodexUsageIntervals,
  normalizeCodexSessions
} from '../../src/features/codex/analytics.mjs';
import { buildCsv } from '../../src/features/codex/analysis-page.mjs';

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

function sampleWithSecondary(observedAt, primaryUsed, secondaryUsed) {
  return {
    ...sample(observedAt, primaryUsed),
    secondary: {
      usedPercent: secondaryUsed,
      remainingPercent: 100 - secondaryUsed,
      windowMinutes: 1440,
      resetsAt: '2026-08-14T00:00:00.000Z'
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

test('tolerates small reset timestamp jitter without creating false resets', () => {
  const result = computeCodexUsageIntervals([
    sample('2026-08-13T08:00:00.000Z', 10, '2026-08-20T00:00:00.000Z'),
    sample('2026-08-13T09:00:00.000Z', 12, '2026-08-20T00:00:04.000Z'),
    sample('2026-08-13T10:00:00.000Z', 1, RESET_TWO),
    sample('2026-08-13T11:00:00.000Z', 3, '2026-08-27T00:00:04.000Z')
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
  assert.equal(
    analytics.byModel.reduce((total, row) => total + row.usagePoints, 0),
    analytics.overall.attributedUsagePoints
  );
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
  assert.equal(
    analytics.byModel.reduce((total, row) => total + row.usagePoints, 0),
    analytics.overall.attributedUsagePoints
  );
});

test('supports secondary quota windows through the same attribution path', () => {
  const analytics = buildCodexAnalytics({
    entries: [
      codexEntry({
        id: 'codex-secondary',
        startTime: '2026-08-13T08:00:00.000Z',
        endTime: '2026-08-13T10:00:00.000Z',
        model: 'model-secondary'
      })
    ],
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory: [
      sampleWithSecondary('2026-08-13T08:00:00.000Z', 10, 20),
      sampleWithSecondary('2026-08-13T09:00:00.000Z', 11, 24),
      sampleWithSecondary('2026-08-13T10:00:00.000Z', 12, 25)
    ],
    rangeDays: 1,
    windowKey: 'secondary',
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(analytics.windowKey, 'secondary');
  assert.equal(analytics.overall.totalUsagePoints, 5);
  assert.equal(analytics.coverage.sampleCount, 3);
});

test('returns collecting state when the requested window has no history', () => {
  const analytics = buildCodexAnalytics({
    entries: [
      codexEntry({
        id: 'codex-no-secondary',
        startTime: '2026-08-13T09:00:00.000Z',
        endTime: '2026-08-13T10:00:00.000Z',
        model: 'model-a'
      })
    ],
    usageHistory: [sample('2026-08-13T09:00:00.000Z', 10)],
    rangeDays: 1,
    windowKey: 'secondary',
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(analytics.measurementState, 'collecting');
  assert.equal(analytics.coverage.sampleCount, 0);
  assert.equal(analytics.overall.totalUsagePoints, 0);
});

test('conserves quota allocation across concurrent sessions', () => {
  const analytics = buildCodexAnalytics({
    entries: [
      codexEntry({
        id: 'codex-concurrent-a',
        startTime: '2026-08-13T08:00:00.000Z',
        endTime: '2026-08-13T09:00:00.000Z',
        model: 'model-a'
      }),
      codexEntry({
        id: 'codex-concurrent-b',
        startTime: '2026-08-13T08:00:00.000Z',
        endTime: '2026-08-13T09:00:00.000Z',
        model: 'model-b'
      })
    ],
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory: [
      sample('2026-08-13T08:00:00.000Z', 10),
      sample('2026-08-13T09:00:00.000Z', 14)
    ],
    rangeDays: 1,
    now: new Date('2026-08-13T09:00:00.000Z')
  });

  assert.equal(
    analytics.byModel.find((row) => row.key === 'model-a').usagePoints,
    2
  );
  assert.equal(
    analytics.byModel.find((row) => row.key === 'model-b').usagePoints,
    2
  );
  assert.equal(analytics.overall.attributedUsagePoints, 4);
});

test('clips sessions at selected range boundaries without changing quota totals', () => {
  const analytics = buildCodexAnalytics({
    entries: [
      codexEntry({
        id: 'codex-clipped',
        startTime: '2026-08-13T08:00:00.000Z',
        endTime: '2026-08-13T10:00:00.000Z',
        model: 'model-clipped'
      })
    ],
    usageHistory: [
      sample('2026-08-13T09:00:00.000Z', 10),
      sample('2026-08-13T10:00:00.000Z', 11)
    ],
    rangeDays: 1 / 24,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(analytics.overall.totalWallHours, 0.5);
  assert.equal(analytics.overall.totalEffectiveHours, 0.25);
  assert.equal(analytics.overall.measuredEffectiveHours, 0.25);
  assert.equal(analytics.overall.totalUsagePoints, 1);
});

test('CSV export includes the selected window and measured columns', () => {
  const csv = buildCsv({ windowKey: 'secondary' }, [
    {
      label: 'model-a',
      effectiveHours: 1,
      wallHours: 2,
      measuredWallHours: 1.5,
      measuredEffectiveHours: 0.75,
      usagePoints: 3,
      usagePerWallHour: 2,
      effectiveHoursPerUsagePoint: 0.25,
      focusConversion: 0.5,
      sessions: 2,
      confidence: 'medium'
    }
  ]);

  assert.match(csv, /"window_key","model"/);
  assert.match(csv, /secondary/);
  assert.match(csv, /measured_effective_hours/);
  assert.match(csv, /model-a/);
});

test('reports collecting state before two usage samples exist', () => {
  const entry = codexEntry({
    id: 'codex-unmeasured',
    startTime: '2026-08-13T09:00:00.000Z',
    endTime: '2026-08-13T10:00:00.000Z',
    model: 'model-a'
  });
  const analytics = buildCodexAnalytics({
    entries: [entry],
    usageHistory: [sample('2026-08-13T09:00:00.000Z', 10)],
    rangeDays: 7,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(analytics.measurementState, 'collecting');
  assert.equal(analytics.overall.totalUsagePoints, 0);
  assert.equal(analytics.coverage.sampleCount, 1);
  assert.equal(analytics.overall.measuredEffectiveHours, 0);
  assert.equal(analytics.coverage.measurementHours, 0);
});

test('ignores zero-duration placeholder model rows', () => {
  const entry = codexEntry({
    id: 'codex-placeholder',
    startTime: '2026-08-13T08:00:00.000Z',
    endTime: '2026-08-13T09:00:00.000Z',
    model: 'model-a'
  });
  entry.codexModelBreakdown.unshift({
    role: 'parent',
    model: 'unknown',
    effort: 'unknown',
    factor: 0.4,
    wallSeconds: 0,
    effectiveSeconds: 0
  });

  const analytics = buildCodexAnalytics({
    entries: [entry],
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    rangeDays: 1,
    now: new Date('2026-08-13T10:00:00.000Z')
  });

  assert.equal(
    analytics.byModel.some((row) => row.key === 'unknown'),
    false
  );
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
