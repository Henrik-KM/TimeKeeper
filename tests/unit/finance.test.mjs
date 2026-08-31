// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateEnvelope,
  calculateFinanceSnapshot,
  calculatePeriodSpending,
  formatFinanceDateKey,
  getFinanceMigrationReview,
  getPeriodBounds,
  getRecurringDueDate,
  isRecurringPaymentDueInPeriod,
  mapPurchaseBudgetBucket,
  normalizeFinanceData,
  normalizeFinanceState,
  parseFinanceMoney,
  reconcileFinancePeriods
} from '../../src/features/finance/core.mjs';

const currentDate = new Date(2026, 7, 31, 12, 0, 0, 0);

test('finance purchase envelopes prefer explicit cadence, then frequency, then planning horizon', () => {
  assert.equal(
    mapPurchaseBudgetBucket({ budgetBucket: 'monthly', group: 'Soon' }),
    'monthly'
  );
  assert.equal(mapPurchaseBudgetBucket({ frequency: 'biannual' }), 'biannual');
  assert.equal(mapPurchaseBudgetBucket({ group: 'Later' }), 'monthly');
  assert.equal(mapPurchaseBudgetBucket({ group: 'Someday' }), 'biannual');
  assert.equal(mapPurchaseBudgetBucket({ frequency: 'Recurring' }), 'monthly');
  assert.equal(mapPurchaseBudgetBucket({ group: 'Soon' }), 'weekly');
});

test('finance normalization is additive and surfaces legacy recurring review items', () => {
  const normalized = normalizeFinanceData(
    {
      customFinanceField: { source: 'keep' },
      groceries: [
        {
          id: 'soon-1',
          name: 'Keyboard',
          group: 'Soon',
          estimate: '125,50',
          unknownPurchaseField: 'keep'
        },
        {
          id: 'legacy-recurring',
          name: 'Old subscription',
          frequency: 'Recurring',
          group: 'Later',
          estimate: '99'
        }
      ],
      groceryBudgetWeekly: 500,
      groceryBudgetMonthly: 2000,
      groceryBudgetBiYearly: 12000,
      groceryBudgetMonthlyCarry: -75
    },
    { now: currentDate }
  );

  assert.deepEqual(normalized.customFinanceField, { source: 'keep' });
  assert.equal(normalized.groceries[0].budgetBucket, 'weekly');
  assert.equal(normalized.groceries[0].estimate, 125.5);
  assert.equal(normalized.groceries[0].unknownPurchaseField, 'keep');
  assert.equal(normalized.groceries[1].budgetBucket, 'monthly');
  assert.equal(normalized.finance.version, 1);
  assert.equal(normalized.finance.budgets.weekly.baseBudget, 500);
  assert.equal(normalized.finance.budgets.monthly.openingCarry, -75);
  assert.deepEqual(normalized.finance.migrationReview, [
    {
      id: 'review-legacy-recurring',
      purchaseId: 'legacy-recurring',
      name: 'Old subscription',
      estimate: 99,
      status: 'open'
    }
  ]);
  assert.deepEqual(getFinanceMigrationReview(normalized.groceries), [
    { purchaseId: 'legacy-recurring', name: 'Old subscription', estimate: 99 }
  ]);

  const reassigned = normalizeFinanceData({
    groceries: [
      {
        id: 'reassigned',
        name: 'Old yearly item',
        frequency: 'Recurring',
        planningGroup: 'someday',
        migrationResolution: 'planning-horizon'
      }
    ]
  });
  assert.equal(reassigned.groceries[0].budgetBucket, 'biannual');
});

test('finance monetary parsing rejects invalid values without turning them into zero spending', () => {
  assert.equal(parseFinanceMoney('1 250,50'), 1250.5);
  assert.equal(parseFinanceMoney('-1'), null);
  assert.equal(parseFinanceMoney('-1', { allowNegative: true }), -1);
  assert.equal(parseFinanceMoney('not money'), null);

  const period = getPeriodBounds('weekly', currentDate);
  const spending = calculatePeriodSpending({
    bucket: 'weekly',
    period,
    purchases: [
      { id: 'valid', archived: true, cost: '40', purchasedDate: '2026-08-31' },
      { id: 'missing-date', archived: true, cost: '100' },
      {
        id: 'invalid-cost',
        archived: true,
        cost: 'not money',
        originalCost: 90,
        purchasedDate: '2026-08-31'
      }
    ]
  });

  assert.equal(spending.spending, 40);
});

test('finance periods use Monday weeks, calendar months, and January-June or July-December halves', () => {
  const monday = getPeriodBounds('weekly', new Date(2026, 7, 31, 12));
  assert.equal(monday.periodKey, '2026-08-31');
  assert.equal(formatFinanceDateKey(monday.end), '2026-09-07');

  const february = getPeriodBounds('monthly', new Date(2026, 1, 28, 12));
  assert.equal(february.periodKey, '2026-02-01');
  assert.equal(formatFinanceDateKey(february.end), '2026-03-01');

  const secondHalf = getPeriodBounds('biannual', new Date(2026, 7, 31, 12));
  assert.equal(secondHalf.periodKey, '2026-07-01');
  assert.equal(formatFinanceDateKey(secondHalf.end), '2027-01-01');
});

test('signed rollover closes skipped periods and does not rewrite immutable closure history', () => {
  const state = normalizeFinanceState(
    {
      version: 1,
      budgets: {
        monthly: {
          baseBudget: 200,
          openingCarry: 0,
          currentPeriodKey: '2026-07-01'
        }
      }
    },
    {},
    currentDate
  );
  const purchases = [
    {
      id: 'july',
      archived: true,
      cost: 250,
      purchasedDate: '2026-07-10',
      budgetBucket: 'monthly'
    },
    {
      id: 'september',
      archived: true,
      cost: 25,
      purchasedDate: '2026-09-10',
      budgetBucket: 'monthly'
    }
  ];

  const reconciled = reconcileFinancePeriods({
    state,
    purchases,
    now: new Date(2026, 9, 15, 12)
  });
  const monthlyClosures = reconciled.periodClosures.filter(
    (closure) => closure.bucket === 'monthly'
  );

  assert.deepEqual(
    monthlyClosures.map((closure) => [
      closure.periodKey,
      closure.spending,
      closure.closingBalance
    ]),
    [
      ['2026-07-01', 250, -50],
      ['2026-08-01', 0, 150],
      ['2026-09-01', 25, 325]
    ]
  );
  assert.equal(reconciled.budgets.monthly.currentPeriodKey, '2026-10-01');
  assert.equal(reconciled.budgets.monthly.openingCarry, 325);

  const changedBudget = {
    ...reconciled,
    budgets: {
      ...reconciled.budgets,
      monthly: { ...reconciled.budgets.monthly, baseBudget: 999 }
    }
  };
  const afterEdit = reconcileFinancePeriods({
    state: changedBudget,
    purchases,
    now: new Date(2026, 9, 15, 12)
  });
  const julyClosure = afterEdit.periodClosures.find(
    (closure) =>
      closure.bucket === 'monthly' && closure.periodKey === '2026-07-01'
  );
  assert.equal(julyClosure.baseBudget, 200);
  assert.equal(julyClosure.closingBalance, -50);
});

test('recurring payments clamp month-end due days and respect inclusive effective and end dates', () => {
  const february = getPeriodBounds('monthly', new Date(2026, 1, 10, 12));
  const payment = {
    id: 'month-end',
    name: 'Month end',
    amount: 80,
    dueDay: 31,
    effectiveDate: '2026-02-28',
    endDate: '2026-02-28',
    active: true
  };

  const dueDate = getRecurringDueDate(payment, 2026, 1);
  assert.equal(dueDate.getDate(), 28);
  assert.equal(isRecurringPaymentDueInPeriod(payment, february), true);
  assert.equal(
    isRecurringPaymentDueInPeriod(
      { ...payment, endDate: '2026-02-27' },
      february
    ),
    false
  );
  assert.equal(
    isRecurringPaymentDueInPeriod({ ...payment, active: false }, february),
    false
  );

  const snapshot = calculateFinanceSnapshot({
    state: normalizeFinanceState(
      { budgets: { monthly: { baseBudget: 100, openingCarry: 0 } } },
      {},
      currentDate
    ),
    recurringPayments: [payment],
    now: new Date(2026, 1, 10, 12)
  });
  assert.equal(snapshot.monthly.recurringSpending, 80);
  assert.equal(snapshot.monthly.spending, 80);
});

test('envelopes retain negative carry, allow zero budgets, and keep finance independent of workout state', () => {
  const deficit = calculateEnvelope({
    bucket: 'weekly',
    baseBudget: 0,
    openingCarry: -50,
    spending: 0,
    now: currentDate,
    period: getPeriodBounds('weekly', currentDate)
  });
  assert.equal(deficit.envelope, -50);
  assert.equal(deficit.remaining, -50);
  assert.equal(deficit.status, 'over');

  const financeOnly = calculateFinanceSnapshot({
    state: normalizeFinanceState(
      {
        budgets: {
          weekly: { baseBudget: 100, openingCarry: 0 },
          monthly: { baseBudget: 400, openingCarry: 0 },
          biannual: { baseBudget: 1000, openingCarry: 0 }
        }
      },
      {},
      currentDate
    ),
    purchases: [],
    recurringPayments: [],
    now: currentDate
  });

  assert.equal(financeOnly.weekly.envelope, 100);
  assert.equal(financeOnly.monthly.envelope, 400);
  assert.equal(financeOnly.biannual.envelope, 1000);
});
