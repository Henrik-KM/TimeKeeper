import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWealthCsvImport,
  buildWealthGoalChartSeries,
  calculateHistoricalRegression,
  calculateObservedWealthPace,
  calculateWealthFreshness,
  calculateWealthGoalTrajectory,
  calculateWealthPeriodChange,
  findWealthSnapshotByDate,
  getDefaultWealthHistory,
  getFutureWealthSnapshots,
  getLatestWealthSnapshot,
  getWealthComposition,
  getWealthHistoryRange,
  normalizeWealthData,
  normalizeWealthEntry,
  parseOptionalWealthAmount,
  previewWealthCsvImport,
  resolveWealthSnapshotConflict,
  rollUpWealthBreakdown,
  validateWealthGoal
} from '../../src/features/wealth/core.mjs';

const NOW = new Date(2026, 8, 1, 12);

test('new wealth installations start with an empty history and no invented goal', () => {
  assert.deepEqual(getDefaultWealthHistory(), []);
  assert.deepEqual(normalizeWealthData({}).wealthGoal, {
    amount: null,
    date: ''
  });
});

test('wealth normalization preserves imported fields and rejects invalid optional amounts', () => {
  const entry = normalizeWealthEntry({
    id: 'wealth-1',
    date: '2026-08-31',
    amount: '100 000',
    note: 'Opening balance',
    importedField: 'keep'
  });

  assert.deepEqual(entry, {
    id: 'wealth-1',
    date: '2026-08-31',
    amount: 100000,
    note: 'Opening balance',
    importedField: 'keep'
  });
  assert.equal(parseOptionalWealthAmount(''), null);
  assert.equal(parseOptionalWealthAmount('not money'), null);
  assert.equal(parseOptionalWealthAmount('12abc'), null);
  assert.equal(parseOptionalWealthAmount('1 250,50'), 1250.5);
  assert.equal(parseOptionalWealthAmount('-1'), -1);
});

test('new goals require only a positive amount and a date after today', () => {
  assert.deepEqual(
    validateWealthGoal({
      amount: '0',
      date: '2027-08-31',
      now: NOW
    }),
    { ok: false, reason: 'amount' }
  );
  assert.deepEqual(
    validateWealthGoal({ amount: '250000', date: '', now: NOW }),
    { ok: false, reason: 'date' }
  );
  assert.deepEqual(
    validateWealthGoal({ amount: '250000', date: '2027-08-31', now: NOW }),
    { ok: true, goal: { amount: 250000, date: '2027-08-31' } }
  );
  assert.deepEqual(
    validateWealthGoal({ amount: '250000', date: '2026-09-01', now: NOW }),
    { ok: false, reason: 'date-past' }
  );
  assert.deepEqual(
    validateWealthGoal({ amount: '250000', date: '2027-02-30', now: NOW }),
    { ok: false, reason: 'date' }
  );
});

test('wealth migration is additive, preserves unknown fields, and does not rewrite v2 totals', () => {
  const source = {
    unrelated: { keep: true },
    wealthHistory: [
      {
        id: 'snapshot-1',
        date: '2026-08-31',
        amount: 1,
        note: 'Imported',
        importedField: 'keep',
        breakdown: [
          { accountId: 'cash', balance: '125000', sourceField: 'keep' },
          { accountId: 'loan', balance: 25000 }
        ]
      }
    ],
    wealthAccounts: [
      { id: 'cash', name: 'Cash', kind: 'asset', category: 'cash' },
      { id: 'loan', name: 'Loan', kind: 'liability', category: 'debt' }
    ],
    wealthGoal: {
      amount: '200000',
      date: '2027-08-31',
      monthlyContribution: '1000',
      scenarioAnnualRates: { base: '5', customRate: 0.2 },
      goalUnknown: 'keep'
    }
  };

  const migrated = normalizeWealthData(source);
  assert.equal(migrated.unrelated.keep, true);
  assert.equal(migrated.wealthSchemaVersion, 3);
  assert.equal(migrated.wealthHistory[0].amount, 100000);
  assert.equal(migrated.wealthHistory[0].importedField, 'keep');
  assert.equal(migrated.wealthHistory[0].breakdown[0].sourceField, 'keep');
  assert.equal(migrated.wealthGoal.monthlyContribution, '1000');
  assert.equal(migrated.wealthGoal.scenarioAnnualRates.base, '5');
  assert.equal(migrated.wealthGoal.scenarioAnnualRates.customRate, 0.2);
  assert.equal(migrated.wealthGoal.goalUnknown, 'keep');

  const stable = normalizeWealthData(migrated);
  assert.equal(stable.wealthHistory[0].amount, 100000);
  const v2 = normalizeWealthData({
    wealthSchemaVersion: 2,
    wealthAccounts: source.wealthAccounts,
    wealthHistory: [source.wealthHistory[0]]
  });
  assert.equal(v2.wealthHistory[0].amount, 1);
});

test('liability balances subtract from assets and archived referenced accounts remain usable', () => {
  const accounts = [
    { id: 'asset', name: 'Savings', kind: 'asset', category: 'cash' },
    {
      id: 'debt',
      name: 'Loan',
      kind: 'liability',
      category: 'debt',
      archived: true
    }
  ];
  const breakdown = [
    { accountId: 'asset', balance: 125000 },
    { accountId: 'debt', balance: 25000 }
  ];
  assert.deepEqual(rollUpWealthBreakdown(breakdown, accounts), {
    detailed: true,
    complete: true,
    assets: 125000,
    liabilities: 25000,
    netWorth: 100000,
    missingAccounts: [],
    rows: [
      { accountId: 'asset', balance: 125000 },
      { accountId: 'debt', balance: 25000 }
    ]
  });
  assert.equal(
    getWealthComposition({ amount: 100000, breakdown }, accounts).netWorth,
    100000
  );
});

test('same-date snapshots distinguish idempotent updates from conflicting replacements', () => {
  const history = [
    { id: 'existing', date: '2026-08-31', amount: 100, note: 'one' }
  ];
  assert.equal(
    resolveWealthSnapshotConflict(history, {
      date: '2026-08-31',
      amount: 100,
      note: 'one'
    }).action,
    'update'
  );
  assert.equal(
    resolveWealthSnapshotConflict(history, {
      date: '2026-08-31',
      amount: 200,
      note: 'two'
    }).action,
    'conflict'
  );
  assert.equal(
    resolveWealthSnapshotConflict(
      history,
      { date: '2026-08-31', amount: 200, note: 'two' },
      { replace: true }
    ).action,
    'replace'
  );
  assert.equal(
    resolveWealthSnapshotConflict(history, {
      id: 'another',
      date: '2026-08-31',
      amount: 100,
      note: 'one'
    }).action,
    'conflict'
  );
  assert.equal(findWealthSnapshotByDate(history, '2026-08-31').id, 'existing');
});

test('freshness becomes stale only after the configured threshold', () => {
  const history = [{ date: '2026-07-18', amount: 100 }];
  const day45 = calculateWealthFreshness(history, new Date(2026, 8, 1, 12), {
    staleAfterDays: 45
  });
  const day46 = calculateWealthFreshness(history, new Date(2026, 8, 2, 12), {
    staleAfterDays: 45
  });
  assert.equal(day45.status, 'fresh');
  assert.equal(day45.ageDays, 45);
  assert.equal(day46.status, 'stale');
  assert.equal(day46.ageDays, 46);
});

test('period change reports signed amount, percentage, and elapsed irregular days', () => {
  const change = calculateWealthPeriodChange([
    { date: '2026-01-31', amount: 100 },
    { date: '2026-03-15', amount: 125 }
  ]);
  assert.equal(change.available, true);
  assert.equal(change.amount, 25);
  assert.equal(change.percentage, 25);
  assert.equal(change.elapsedDays, 43);
});

test('observed pace uses the robust median of pairwise slopes and calendar-day intervals', () => {
  const pace = calculateObservedWealthPace(
    [
      { date: '2025-01-01', amount: 1000 },
      { date: '2025-04-11', amount: 2000 },
      { date: '2025-07-20', amount: 100000 },
      { date: '2025-10-28', amount: 4000 },
      { date: '2026-02-05', amount: 5000 },
      { date: '2026-05-16', amount: 6000 }
    ],
    { now: new Date(2026, 5, 1, 12) }
  );
  assert.equal(pace.available, true);
  assert.equal(pace.source, 'trailing-18-months');
  assert.equal(pace.snapshotCount, 6);
  assert.equal(pace.spanDays, 500);
  assert.equal(pace.slopePerDay, 10);
  assert.equal(pace.annualGrowthSek, 3652.425);
  assert.ok(Math.abs(pace.observedMonthlyGrowth - 304.36875) < 1e-9);
  assert.equal(pace.estimatedToday, 6160);
  assert.equal(pace.annualGrowthPercent, 3652.425 / 6000);
  assert.equal(pace.lowerSlopePerDay, 10);
  assert.equal(pace.upperSlopePerDay, 10);
});

test('observed pace handles irregular intervals and falls back to all history', () => {
  const irregular = calculateObservedWealthPace(
    [
      { date: '2025-01-01', amount: 0 },
      { date: '2025-02-15', amount: 450 },
      { date: '2025-04-01', amount: 900 }
    ],
    { now: new Date(2025, 3, 1, 12) }
  );
  assert.equal(irregular.available, true);
  assert.equal(irregular.spanDays, 90);
  assert.equal(irregular.slopePerDay, 10);

  const fallback = calculateObservedWealthPace(
    [
      { date: '2024-01-01', amount: 100 },
      { date: '2024-06-01', amount: 200 },
      { date: '2024-10-01', amount: 300 },
      { date: '2026-04-01', amount: 400 },
      { date: '2026-05-01', amount: 450 }
    ],
    { now: new Date(2026, 4, 15, 12) }
  );
  assert.equal(fallback.available, true);
  assert.equal(fallback.source, 'all-history-fallback');
  assert.equal(fallback.snapshotCount, 5);
});

test('future snapshots are excluded, same-date records are deduplicated, and ranges stay historical', () => {
  const history = [
    { id: 'old', date: '2024-01-01', amount: 50 },
    { id: 'first', date: '2026-01-01', amount: 100 },
    { id: 'duplicate', date: '2026-08-01', amount: 250 },
    { id: 'last', date: '2026-08-01', amount: 300 },
    { id: 'future', date: '2026-09-02', amount: 999 }
  ];
  const pace = calculateObservedWealthPace(history, { now: NOW });
  assert.equal(pace.latestSnapshot.id, 'last');
  assert.equal(pace.futureSnapshots.length, 1);
  assert.deepEqual(
    getFutureWealthSnapshots(history, NOW).map((row) => row.id),
    ['future']
  );
  assert.deepEqual(pace.duplicateDates, ['2026-08-01']);
  assert.equal(getLatestWealthSnapshot(history, { now: NOW }).id, 'last');
  assert.equal(getWealthHistoryRange(history, 'all', NOW).length, 3);
  assert.equal(getWealthHistoryRange(history, 'one-year', NOW).length, 2);
});

test('insufficient history still calculates the exact required pace without inventing a trajectory', () => {
  const history = [
    { date: '2026-07-01', amount: 100000 },
    { date: '2026-07-31', amount: 101000 },
    { date: '2026-08-30', amount: 102000 }
  ];
  const plan = calculateWealthGoalTrajectory(
    history,
    { amount: 200000, date: '2027-08-31' },
    { now: NOW }
  );
  assert.equal(plan.available, true);
  assert.equal(plan.status, 'insufficient-history');
  assert.equal(plan.paceAvailable, false);
  assert.equal(plan.projectedAtGoal, null);
  assert.equal(plan.additionalMonthlyPace, null);
  assert.ok(Number.isFinite(plan.requiredMonthlyGrowth));
  const series = buildWealthGoalChartSeries(
    history,
    { amount: 200000, date: '2027-08-31' },
    { now: NOW, range: 'one-year' }
  );
  assert.equal(
    series.datasets.find((dataset) => dataset.key === 'required').data.length,
    2
  );
  assert.equal(
    series.datasets.find((dataset) => dataset.key === 'goal').data[0].y,
    200000
  );
  assert.equal(series.xMax, new Date(2027, 7, 31).getTime());
});

test('goal trajectory derives yearly and monthly net-worth pace and shares chart endpoints', () => {
  const history = [
    { date: '2025-01-01', amount: 100000 },
    { date: '2025-05-01', amount: 104000 },
    { date: '2025-09-01', amount: 108000 },
    { date: '2026-01-01', amount: 112000 },
    { date: '2026-05-01', amount: 116000 }
  ];
  const goal = { amount: 150000, date: '2027-01-01' };
  const plan = calculateWealthGoalTrajectory(history, goal, { now: NOW });
  assert.equal(plan.status, 'shortfall');
  assert.equal(plan.goalDate, '2027-01-01');
  assert.equal(plan.annualGrowthSek, plan.observedPace.slopePerDay * 365.2425);
  assert.equal(plan.annualGrowthPercent, plan.annualGrowthSek / 116000);
  assert.equal(plan.observedPace.estimatedToday, plan.estimatedToday);
  assert.equal(
    plan.requiredAnnualGrowth,
    (150000 - plan.estimatedToday) / plan.yearsRemaining
  );
  assert.equal(plan.requiredMonthlyGrowth, plan.requiredAnnualGrowth / 12);
  assert.equal(
    plan.additionalMonthlyPace,
    plan.requiredMonthlyGrowth - plan.observedPace.observedMonthlyGrowth
  );

  const series = buildWealthGoalChartSeries(history, goal, {
    now: NOW,
    range: 'one-year'
  });
  assert.deepEqual(
    series.datasets.map((dataset) => dataset.key),
    ['recorded', 'projected', 'required', 'goal', 'pace-lower', 'pace-upper']
  );
  assert.equal(series.xMax, new Date(2027, 0, 1).getTime());
  assert.equal(
    series.datasets.find((dataset) => dataset.key === 'projected').data.at(-1)
      .y,
    plan.projectedAtGoal
  );
  assert.equal(
    series.datasets.find((dataset) => dataset.key === 'required').data.at(-1).y,
    plan.goalAmount
  );
  assert.equal(
    buildWealthGoalChartSeries(history, goal, {
      now: NOW,
      range: 'all'
    }).datasets.find((dataset) => dataset.key === 'goal').data[0].y,
    150000
  );
});

test('legacy scenario fields cannot change the data-derived projection', () => {
  const history = [
    { date: '2025-01-01', amount: 1000 },
    { date: '2025-05-01', amount: 1200 },
    { date: '2025-09-01', amount: 1400 }
  ];
  const base = calculateWealthGoalTrajectory(
    history,
    { amount: 3000, date: '2027-01-01' },
    { now: NOW }
  );
  const legacy = calculateWealthGoalTrajectory(
    history,
    {
      amount: 3000,
      date: '2027-01-01',
      monthlyContribution: 999999,
      scenarioAnnualRates: {
        conservative: -0.5,
        base: 1.5,
        optimistic: 4
      }
    },
    { now: NOW }
  );
  for (const key of [
    'estimatedToday',
    'annualGrowthSek',
    'projectedAtGoal',
    'requiredAnnualGrowth',
    'requiredMonthlyGrowth',
    'additionalMonthlyPace',
    'estimatedGoalDateAtCurrentPace'
  ]) {
    assert.equal(legacy[key], base[key], key);
  }
  assert.equal(legacy.goal.monthlyContribution, 999999);
  assert.equal(legacy.goal.scenarioAnnualRates.base, 1.5);
});

test('achieved, declining, negative, zero-denominator, and expired goals are explicit', () => {
  const achieved = calculateWealthGoalTrajectory(
    [
      { date: '2025-01-01', amount: 100 },
      { date: '2025-05-01', amount: 125 },
      { date: '2025-09-01', amount: 150 }
    ],
    { amount: 120, date: '2026-01-01' },
    { now: new Date(2025, 8, 15, 12) }
  );
  assert.equal(achieved.status, 'achieved');
  assert.equal(achieved.estimatedGoalDateAtCurrentPace, '2025-09-15');

  const declining = calculateWealthGoalTrajectory(
    [
      { date: '2025-01-01', amount: 1000 },
      { date: '2025-05-01', amount: 900 },
      { date: '2025-09-01', amount: 800 }
    ],
    { amount: 1200, date: '2026-01-01' },
    { now: new Date(2025, 8, 15, 12) }
  );
  assert.equal(declining.status, 'shortfall');
  assert.ok(declining.annualGrowthSek < 0);
  assert.equal(declining.estimatedGoalDateAtCurrentPace, null);

  const negative = calculateObservedWealthPace(
    [
      { date: '2025-01-01', amount: -300 },
      { date: '2025-05-01', amount: -200 },
      { date: '2025-09-01', amount: -100 }
    ],
    { now: new Date(2025, 8, 15, 12) }
  );
  assert.ok(Number.isFinite(negative.annualGrowthPercent));
  const zero = calculateObservedWealthPace(
    [
      { date: '2025-01-01', amount: 0 },
      { date: '2025-05-01', amount: 0 },
      { date: '2025-09-01', amount: 0 }
    ],
    { now: new Date(2025, 8, 15, 12) }
  );
  assert.equal(zero.annualGrowthPercent, null);

  const expired = calculateWealthGoalTrajectory(
    [{ date: '2025-08-01', amount: 100 }],
    { amount: 200, date: '2025-08-31' },
    { now: new Date(2025, 8, 1, 12) }
  );
  assert.equal(expired.status, 'expired');
  assert.equal(expired.reason, 'expired-goal');
  assert.equal(expired.goalAmount, 200);
  assert.equal(expired.projectedAtGoal, null);
});

test('historical diagnostics remain separate from the goal planner and pause only stale extrapolation', () => {
  const insufficient = calculateHistoricalRegression(
    [
      { date: '2026-08-01', amount: 100 },
      { date: '2026-08-15', amount: 110 }
    ],
    { now: new Date(2026, 7, 31) }
  );
  assert.equal(insufficient.available, false);
  assert.equal(insufficient.canProject, false);

  const stale = calculateHistoricalRegression(
    [
      { date: '2026-03-01', amount: 100 },
      { date: '2026-04-15', amount: 110 },
      { date: '2026-05-30', amount: 120 }
    ],
    { now: new Date(2026, 7, 31) }
  );
  assert.equal(stale.available, true);
  assert.equal(stale.canProject, false);
  assert.equal(stale.reason, 'stale');
});

test('CSV preview validates rows and apply skips existing dates unless replacement is explicit', () => {
  const csv = [
    'date,account,kind,category,balance,note',
    '2026-08-01,Cash,asset,cash,1000,Opening',
    '2026-08-01,Loan,liability,debt,200,Debt',
    '2026-08-02,Cash,asset,cash,1200,Later'
  ].join('\n');
  const preview = previewWealthCsvImport(csv, {
    accounts: [],
    history: [{ id: 'old', date: '2026-08-01', amount: 50 }]
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.validRows, 3);
  assert.deepEqual(preview.conflictDates, ['2026-08-01']);
  assert.equal(preview.newAccounts.length, 2);

  const skipped = applyWealthCsvImport(
    {
      other: 'keep',
      wealthHistory: [{ id: 'old', date: '2026-08-01', amount: 50 }]
    },
    preview
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skippedDates.includes('2026-08-01'), true);
  assert.equal(skipped.state.wealthHistory.length, 2);
  assert.deepEqual(
    skipped.state.wealthAccounts.map((account) => account.name),
    ['Cash']
  );
  assert.equal(
    skipped.state.wealthHistory.find((row) => row.date === '2026-08-01').amount,
    50
  );
  assert.equal(skipped.state.other, 'keep');

  const replaced = applyWealthCsvImport(
    { wealthHistory: [{ id: 'old', date: '2026-08-01', amount: 50 }] },
    preview,
    { replaceExistingDates: true }
  );
  assert.equal(replaced.ok, true);
  assert.equal(replaced.replacedDates.includes('2026-08-01'), true);
  assert.equal(replaced.state.wealthHistory.length, 2);
  assert.equal(
    replaced.state.wealthHistory.find((row) => row.date === '2026-08-01')
      .amount,
    800
  );
});

test('CSV preview reports incomplete dates, invalid money, and duplicate account dates', () => {
  const preview = previewWealthCsvImport(
    [
      'date,account,kind,category,balance,note',
      ',Cash,asset,cash,100,Missing date',
      '2026-08-01,Cash,asset,cash,nope,Invalid balance',
      '2026-08-02,Cash,asset,cash,100,First',
      '2026-08-02,Cash,asset,cash,110,Duplicate'
    ].join('\n')
  );
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.some((error) => error.code === 'incomplete-date'));
  assert.ok(preview.errors.some((error) => error.code === 'balance'));
  assert.ok(
    preview.errors.some((error) => error.code === 'duplicate-account-date')
  );
});
