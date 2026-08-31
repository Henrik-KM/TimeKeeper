// @ts-nocheck

import { uuid } from '../../shared/id.mjs';

export const FINANCE_SCHEMA_VERSION = 1;
export const FINANCE_BUCKETS = ['weekly', 'monthly', 'biannual'];
export const FINANCE_PLANNING_GROUPS = [
  'soon',
  'later',
  'recurring',
  'someday'
];

export const FINANCE_BUCKET_LABELS = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  biannual: 'Six-month'
};

export const FINANCE_PLANNING_GROUP_LABELS = {
  soon: 'Soon',
  later: 'Later',
  recurring: 'Recurring review',
  someday: 'Someday'
};

const DEFAULT_BUDGETS = {
  weekly: 1000,
  monthly: 4000,
  biannual: 20000
};

const LEGACY_BUCKET_FIELDS = {
  weekly: {
    budget: 'groceryBudgetWeekly',
    carry: 'groceryBudgetWeeklyCarry',
    baseline: 'groceryBudgetWeeklyCarryBaseline'
  },
  monthly: {
    budget: 'groceryBudgetMonthly',
    carry: 'groceryBudgetMonthlyCarry',
    baseline: 'groceryBudgetMonthlyCarryBaseline'
  },
  biannual: {
    budget: 'groceryBudgetBiYearly',
    carry: 'groceryBudgetBiYearlyCarry',
    baseline: 'groceryBudgetBiYearlyCarryBaseline'
  }
};

const FREQUENCY_BUCKETS = {
  weekly: 'weekly',
  monthly: 'monthly',
  biannual: 'biannual',
  'six-month': 'biannual',
  six_month: 'biannual',
  'six months': 'biannual',
  sixmonth: 'biannual',
  'six-monthly': 'biannual',
  semiannual: 'biannual',
  'bi-yearly': 'biannual',
  biyearly: 'biannual',
  'half-year': 'biannual',
  halfyear: 'biannual',
  recurring: 'monthly'
};

const GROUP_BUCKETS = {
  soon: 'weekly',
  later: 'monthly',
  someday: 'biannual',
  recurring: 'monthly'
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneDate(value) {
  return new Date(value.getTime());
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function formatFinanceDateKey(value) {
  const date = toLocalDate(value);
  if (!date) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function toLocalDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : cloneDate(value);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [year, month, day] = value.trim().split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    date.setHours(0, 0, 0, 0);
    return date;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function startOfDay(value) {
  const date = toLocalDate(value) || new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseStrictNumber(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\s/g, '');
  if (!value || !/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) {
    return null;
  }
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFinanceMoney(raw, { allowNegative = false } = {}) {
  const parsed = parseStrictNumber(raw);
  if (parsed === null || (!allowNegative && parsed < 0)) return null;
  return parsed;
}

function normalizeNonNegativeMoney(raw, fallback = 0) {
  const value = parseFinanceMoney(raw);
  return value === null ? fallback : value;
}

function normalizeSignedMoney(raw, fallback = 0) {
  const value = parseFinanceMoney(raw, { allowNegative: true });
  return value === null ? fallback : value;
}

export function normalizeBudgetBucket(value, fallback = 'weekly') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (FREQUENCY_BUCKETS[normalized]) return FREQUENCY_BUCKETS[normalized];
  if (fallback === '' || fallback === null) return null;
  return FINANCE_BUCKETS.includes(fallback) ? fallback : 'weekly';
}

export function normalizePlanningGroup(value, fallback = 'soon') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (FINANCE_PLANNING_GROUPS.includes(normalized)) return normalized;
  if (fallback === '' || fallback === null) return null;
  return FINANCE_PLANNING_GROUPS.includes(fallback) ? fallback : 'soon';
}

export function mapPurchaseBudgetBucket(item, fallback = 'weekly') {
  const source = isObject(item) ? item : {};
  const explicit = String(source.budgetBucket ?? '').trim();
  if (explicit) {
    const normalizedExplicit = normalizeBudgetBucket(explicit, '');
    if (FINANCE_BUCKETS.includes(normalizedExplicit)) return normalizedExplicit;
  }
  const frequency =
    source.migrationResolution === 'planning-horizon'
      ? ''
      : String(source.frequency ?? '')
          .trim()
          .toLowerCase();
  if (frequency && FREQUENCY_BUCKETS[frequency]) {
    return FREQUENCY_BUCKETS[frequency];
  }
  const group = normalizePlanningGroup(
    source.planningGroup ?? source.shoppingGroup ?? source.group,
    ''
  );
  return (
    GROUP_BUCKETS[group] ||
    (FINANCE_BUCKETS.includes(fallback) ? fallback : 'weekly')
  );
}

function normalizeDateOnly(value) {
  const date = toLocalDate(value);
  return date ? formatFinanceDateKey(date) : '';
}

export function normalizeFinancePurchase(input) {
  const source = isObject(input) ? { ...input } : {};
  const hasFrequency = Object.prototype.hasOwnProperty.call(
    source,
    'frequency'
  );
  const rawGroup = source.planningGroup ?? source.shoppingGroup ?? source.group;
  const planningGroup = normalizePlanningGroup(
    rawGroup,
    String(source.frequency ?? '').toLowerCase() === 'recurring'
      ? 'recurring'
      : 'soon'
  );
  const rawEstimate = parseFinanceMoney(source.estimate);
  const rawCost = parseFinanceMoney(source.cost);
  const rawOriginalCost = parseFinanceMoney(source.originalCost);
  const purchasedDate =
    source.purchasedDate === null || source.purchasedDate === undefined
      ? null
      : typeof source.purchasedDate === 'string' ||
          typeof source.purchasedDate === 'number'
        ? source.purchasedDate
        : source.purchasedDate instanceof Date
          ? Number.isNaN(source.purchasedDate.getTime())
            ? null
            : source.purchasedDate.toISOString()
          : null;
  const normalized = {
    ...source,
    id: String(source.id || uuid()),
    name:
      typeof source.name === 'string' ? source.name : String(source.name ?? ''),
    planningGroup,
    shoppingGroup: planningGroup,
    budgetBucket: mapPurchaseBudgetBucket({ ...source, planningGroup }),
    estimate: rawEstimate,
    cost: rawCost,
    originalCost: rawOriginalCost === null ? rawCost : rawOriginalCost,
    archived: source.archived === true || source.purchased === true,
    purchasedDate,
    createdAt:
      typeof source.createdAt === 'string' && source.createdAt
        ? source.createdAt
        : new Date().toISOString()
  };
  if (hasFrequency) {
    normalized.frequency =
      typeof source.frequency === 'string' ? source.frequency : '';
  }
  if (
    rawCost === null &&
    Object.prototype.hasOwnProperty.call(source, 'cost')
  ) {
    normalized.invalidCost = true;
  }
  if (
    rawEstimate === null &&
    Object.prototype.hasOwnProperty.call(source, 'estimate') &&
    source.estimate !== null &&
    source.estimate !== ''
  ) {
    normalized.invalidEstimate = true;
  }
  return normalized;
}

function normalizeDueDay(value) {
  const day = parseStrictNumber(value);
  if (day === null || day < 1) return null;
  return Math.min(31, Math.round(day));
}

export function normalizeRecurringPayment(input) {
  const source = isObject(input) ? { ...input } : {};
  const amount = parseFinanceMoney(source.amount);
  const effectiveDate = normalizeDateOnly(
    source.effectiveDate ?? source.startDate ?? source.fromDate
  );
  const endDate = normalizeDateOnly(source.endDate ?? source.untilDate);
  return {
    ...source,
    id: String(source.id || uuid()),
    name:
      typeof source.name === 'string' ? source.name : String(source.name ?? ''),
    amount: amount === null ? 0 : amount,
    dueDay: normalizeDueDay(source.dueDay ?? source.dueDate),
    active: source.active !== false && source.paused !== true,
    paused: source.paused === true || source.active === false,
    effectiveDate: effectiveDate || '',
    endDate: endDate || '',
    budgetBucket: 'monthly'
  };
}

export function normalizeRecurringPayments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((payment) => isObject(payment))
    .map(normalizeRecurringPayment);
}

function getLegacyValue(legacy, field, fallback) {
  const parsed = parseStrictNumber(legacy?.[field]);
  return parsed === null ? fallback : parsed;
}

function normalizeClosure(input) {
  if (!isObject(input)) return null;
  const bucket = normalizeBudgetBucket(input.bucket, '');
  const periodKey = normalizeDateOnly(input.periodKey ?? input.periodStart);
  if (!FINANCE_BUCKETS.includes(bucket) || !periodKey) return null;
  return {
    ...input,
    id: String(input.id || `closure-${bucket}-${periodKey}`),
    bucket,
    periodKey,
    periodStart: normalizeDateOnly(input.periodStart) || periodKey,
    periodEnd: normalizeDateOnly(input.periodEnd),
    baseBudget: normalizeNonNegativeMoney(input.baseBudget ?? input.budget, 0),
    openingCarry: normalizeSignedMoney(input.openingCarry ?? input.carry, 0),
    spending: normalizeNonNegativeMoney(input.spending ?? input.spent, 0),
    closingBalance: normalizeSignedMoney(
      input.closingBalance ?? input.closing,
      0
    ),
    closedAt:
      typeof input.closedAt === 'string' && input.closedAt
        ? input.closedAt
        : new Date().toISOString()
  };
}

function isLegacyRecurringPurchase(purchase) {
  return (
    purchase?.planningGroup === 'recurring' ||
    String(purchase?.frequency ?? '')
      .trim()
      .toLowerCase() === 'recurring'
  );
}

function normalizeBudgetRecord(bucket, input, legacy, now) {
  const source = isObject(input)
    ? { ...input }
    : typeof input === 'number'
      ? { baseBudget: input }
      : typeof input === 'string' && parseStrictNumber(input) !== null
        ? { baseBudget: input }
        : {};
  const fields = LEGACY_BUCKET_FIELDS[bucket];
  const baseBudget = normalizeNonNegativeMoney(
    source.baseBudget ?? source.amount ?? source.budget,
    getLegacyValue(legacy, fields.budget, DEFAULT_BUDGETS[bucket])
  );
  const openingCarry = normalizeSignedMoney(
    source.openingCarry ?? source.carry ?? source.carryOver,
    getLegacyValue(
      legacy,
      fields.carry,
      getLegacyValue(legacy, fields.baseline, 0)
    )
  );
  const currentPeriodKey =
    normalizeDateOnly(source.currentPeriodKey ?? source.periodKey) ||
    getPeriodKey(bucket, now);
  return {
    ...source,
    baseBudget,
    amount: baseBudget,
    openingCarry,
    carry: openingCarry,
    currentPeriodKey
  };
}

export function getDefaultFinanceState(legacy = {}, now = new Date()) {
  return normalizeFinanceState(null, legacy, now);
}

export function normalizeFinanceState(rawState, legacy = {}, now = new Date()) {
  const normalizedNow = toLocalDate(now) || new Date();
  const source = isObject(rawState) ? { ...rawState } : {};
  const budgetSource = isObject(source.budgets) ? source.budgets : {};
  const rawClosures = Array.isArray(source.periodClosures)
    ? source.periodClosures
    : Array.isArray(source.closures)
      ? source.closures
      : [];
  const closures = rawClosures.map(normalizeClosure).filter(Boolean);
  const closureKeys = new Set();
  const uniqueClosures = closures.filter((closure) => {
    const key = `${closure.bucket}:${closure.periodKey}`;
    if (closureKeys.has(key)) return false;
    closureKeys.add(key);
    return true;
  });
  const migration = isObject(source.migration) ? source.migration : {};
  const initializedAt =
    typeof source.initializedAt === 'string' && source.initializedAt
      ? source.initializedAt
      : normalizedNow.toISOString();
  return {
    ...source,
    version: FINANCE_SCHEMA_VERSION,
    initializedAt,
    migration: {
      ...migration,
      fromVersion: Number.isFinite(Number(migration.fromVersion))
        ? Number(migration.fromVersion)
        : source.version
          ? Number(source.version)
          : 0,
      initializedInCurrentPeriod: migration.initializedInCurrentPeriod !== false
    },
    budgets: {
      weekly: normalizeBudgetRecord(
        'weekly',
        budgetSource.weekly,
        legacy,
        normalizedNow
      ),
      monthly: normalizeBudgetRecord(
        'monthly',
        budgetSource.monthly,
        legacy,
        normalizedNow
      ),
      biannual: normalizeBudgetRecord(
        'biannual',
        budgetSource.biannual,
        legacy,
        normalizedNow
      )
    },
    periodClosures: uniqueClosures
  };
}

export function normalizeFinanceData(input = {}, { now = new Date() } = {}) {
  const source = isObject(input) ? { ...input } : {};
  const groceries = Array.isArray(source.groceries)
    ? source.groceries.map(normalizeFinancePurchase)
    : [];
  const recurringPayments = normalizeRecurringPayments(
    source.monthlyRecurringPayments ?? source.recurringPayments
  );
  const finance = normalizeFinanceState(source.finance, source, now);
  const reviewIds = new Set(
    Array.isArray(finance.migrationReview)
      ? finance.migrationReview.map((item) =>
          String(item.purchaseId || item.id)
        )
      : []
  );
  const migrationReview = groceries
    .filter(
      (item) =>
        !item.archived &&
        isLegacyRecurringPurchase(item) &&
        item.migrationResolution !== 'fixed-payment' &&
        item.migrationResolution !== 'planning-horizon'
    )
    .map((item) => ({
      id: `review-${item.id}`,
      purchaseId: item.id,
      name: item.name,
      estimate: item.estimate,
      status: reviewIds.has(item.id) ? 'open' : 'open'
    }));
  finance.migrationReview = migrationReview;
  return {
    ...source,
    finance,
    groceries,
    monthlyRecurringPayments: recurringPayments
  };
}

export function syncLegacyFinanceFields(data, state = data?.finance) {
  if (!isObject(data)) return data;
  const finance = normalizeFinanceState(state, data);
  const next = { ...data, finance };
  Object.entries(LEGACY_BUCKET_FIELDS).forEach(([bucket, fields]) => {
    const record = finance.budgets[bucket];
    next[fields.budget] = record.baseBudget;
    next[fields.carry] = record.openingCarry;
    if (!Object.prototype.hasOwnProperty.call(next, fields.baseline)) {
      next[fields.baseline] = record.openingCarry;
    }
  });
  return next;
}

export function getPeriodBounds(bucket, value = new Date()) {
  const date = startOfDay(value);
  const normalizedBucket = normalizeBudgetBucket(bucket, 'weekly');
  let start;
  let end;
  if (normalizedBucket === 'weekly') {
    const daysFromMonday = (date.getDay() + 6) % 7;
    start = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - daysFromMonday
    );
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else if (normalizedBucket === 'monthly') {
    start = new Date(date.getFullYear(), date.getMonth(), 1);
    end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  } else {
    const startMonth = date.getMonth() < 6 ? 0 : 6;
    start = new Date(date.getFullYear(), startMonth, 1);
    end = new Date(date.getFullYear(), startMonth + 6, 1);
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return {
    bucket: normalizedBucket,
    start,
    end,
    periodKey: formatFinanceDateKey(start),
    label: formatPeriodLabel(normalizedBucket, start, end)
  };
}

export function getPeriodKey(bucket, value = new Date()) {
  return getPeriodBounds(bucket, value).periodKey;
}

export function formatPeriodLabel(bucket, start, end) {
  const normalizedBucket = normalizeBudgetBucket(bucket, 'weekly');
  if (normalizedBucket === 'weekly') {
    const endDate = new Date(end.getTime() - MS_PER_DAY);
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  if (normalizedBucket === 'monthly') {
    return start.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric'
    });
  }
  const endDate = new Date(end.getTime() - MS_PER_DAY);
  return `${start.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}–${endDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

export function getNextPeriodStart(bucket, value) {
  return getPeriodBounds(bucket, value).end;
}

export function enumeratePeriods(bucket, from, untilExclusive) {
  const periods = [];
  let cursor = getPeriodBounds(bucket, from).start;
  const limit = getPeriodBounds(bucket, untilExclusive).start;
  let guard = 0;
  while (cursor < limit && guard < 2400) {
    const period = getPeriodBounds(bucket, cursor);
    periods.push(period);
    cursor = period.end;
    guard += 1;
  }
  return periods;
}

export function getRecurringDueDate(payment, year, monthIndex) {
  const normalized = normalizeRecurringPayment(payment);
  const dueDay = normalized.dueDay || 1;
  return new Date(
    year,
    monthIndex,
    Math.min(dueDay, daysInMonth(year, monthIndex)),
    12,
    0,
    0,
    0
  );
}

export function isRecurringPaymentDueInPeriod(payment, period) {
  if (!payment || period?.bucket !== 'monthly') return false;
  const normalized = normalizeRecurringPayment(payment);
  if (!normalized.active || normalized.amount < 0) return false;
  const dueDate = getRecurringDueDate(
    normalized,
    period.start.getFullYear(),
    period.start.getMonth()
  );
  const effective = normalized.effectiveDate
    ? startOfDay(normalized.effectiveDate)
    : null;
  const end = normalized.endDate ? startOfDay(normalized.endDate) : null;
  if (effective && dueDate < effective) return false;
  if (end) {
    end.setHours(23, 59, 59, 999);
    if (dueDate > end) return false;
  }
  return dueDate >= period.start && dueDate < period.end;
}

function getPurchaseCost(purchase) {
  if (purchase?.invalidCost) return null;
  const cost = parseFinanceMoney(purchase?.cost);
  if (cost !== null) return cost;
  const original = parseFinanceMoney(purchase?.originalCost);
  return original === null ? null : original;
}

function getPurchaseDate(purchase) {
  if (!purchase?.purchasedDate) return null;
  return toLocalDate(purchase.purchasedDate);
}

export function calculatePeriodSpending({
  bucket,
  period,
  purchases = [],
  recurringPayments = []
} = {}) {
  const resolvedPeriod = period || getPeriodBounds(bucket, new Date());
  const normalizedBucket = normalizeBudgetBucket(
    bucket || resolvedPeriod.bucket,
    resolvedPeriod.bucket
  );
  let purchaseSpending = 0;
  if (Array.isArray(purchases)) {
    purchases.forEach((purchase) => {
      const normalized = normalizeFinancePurchase(purchase);
      const date = getPurchaseDate(normalized);
      const cost = getPurchaseCost(normalized);
      if (
        !normalized.archived ||
        normalized.budgetBucket !== normalizedBucket ||
        !date ||
        cost === null ||
        date < resolvedPeriod.start ||
        date >= resolvedPeriod.end
      ) {
        return;
      }
      purchaseSpending += cost;
    });
  }
  const recurringSpending =
    normalizedBucket === 'monthly' && Array.isArray(recurringPayments)
      ? recurringPayments.reduce((sum, payment) => {
          return isRecurringPaymentDueInPeriod(payment, resolvedPeriod)
            ? sum + normalizeNonNegativeMoney(payment.amount, 0)
            : sum;
        }, 0)
      : 0;
  return {
    bucket: normalizedBucket,
    purchaseSpending,
    recurringSpending,
    spending: purchaseSpending + recurringSpending
  };
}

export function calculateEnvelope({
  bucket,
  baseBudget = 0,
  openingCarry = 0,
  spending = 0,
  now = new Date(),
  period
} = {}) {
  const resolvedPeriod = period || getPeriodBounds(bucket, now);
  const safeBaseBudget = normalizeNonNegativeMoney(baseBudget, 0);
  const safeOpeningCarry = normalizeSignedMoney(openingCarry, 0);
  const safeSpending = normalizeNonNegativeMoney(spending, 0);
  const envelope = safeBaseBudget + safeOpeningCarry;
  const remaining = envelope - safeSpending;
  const closingBalance = remaining;
  const current = toLocalDate(now) || new Date();
  const elapsedFraction = Math.max(
    0,
    Math.min(
      1,
      (current.getTime() - resolvedPeriod.start.getTime()) /
        (resolvedPeriod.end.getTime() - resolvedPeriod.start.getTime())
    )
  );
  const expectedSpending = Math.max(0, envelope) * elapsedFraction;
  const remainingDays = Math.max(
    0,
    (resolvedPeriod.end.getTime() - startOfDay(current).getTime()) / MS_PER_DAY
  );
  let status = 'safe';
  if (remaining < 0 || (envelope === 0 && safeSpending > 0)) {
    status = 'over';
  } else if (
    (envelope > 0 && remaining <= envelope * 0.2) ||
    safeSpending > expectedSpending
  ) {
    status = 'approaching';
  }
  return {
    bucket: normalizeBudgetBucket(bucket, resolvedPeriod.bucket),
    periodKey: resolvedPeriod.periodKey,
    periodStart: resolvedPeriod.start,
    periodEnd: resolvedPeriod.end,
    periodLabel: resolvedPeriod.label,
    baseBudget: safeBaseBudget,
    openingCarry: safeOpeningCarry,
    carry: safeOpeningCarry,
    envelope,
    spending: safeSpending,
    spent: safeSpending,
    remaining,
    closingBalance,
    elapsedFraction,
    expectedSpending,
    remainingDays,
    paceRemaining: remainingDays > 0 ? remaining / remainingDays : remaining,
    status,
    statusLabel:
      status === 'over'
        ? 'Over budget'
        : status === 'approaching'
          ? 'Approaching limit'
          : 'Safe to spend'
  };
}

function findClosure(closures, bucket, periodKey) {
  return closures.find(
    (closure) => closure.bucket === bucket && closure.periodKey === periodKey
  );
}

function withClosure(closures, closure) {
  const next = closures.slice();
  const existingIndex = next.findIndex(
    (item) =>
      item.bucket === closure.bucket && item.periodKey === closure.periodKey
  );
  if (existingIndex >= 0) return next;
  next.push(closure);
  return next;
}

export function reconcileFinancePeriods({
  state,
  purchases = [],
  recurringPayments = [],
  now = new Date()
} = {}) {
  const next = normalizeFinanceState(state, {}, now);
  let closures = next.periodClosures.slice();
  FINANCE_BUCKETS.forEach((bucket) => {
    const record = next.budgets[bucket];
    const currentPeriod = getPeriodBounds(bucket, now);
    let cursor = getPeriodBounds(bucket, record.currentPeriodKey || now).start;
    let openingCarry = record.openingCarry;
    let guard = 0;
    while (cursor < currentPeriod.start && guard < 2400) {
      const period = getPeriodBounds(bucket, cursor);
      const existing = findClosure(closures, bucket, period.periodKey);
      if (existing) {
        openingCarry = existing.closingBalance;
      } else {
        const spending = calculatePeriodSpending({
          bucket,
          period,
          purchases,
          recurringPayments
        }).spending;
        const closingBalance = record.baseBudget + openingCarry - spending;
        const closure = {
          id: `closure-${bucket}-${period.periodKey}`,
          bucket,
          periodKey: period.periodKey,
          periodStart: formatFinanceDateKey(period.start),
          periodEnd: formatFinanceDateKey(
            new Date(period.end.getTime() - MS_PER_DAY)
          ),
          baseBudget: record.baseBudget,
          openingCarry,
          spending,
          closingBalance,
          closedAt: new Date(now).toISOString()
        };
        closures = withClosure(closures, closure);
        openingCarry = closingBalance;
      }
      cursor = period.end;
      guard += 1;
    }
    record.currentPeriodKey = currentPeriod.periodKey;
    record.openingCarry = openingCarry;
    record.carry = openingCarry;
  });
  next.periodClosures = closures.sort((left, right) => {
    if (left.bucket !== right.bucket)
      return left.bucket.localeCompare(right.bucket);
    return left.periodKey.localeCompare(right.periodKey);
  });
  return next;
}

export function calculateFinanceSnapshot({
  state,
  purchases = [],
  recurringPayments = [],
  now = new Date()
} = {}) {
  const reconciledState = reconcileFinancePeriods({
    state,
    purchases,
    recurringPayments,
    now
  });
  const periods = {};
  FINANCE_BUCKETS.forEach((bucket) => {
    const period = getPeriodBounds(bucket, now);
    const spending = calculatePeriodSpending({
      bucket,
      period,
      purchases,
      recurringPayments
    });
    periods[bucket] = {
      ...calculateEnvelope({
        bucket,
        baseBudget: reconciledState.budgets[bucket].baseBudget,
        openingCarry: reconciledState.budgets[bucket].openingCarry,
        spending: spending.spending,
        period,
        now
      }),
      purchaseSpending: spending.purchaseSpending,
      recurringSpending: spending.recurringSpending
    };
  });
  const statusOrder = { safe: 0, approaching: 1, over: 2 };
  const overallStatus = FINANCE_BUCKETS.reduce(
    (current, bucket) =>
      statusOrder[periods[bucket].status] > statusOrder[current]
        ? periods[bucket].status
        : current,
    'safe'
  );
  return {
    state: reconciledState,
    periods,
    weekly: periods.weekly,
    monthly: periods.monthly,
    biannual: periods.biannual,
    recurringTotal: periods.monthly.recurringSpending,
    overallStatus,
    overallStatusLabel:
      overallStatus === 'over'
        ? 'Over budget'
        : overallStatus === 'approaching'
          ? 'Approaching limit'
          : 'Safe to spend'
  };
}

export function getFinanceMigrationReview(purchases = []) {
  return purchases
    .map(normalizeFinancePurchase)
    .filter(
      (purchase) =>
        !purchase.archived &&
        isLegacyRecurringPurchase(purchase) &&
        purchase.migrationResolution !== 'fixed-payment' &&
        purchase.migrationResolution !== 'planning-horizon'
    )
    .map((purchase) => ({
      purchaseId: purchase.id,
      name: purchase.name,
      estimate: purchase.estimate
    }));
}
