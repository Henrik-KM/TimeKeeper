import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWealthCsvImport,
  calculateGoalScenario,
  calculateHistoricalRegression,
  calculateWealthFreshness,
  calculateWealthPeriodChange,
  findWealthSnapshotByDate,
  getDefaultWealthHistory,
  getWealthComposition,
  normalizeWealthData,
  normalizeWealthEntry,
  parseOptionalWealthAmount,
  previewWealthCsvImport,
  resolveWealthSnapshotConflict,
  rollUpWealthBreakdown,
  validateWealthGoal
} from '../../src/features/wealth/core.mjs';

test('new wealth installations start with an empty history', () => {
  assert.deepEqual(getDefaultWealthHistory(), []);
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

test('wealth goals require a positive amount and validate an optional ISO date', () => {
  assert.deepEqual(validateWealthGoal('0', ''), {
    ok: false,
    reason: 'amount'
  });
  assert.deepEqual(validateWealthGoal('250000', '2027-08-31'), {
    ok: true,
    goal: {
      amount: 250000,
      date: '2027-08-31'
    }
  });
  assert.deepEqual(validateWealthGoal('250000', '2027-02-30'), {
    ok: false,
    reason: 'date'
  });
});

test('wealth migration is additive and preserves detailed fields and unknown data', () => {
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
  assert.equal(migrated.wealthSchemaVersion, 2);
  assert.equal(migrated.wealthHistory[0].amount, 100000);
  assert.equal(migrated.wealthHistory[0].importedField, 'keep');
  assert.equal(migrated.wealthHistory[0].breakdown[0].sourceField, 'keep');
  assert.equal(migrated.wealthGoal.monthlyContribution, 1000);
  assert.equal(migrated.wealthGoal.scenarioAnnualRates.base, 0.05);
  assert.equal(migrated.wealthGoal.scenarioAnnualRates.customRate, 0.2);
  assert.equal(migrated.wealthGoal.goalUnknown, 'keep');
  const stable = normalizeWealthData(migrated);
  assert.equal(stable.wealthHistory[0].amount, 100000);
  const current = normalizeWealthData({
    wealthSchemaVersion: 2,
    wealthAccounts: source.wealthAccounts,
    wealthHistory: [source.wealthHistory[0]]
  });
  assert.equal(current.wealthHistory[0].amount, 1);
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
  const history = [{ date: '2026-07-17', amount: 100 }];
  const day45 = calculateWealthFreshness(history, new Date(2026, 7, 31, 12), {
    staleAfterDays: 45
  });
  const day46 = calculateWealthFreshness(history, new Date(2026, 8, 1, 12), {
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

test('goal scenarios use monthly compounding and solve the required contribution', () => {
  const noGrowth = calculateGoalScenario({
    currentAmount: 1000,
    goalAmount: 2200,
    startDate: '2026-01-01',
    goalDate: '2027-01-01',
    monthlyContribution: 100,
    annualRate: 0
  });
  assert.equal(noGrowth.available, true);
  assert.equal(noGrowth.months, 12);
  assert.equal(noGrowth.projectedAmount, 2200);
  assert.equal(noGrowth.requiredMonthlyContribution, 100);

  const compounded = calculateGoalScenario({
    currentAmount: 1000,
    goalAmount: 2000,
    startDate: '2026-01-01',
    goalDate: '2027-01-01',
    monthlyContribution: 0,
    annualRate: 0.12
  });
  assert.equal(compounded.available, true);
  assert.ok(compounded.projectedAmount > 1100);
  assert.ok(compounded.projectedAmount < 1150);

  const monthEnd = calculateGoalScenario({
    currentAmount: 1000,
    goalAmount: 1100,
    startDate: '2026-01-31',
    goalDate: '2026-02-28',
    monthlyContribution: 100,
    annualRate: 0
  });
  assert.equal(monthEnd.months, 1);
});

test('historical trend diagnostics require enough history and pause projection when stale', () => {
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
      { date: '2026-05-01', amount: 100 },
      { date: '2026-05-15', amount: 110 },
      { date: '2026-06-01', amount: 120 }
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
