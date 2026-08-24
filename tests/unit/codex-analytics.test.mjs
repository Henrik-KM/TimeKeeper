import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexAnalytics,
  buildCodexSourceAverages,
  computeCodexQuotaProgress,
  computeCodexUsageIntervals,
  normalizeCodexSessions,
  rankCodexModelPerformance,
  selectTopCodexModelPerformance
} from '../../src/features/codex/analytics.mjs';
import {
  buildCsv,
  buildTrendCsv
} from '../../src/features/codex/analysis-page.mjs';

const RESET_ONE = '2026-08-20T00:00:00.000Z';
const RESET_TWO = '2026-08-27T00:00:00.000Z';

test('splits current week and month effective hours between me and Codex', () => {
  const summary = buildCodexSourceAverages(
    [
      {
        id: 'me-week-a',
        startTime: '2026-08-10T08:00:00.000Z',
        duration: 2 * 60 * 60
      },
      {
        id: 'me-week-b',
        startTime: '2026-08-13T08:00:00.000Z',
        duration: 60 * 60
      },
      {
        id: 'codex-week',
        source: 'Codex',
        startTime: '2026-08-11T08:00:00.000Z',
        duration: 4 * 60 * 60
      },
      {
        id: 'me-month',
        startTime: '2026-08-01T08:00:00.000Z',
        duration: 5 * 60 * 60
      },
      {
        id: 'codex-month',
        source: 'Codex',
        startTime: '2026-08-02T08:00:00.000Z',
        duration: 6 * 60 * 60
      },
      {
        id: 'outside-period',
        startTime: '2026-07-31T08:00:00.000Z',
        duration: 20 * 60 * 60
      }
    ],
    new Date('2026-08-14T12:00:00.000Z')
  );

  assert.equal(summary.week.daysElapsed, 5);
  assert.equal(summary.week.meEffectiveSeconds, 3 * 60 * 60);
  assert.equal(summary.week.codexEffectiveSeconds, 4 * 60 * 60);
  assert.equal(summary.week.meAverageHoursPerDay, 0.6);
  assert.equal(summary.week.codexAverageHoursPerDay, 0.8);
  assert.equal(summary.month.daysElapsed, 14);
  assert.equal(summary.month.meEffectiveSeconds, 8 * 60 * 60);
  assert.equal(summary.month.codexEffectiveSeconds, 10 * 60 * 60);
});

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

test('computes quota use and expected use for the current weekly window', () => {
  const result = computeCodexQuotaProgress(
    {
      remainingPercent: 40,
      windowMinutes: 10080,
      resetsAt: '2026-08-20T12:00:00.000Z'
    },
    new Date('2026-08-17T12:00:00.000Z')
  );

  assert.deepEqual(result, {
    usedPercent: 60,
    remainingPercent: 40,
    expectedUsedPercent: 57.1,
    expectedRemainingPercent: 42.9,
    windowStartAt: '2026-08-13T12:00:00.000Z',
    resetsAt: '2026-08-20T12:00:00.000Z'
  });
});

test('does not compare quota pacing after the reset or without a window', () => {
  assert.equal(
    computeCodexQuotaProgress(
      {
        usedPercent: 20,
        windowMinutes: 10080,
        resetsAt: '2026-08-20T12:00:00.000Z'
      },
      new Date('2026-08-20T12:00:00.000Z')
    ),
    null
  );
  assert.equal(
    computeCodexQuotaProgress(
      { usedPercent: 20, resetsAt: '2026-08-20T12:00:00.000Z' },
      new Date('2026-08-17T12:00:00.000Z')
    ),
    null
  );
});

function codexEntry({
  id,
  startTime,
  endTime,
  model,
  effort = 'high',
  wallSeconds = 3600,
  effectiveSeconds = 1800,
  projectId = 'project-1',
  fastMode = false
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
        fastMode,
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
  assert.equal(sessions[0].modelBreakdown[0].fastMode, 'off');
});

test('tracks model, reasoning, and Fast mode trends with sample warnings', () => {
  const entries = [
    codexEntry({
      id: 'codex-fast-off',
      startTime: '2026-08-13T08:00:00.000Z',
      endTime: '2026-08-13T09:00:00.000Z',
      model: 'gpt-5.6-sol',
      effort: 'high',
      wallSeconds: 3600,
      effectiveSeconds: 1800,
      fastMode: false
    }),
    codexEntry({
      id: 'codex-fast-on',
      startTime: '2026-08-13T09:00:00.000Z',
      endTime: '2026-08-13T10:00:00.000Z',
      model: 'gpt-5.6-sol',
      effort: 'high',
      wallSeconds: 3600,
      effectiveSeconds: 2160,
      fastMode: true
    })
  ];
  const analytics = buildCodexAnalytics({
    entries,
    projects: [{ id: 'project-1', name: 'IFLAI' }],
    usageHistory: [
      sample('2026-08-13T08:00:00.000Z', 10),
      sample('2026-08-13T09:00:00.000Z', 12),
      sample('2026-08-13T10:00:00.000Z', 15)
    ],
    rangeDays: 1,
    now: new Date('2026-08-13T10:00:00.000Z')
  });
  const trendRows = analytics.modelTrends.filter(
    (row) => row.model === 'gpt-5.6-sol'
  );

  assert.deepEqual(trendRows.map((row) => row.fastMode).sort(), ['off', 'on']);
  assert.equal(
    trendRows.reduce((total, row) => total + row.usagePoints, 0),
    analytics.overall.attributedUsagePoints
  );
  assert.equal(
    trendRows.reduce((total, row) => total + row.effectiveHours, 0),
    analytics.overall.totalEffectiveHours
  );
  assert.ok(trendRows.every((row) => row.sampleWarning));
  assert.match(buildTrendCsv(analytics, trendRows), /fast_mode/);
  assert.match(buildTrendCsv(analytics, trendRows), /gpt-5\.6-sol/);
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
  assert.equal(modelA.usagePerEffectiveHour, 6);
  assert.equal(modelB.usagePerEffectiveHour, 1);
  assert.equal(modelA.effectiveHoursPerUsagePoint, 0.1667);
  assert.equal(modelB.effectiveHoursPerUsagePoint, 1);
  assert.equal(
    analytics.byModel.reduce((total, row) => total + row.usagePoints, 0),
    analytics.overall.attributedUsagePoints
  );
  assert.equal(analytics.overall.attributionRate, 1);
  assert.equal(analytics.overall.usagePerEffectiveHour, 2.6667);
  assert.equal(analytics.measurementState, 'partial');
});

test('selects the lowest measured model and reasoning usage rate after the cutoff', () => {
  const rows = [
    {
      model: 'model-small',
      effort: 'high',
      usagePoints: 0.5,
      measuredEffectiveHours: 0.4,
      usagePerEffectiveHour: 0.1,
      effectiveHours: 0.4,
      label: 'model-small · high'
    },
    {
      model: 'model-best',
      effort: 'medium',
      usagePoints: 1,
      measuredEffectiveHours: 0.5,
      usagePerEffectiveHour: 2,
      effectiveHours: 0.5,
      label: 'model-best · medium'
    },
    {
      model: 'model-worse',
      effort: 'high',
      usagePoints: 4,
      measuredEffectiveHours: 1,
      usagePerEffectiveHour: 4,
      effectiveHours: 1,
      label: 'model-worse · high'
    }
  ];

  assert.equal(
    selectTopCodexModelPerformance(rows)?.label,
    'model-best · medium'
  );
  assert.equal(
    selectTopCodexModelPerformance(rows, {
      minimumMeasuredEffectiveHours: 0.6
    }),
    rows[2]
  );
  assert.deepEqual(
    rankCodexModelPerformance(rows).map((row) => row.label),
    ['model-best · medium', 'model-worse · high']
  );
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
    fastMode: false,
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
