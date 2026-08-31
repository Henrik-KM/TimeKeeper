// @ts-nocheck

import { uuid } from '../../shared/id.mjs';

export const WEALTH_SCHEMA_VERSION = 2;
export const WEALTH_ACCOUNT_KINDS = ['asset', 'liability'];
export const WEALTH_SCENARIOS = ['conservative', 'base', 'optimistic'];
export const WEALTH_DEFAULT_STALE_AFTER_DAYS = 45;
export const WEALTH_DEFAULT_GOAL_AMOUNT = 2000000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;

const DEFAULT_SCENARIO_RATES = {
  conservative: null,
  base: 0,
  optimistic: null
};

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeId(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return uuid();
  }
  return String(value);
}

export function parseWealthAmount(raw) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, '')
    .replace(/[^0-9.-]/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

export function parseOptionalWealthAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const cleaned = String(raw).trim().replace(/\s/g, '');
  if (!/^-?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(cleaned)) {
    return null;
  }
  const value = Number.parseFloat(cleaned.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** Parse a user-entered annual rate expressed as a percentage. */
export function parseWealthAnnualRate(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const text = String(raw).trim().replace(/\s/g, '');
  const hasPercent = text.endsWith('%');
  const numericText = hasPercent ? text.slice(0, -1) : text;
  if (!/^-?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(numericText)) {
    return null;
  }
  const value = Number.parseFloat(numericText.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const rate = value / 100;
  return rate > -1 ? rate : null;
}

function normalizeStoredAnnualRate(raw, fallback = null) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > -1 ? raw : fallback;
  }
  const text = String(raw).trim();
  if (text.endsWith('%')) return parseWealthAnnualRate(text) ?? fallback;
  const value = Number.parseFloat(text.replace(',', '.'));
  if (!Number.isFinite(value)) return fallback;
  const rate = Math.abs(value) > 1 ? value / 100 : value;
  return rate > -1 ? rate : fallback;
}

export function parseWealthDate(raw) {
  const text = String(raw ?? '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

export function formatWealthDate(date) {
  const parsed = date instanceof Date ? new Date(date) : parseWealthDate(date);
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeBreakdownItem(item) {
  const obj = isObject(item) ? { ...item } : {};
  const balance = parseOptionalWealthAmount(obj.balance);
  return {
    ...obj,
    accountId: normalizeText(obj.accountId),
    balance: balance !== null && balance >= 0 ? balance : null
  };
}

export function normalizeWealthBreakdown(breakdown) {
  return Array.isArray(breakdown) ? breakdown.map(normalizeBreakdownItem) : [];
}

/**
 * @typedef {{ [key: string]: unknown, id?: string, date?: string, amount?: number | string, note?: string, breakdown?: Array<{ accountId?: string, balance?: number | string }> }} WealthEntryInput
 * @typedef {{ [key: string]: unknown, id: string, date: string, amount: number, note: string, breakdown?: Array<{ [key: string]: unknown, accountId: string, balance: number | null }> }} WealthEntry
 */

/**
 * Normalize a legacy or current snapshot without discarding unknown fields.
 * Total-only snapshots intentionally keep their original representation.
 *
 * @param {WealthEntryInput | null | undefined} entry
 * @returns {WealthEntry}
 */
export function normalizeWealthEntry(entry) {
  const obj = isObject(entry) ? { ...entry } : {};
  const normalized = {
    ...obj,
    id: normalizeId(obj.id),
    date: normalizeText(obj.date),
    amount: parseWealthAmount(obj.amount),
    note: typeof obj.note === 'string' ? obj.note : ''
  };
  if (Array.isArray(obj.breakdown)) {
    normalized.breakdown = normalizeWealthBreakdown(obj.breakdown);
  }
  return normalized;
}

export function normalizeWealthAccount(account) {
  const obj = isObject(account) ? { ...account } : {};
  return {
    ...obj,
    id: normalizeId(obj.id),
    name: normalizeText(obj.name, 'Unnamed account'),
    kind: WEALTH_ACCOUNT_KINDS.includes(obj.kind) ? obj.kind : 'asset',
    category: normalizeText(obj.category, 'other'),
    archived: Boolean(obj.archived)
  };
}

export function normalizeWealthSettings(settings) {
  const obj = isObject(settings) ? { ...settings } : {};
  const staleAfterDays = Number(obj.staleAfterDays);
  return {
    ...obj,
    staleAfterDays:
      Number.isFinite(staleAfterDays) && staleAfterDays >= 1
        ? Math.floor(staleAfterDays)
        : WEALTH_DEFAULT_STALE_AFTER_DAYS,
    remindersEnabled: obj.remindersEnabled !== false
  };
}

export function makeDefaultWealthGoal() {
  return {
    amount: WEALTH_DEFAULT_GOAL_AMOUNT,
    date: '',
    monthlyContribution: 0,
    scenarioAnnualRates: { ...DEFAULT_SCENARIO_RATES }
  };
}

export function normalizeWealthGoal(goal) {
  const obj = isObject(goal) ? { ...goal } : {};
  const rates = isObject(obj.scenarioAnnualRates)
    ? { ...obj.scenarioAnnualRates }
    : {};
  const hasMonthlyContribution = hasOwn(obj, 'monthlyContribution');
  const monthlyContribution = hasMonthlyContribution
    ? parseOptionalWealthAmount(obj.monthlyContribution)
    : 0;
  return {
    ...obj,
    amount: hasOwn(obj, 'amount')
      ? parseWealthAmount(obj.amount)
      : WEALTH_DEFAULT_GOAL_AMOUNT,
    date: normalizeText(obj.date),
    monthlyContribution:
      monthlyContribution !== null && monthlyContribution >= 0
        ? monthlyContribution
        : hasMonthlyContribution
          ? null
          : 0,
    scenarioAnnualRates: {
      ...rates,
      conservative: normalizeStoredAnnualRate(
        rates.conservative,
        DEFAULT_SCENARIO_RATES.conservative
      ),
      base: normalizeStoredAnnualRate(rates.base, DEFAULT_SCENARIO_RATES.base),
      optimistic: normalizeStoredAnnualRate(
        rates.optimistic,
        DEFAULT_SCENARIO_RATES.optimistic
      )
    }
  };
}

export function getDefaultWealthHistory() {
  return [];
}

/**
 * Normalize all Wealth-owned fields while preserving the rest of the app state.
 * A detailed snapshot's amount is recalculated only when every referenced
 * account and balance is usable; unknown account references never erase its
 * existing total.
 */
export function normalizeWealthData(data, { now = new Date() } = {}) {
  const source = isObject(data) ? data : {};
  const sourceSchemaVersion = Number(source.wealthSchemaVersion);
  const migrateDetailedTotals =
    !Number.isFinite(sourceSchemaVersion) ||
    sourceSchemaVersion < WEALTH_SCHEMA_VERSION;
  const accounts = Array.isArray(source.wealthAccounts)
    ? source.wealthAccounts.map(normalizeWealthAccount)
    : [];
  const sourceHistory = Array.isArray(source.wealthHistory)
    ? source.wealthHistory
    : [];
  const history = sourceHistory.length
    ? sourceHistory.map(normalizeWealthEntry)
    : getDefaultWealthHistory();
  const normalizedHistory = history.map((entry, index) => {
    if (!Array.isArray(entry.breakdown) || !entry.breakdown.length) {
      return entry;
    }
    const originalAmount = parseOptionalWealthAmount(
      sourceHistory[index]?.amount
    );
    if (!migrateDetailedTotals && originalAmount !== null) return entry;
    const composition = rollUpWealthBreakdown(entry.breakdown, accounts);
    return composition.complete
      ? { ...entry, amount: composition.netWorth }
      : entry;
  });
  const next = {
    ...source,
    wealthSchemaVersion: Math.max(
      WEALTH_SCHEMA_VERSION,
      Number.isFinite(Number(source.wealthSchemaVersion))
        ? Number(source.wealthSchemaVersion)
        : 0
    ),
    wealthAccounts: accounts,
    wealthHistory: normalizedHistory,
    wealthGoal: normalizeWealthGoal(source.wealthGoal),
    wealthSettings: normalizeWealthSettings(source.wealthSettings)
  };
  void now;
  return next;
}

export function validateWealthGoal(amountRaw, dateRaw = '', options = null) {
  let amountValue = amountRaw;
  let dateValue = dateRaw;
  let goalOptions = options;
  if (isObject(amountRaw)) {
    amountValue = amountRaw.amount;
    dateValue = amountRaw.date || '';
    goalOptions = amountRaw;
  }
  const amount = parseOptionalWealthAmount(amountValue);
  if (amount === null || amount <= 0) {
    return { ok: false, reason: 'amount' };
  }
  const date = normalizeText(dateValue);
  if (date && !parseWealthDate(date)) {
    return { ok: false, reason: 'date' };
  }
  const goal = { amount, date };
  if (isObject(goalOptions)) {
    const contributionRaw = hasOwn(goalOptions, 'monthlyContribution')
      ? goalOptions.monthlyContribution
      : 0;
    const monthlyContribution =
      contributionRaw === null ||
      contributionRaw === undefined ||
      String(contributionRaw).trim() === ''
        ? 0
        : parseOptionalWealthAmount(contributionRaw);
    if (monthlyContribution === null || monthlyContribution < 0) {
      return { ok: false, reason: 'monthlyContribution' };
    }
    const rateValues = isObject(goalOptions.scenarioAnnualRates)
      ? goalOptions.scenarioAnnualRates
      : {};
    const scenarioAnnualRates = {};
    for (const scenario of WEALTH_SCENARIOS) {
      const raw = rateValues[scenario];
      if (
        scenario === 'base' &&
        raw !== undefined &&
        raw !== '' &&
        raw !== null
      ) {
        const parsed = parseWealthAnnualRate(raw);
        if (parsed === null) return { ok: false, reason: 'rate' };
        scenarioAnnualRates[scenario] = parsed;
      } else if (scenario !== 'base' && String(raw ?? '').trim() !== '') {
        const parsed = parseWealthAnnualRate(raw);
        if (parsed === null) return { ok: false, reason: 'rate' };
        scenarioAnnualRates[scenario] = parsed;
      } else {
        scenarioAnnualRates[scenario] = scenario === 'base' ? 0 : null;
      }
    }
    goal.monthlyContribution = monthlyContribution;
    goal.scenarioAnnualRates = scenarioAnnualRates;
  }
  return { ok: true, goal };
}

export function getValidWealthHistory(history) {
  return (Array.isArray(history) ? history : [])
    .map((entry, index) => ({
      entry,
      index,
      date: parseWealthDate(entry?.date),
      amount: parseOptionalWealthAmount(entry?.amount)
    }))
    .filter(
      (item) =>
        item.date &&
        Number.isFinite(item.date.getTime()) &&
        Number.isFinite(item.amount)
    )
    .sort((left, right) => {
      const dateDiff = left.date.getTime() - right.date.getTime();
      return dateDiff || left.index - right.index;
    })
    .map((item) => ({
      ...item.entry,
      date: formatWealthDate(item.date),
      amount: item.amount
    }));
}

export function getLatestWealthSnapshot(history) {
  const valid = getValidWealthHistory(history);
  return valid.length ? valid[valid.length - 1] : null;
}

export function getPreviousWealthSnapshot(history, latest = null) {
  const valid = getValidWealthHistory(history);
  if (valid.length < 2) return null;
  const latestId = latest?.id;
  const latestIndex = latestId
    ? valid.findIndex((entry) => String(entry.id) === String(latestId))
    : valid.length - 1;
  const index = latestIndex >= 0 ? latestIndex - 1 : valid.length - 2;
  return index >= 0 ? valid[index] : null;
}

export function findWealthSnapshotByDate(history, date) {
  const dateKey = formatWealthDate(date);
  if (!dateKey) return null;
  return (
    (Array.isArray(history) ? history : []).find(
      (entry) => formatWealthDate(entry?.date) === dateKey
    ) || null
  );
}

/**
 * @param {Array<WealthEntryInput> | undefined} history
 * @param {{ id?: string | null, date?: string, amount?: number | string, breakdown?: Array<{ accountId?: string, balance?: number | string }>, note?: string }} [candidate]
 * @param {{ replace?: boolean }} [options]
 */
export function resolveWealthSnapshotConflict(
  history,
  { id = null, date, amount, breakdown = null, note = '' } = {},
  { replace = false } = {}
) {
  const existing = findWealthSnapshotByDate(history, date);
  if (!existing) return { action: 'create', existing: null };
  if (id && String(existing.id) !== String(id)) {
    return { action: replace ? 'replace' : 'conflict', existing };
  }
  if (id && String(existing.id) === String(id)) {
    return { action: 'update', existing };
  }
  const sameAmount = Number(existing.amount) === Number(amount);
  const sameNote = String(existing.note || '') === String(note || '');
  const sameBreakdown =
    JSON.stringify(existing.breakdown || null) ===
    JSON.stringify(breakdown || null);
  if (sameAmount && sameNote && sameBreakdown) {
    return { action: 'update', existing };
  }
  return { action: replace ? 'replace' : 'conflict', existing };
}

export function rollUpWealthBreakdown(breakdown, accounts) {
  const accountMap = new Map(
    (Array.isArray(accounts) ? accounts : []).map((account) => [
      String(account.id),
      account
    ])
  );
  const rows = normalizeWealthBreakdown(breakdown);
  let assets = 0;
  let liabilities = 0;
  const missingAccounts = [];
  let complete = rows.length > 0;
  rows.forEach((row) => {
    const account = accountMap.get(String(row.accountId));
    const balance = Number(row.balance);
    if (!account || !Number.isFinite(balance) || balance < 0) {
      complete = false;
      if (!account && row.accountId) missingAccounts.push(row.accountId);
      return;
    }
    if (account.kind === 'liability') liabilities += balance;
    else assets += balance;
  });
  return {
    detailed: rows.length > 0,
    complete,
    assets,
    liabilities,
    netWorth: assets - liabilities,
    missingAccounts,
    rows
  };
}

export function getWealthComposition(snapshot, accounts) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.breakdown) ||
    !snapshot.breakdown.length
  ) {
    return {
      detailed: false,
      complete: false,
      assets: null,
      liabilities: null,
      netWorth: Number(snapshot?.amount) || 0,
      rows: [],
      missingAccounts: []
    };
  }
  return rollUpWealthBreakdown(snapshot.breakdown, accounts);
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function calculateWealthFreshness(
  history,
  now = new Date(),
  settings = {}
) {
  const latest = getLatestWealthSnapshot(history);
  const staleAfterDays = normalizeWealthSettings(settings).staleAfterDays;
  if (!latest) {
    return {
      status: 'empty',
      label: 'No snapshot yet',
      detail: 'Update wealth to establish a current total.',
      latest: null,
      actualDate: '',
      ageDays: null,
      staleAfterDays
    };
  }
  const latestDate = parseWealthDate(latest.date);
  const ageDays = Math.max(
    0,
    Math.floor((startOfDay(now).getTime() - latestDate.getTime()) / DAY_MS)
  );
  const stale = ageDays > staleAfterDays;
  const label =
    ageDays === 0
      ? 'Updated today'
      : `Updated ${ageDays} day${ageDays === 1 ? '' : 's'} ago`;
  return {
    status: stale ? 'stale' : 'fresh',
    label,
    detail: stale
      ? `This total is from ${latest.date}; update it when you have a fresh number.`
      : `As of ${latest.date}.`,
    latest,
    actualDate: latest.date,
    ageDays,
    staleAfterDays
  };
}

export function calculateWealthPeriodChange(history, latest = null) {
  const current = latest || getLatestWealthSnapshot(history);
  const previous = getPreviousWealthSnapshot(history, current);
  if (!current || !previous) {
    return {
      available: false,
      amount: null,
      percentage: null,
      elapsedDays: null,
      current,
      previous
    };
  }
  const currentDate = parseWealthDate(current.date);
  const previousDate = parseWealthDate(previous.date);
  const amount = Number(current.amount) - Number(previous.amount);
  const percentage =
    Number(previous.amount) === 0
      ? null
      : (amount / Math.abs(Number(previous.amount))) * 100;
  return {
    available: true,
    amount,
    percentage,
    elapsedDays: Math.max(
      0,
      Math.round((currentDate.getTime() - previousDate.getTime()) / DAY_MS)
    ),
    current,
    previous
  };
}

function subtractYears(date, years) {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setFullYear(result.getFullYear() - years);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

export function getWealthHistoryRange(
  history,
  range = 'all',
  now = new Date()
) {
  const valid = getValidWealthHistory(history);
  if (range === 'one-year') {
    const boundary = subtractYears(startOfDay(now), 1).getTime();
    return valid.filter(
      (entry) => parseWealthDate(entry.date).getTime() >= boundary
    );
  }
  if (range === 'three-year') {
    const boundary = subtractYears(startOfDay(now), 3).getTime();
    return valid.filter(
      (entry) => parseWealthDate(entry.date).getTime() >= boundary
    );
  }
  return valid;
}

/**
 * Historical regression is deliberately a diagnostic. It is never a savings
 * label and cannot authorize forward projection when data is stale.
 */
export function calculateHistoricalRegression(
  history,
  { now = new Date(), settings = {}, range = 'all' } = {}
) {
  const valid = getWealthHistoryRange(history, range, now);
  const freshness = calculateWealthFreshness(history, now, settings);
  if (valid.length < 3) {
    return {
      available: false,
      canProject: false,
      reason: 'insufficient-history',
      label: 'Historical trend diagnostic needs at least three snapshots.',
      freshness
    };
  }
  const firstDate = parseWealthDate(valid[0].date).getTime();
  const points = valid.map((entry) => ({
    x: (parseWealthDate(entry.date).getTime() - firstDate) / DAY_MS,
    y: entry.amount
  }));
  const regression = computeWealthRegression(points);
  return {
    available: !!regression,
    canProject: !!regression && freshness.status === 'fresh',
    reason: freshness.status === 'stale' ? 'stale' : null,
    label:
      freshness.status === 'stale'
        ? 'Historical trend diagnostic is available, but forward extrapolation is paused while the total is stale.'
        : 'Historical trend diagnostic',
    monthlyChange: regression ? regression.slope * 30 : null,
    regression,
    freshness
  };
}

export function computeWealthRegression(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const count = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / count;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / count;
  const sumSqX = points.reduce(
    (sum, point) => sum + Math.pow(point.x - meanX, 2),
    0
  );
  const covXY = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0
  );
  const slope = sumSqX === 0 ? 0 : covXY / sumSqX;
  const intercept = meanY - slope * meanX;
  const residualSum = points.reduce((sum, point) => {
    const predicted = intercept + slope * point.x;
    return sum + Math.pow(point.y - predicted, 2);
  }, 0);
  const residualStd = Math.sqrt(residualSum / Math.max(1, count - 2));
  return { slope, intercept, meanX, meanY, residualStd, sumSqX, count };
}

function addClampedMonths(date, months) {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function monthsBetween(startDate, endDate) {
  const start = parseWealthDate(startDate);
  const end = parseWealthDate(endDate);
  if (!start || !end) return null;
  const calendarMonths =
    (end.getFullYear() - start.getFullYear()) * 12 +
    end.getMonth() -
    start.getMonth();
  let wholeMonths = calendarMonths;
  let anniversary = addClampedMonths(start, wholeMonths);
  if (anniversary > end) {
    wholeMonths -= 1;
    anniversary = addClampedMonths(start, wholeMonths);
  }
  const nextAnniversary = addClampedMonths(start, wholeMonths + 1);
  const remainingDays = Math.max(0, end.getTime() - anniversary.getTime());
  const periodDays = Math.max(
    1,
    nextAnniversary.getTime() - anniversary.getTime()
  );
  return wholeMonths + remainingDays / periodDays;
}

function monthlyRateFromAnnual(annualRate) {
  if (!Number.isFinite(annualRate) || annualRate <= -1) return null;
  return Math.pow(1 + annualRate, 1 / MONTHS_PER_YEAR) - 1;
}

/**
 * @param {{ currentAmount?: number | string, goalAmount?: number | string, startDate?: string, goalDate?: string, monthlyContribution?: number | string, annualRate?: number | string }} [options]
 */
export function calculateGoalScenario({
  currentAmount,
  goalAmount,
  startDate,
  goalDate,
  monthlyContribution = 0,
  annualRate = 0
} = {}) {
  const current = Number(currentAmount);
  const goal = Number(goalAmount);
  const contribution = Number(monthlyContribution || 0);
  const months = monthsBetween(startDate, goalDate);
  const monthlyRate = monthlyRateFromAnnual(Number(annualRate));
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(goal) ||
    goal <= 0 ||
    !Number.isFinite(contribution) ||
    contribution < 0 ||
    months === null ||
    months <= 0 ||
    monthlyRate === null
  ) {
    return {
      available: false,
      reason: months === null || months <= 0 ? 'date' : 'invalid-assumptions',
      months,
      currentAmount: current,
      goalAmount: goal,
      annualRate,
      monthlyRate
    };
  }
  const factor = Math.pow(1 + monthlyRate, months);
  const annuity =
    Math.abs(monthlyRate) < 1e-12 ? months : (factor - 1) / monthlyRate;
  const projectedAmount = current * factor + contribution * annuity;
  const requiredMonthlyContribution = Math.max(
    0,
    (goal - current * factor) / annuity
  );
  return {
    available: true,
    months,
    annualRate,
    monthlyRate,
    currentAmount: current,
    goalAmount: goal,
    monthlyContribution: contribution,
    projectedAmount,
    requiredMonthlyContribution,
    gap: goal - projectedAmount,
    onTrack: projectedAmount >= goal
  };
}

export function calculateWealthGoalPlan(
  goal,
  latestSnapshot,
  { now = new Date() } = {}
) {
  const normalizedGoal = normalizeWealthGoal(goal);
  const current = latestSnapshot || null;
  if (!current || !parseWealthDate(current.date)) {
    return {
      available: false,
      reason: 'insufficient-history',
      scenarios: [],
      goal: normalizedGoal
    };
  }
  const goalDate = parseWealthDate(normalizedGoal.date);
  if (!goalDate || goalDate <= parseWealthDate(current.date)) {
    return {
      available: false,
      reason: normalizedGoal.date ? 'date' : 'missing-goal-date',
      scenarios: [],
      goal: normalizedGoal,
      current
    };
  }
  const scenarios = WEALTH_SCENARIOS.filter(
    (scenario) =>
      scenario === 'base' ||
      normalizedGoal.scenarioAnnualRates[scenario] !== null
  ).map((scenario) => {
    const annualRate = normalizedGoal.scenarioAnnualRates[scenario];
    const calculation = calculateGoalScenario({
      currentAmount: current.amount,
      goalAmount: normalizedGoal.amount,
      startDate: current.date,
      goalDate: normalizedGoal.date,
      monthlyContribution: normalizedGoal.monthlyContribution,
      annualRate
    });
    return {
      key: scenario,
      label:
        scenario === 'conservative'
          ? 'Downside'
          : scenario === 'optimistic'
            ? 'Upside'
            : 'Base case',
      annualRate,
      ...calculation
    };
  });
  void now;
  return {
    available: scenarios.every((scenario) => scenario.available),
    reason: null,
    goal: normalizedGoal,
    current,
    scenarios
  };
}

export function getWealthAccountReferences(history) {
  const references = new Map();
  (Array.isArray(history) ? history : []).forEach((snapshot) => {
    (Array.isArray(snapshot?.breakdown) ? snapshot.breakdown : []).forEach(
      (row) => {
        const key = String(row.accountId || '');
        if (key) references.set(key, (references.get(key) || 0) + 1);
      }
    );
  });
  return references;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

const CSV_COLUMNS = ['date', 'account', 'kind', 'category', 'balance', 'note'];

function accountKey({ account, name, kind, category }) {
  return [account ?? name, kind, category]
    .map((value) => normalizeText(value).toLocaleLowerCase())
    .join('|');
}

export function previewWealthCsvImport(
  csvText,
  { accounts = [], history = [] } = {}
) {
  const rawRows = parseCsvRows(csvText);
  const errors = [];
  const warnings = [];
  if (
    !rawRows.length ||
    rawRows.every((row) => row.every((cell) => !cell.trim()))
  ) {
    return {
      ok: false,
      errors: [{ row: 0, code: 'empty', message: 'CSV is empty.' }],
      warnings,
      rows: [],
      newAccounts: [],
      conflictDates: [],
      validRows: 0
    };
  }
  const headers = rawRows[0].map((header) =>
    normalizeText(header).toLowerCase()
  );
  const missingColumns = CSV_COLUMNS.filter(
    (column) => !headers.includes(column)
  );
  if (missingColumns.length) {
    return {
      ok: false,
      errors: [
        {
          row: 1,
          code: 'headers',
          message: `Missing CSV column(s): ${missingColumns.join(', ')}.`
        }
      ],
      warnings,
      rows: [],
      newAccounts: [],
      conflictDates: [],
      validRows: 0
    };
  }
  const indexes = Object.fromEntries(
    CSV_COLUMNS.map((column) => [column, headers.indexOf(column)])
  );
  const existingAccounts = Array.isArray(accounts)
    ? accounts.map(normalizeWealthAccount)
    : [];
  const seenAccountDates = new Set();
  const candidateAccounts = new Map();
  const rows = [];
  rawRows.slice(1).forEach((raw, offset) => {
    const rowNumber = offset + 2;
    if (raw.every((cell) => !String(cell || '').trim())) return;
    const value = (column) => String(raw[indexes[column]] ?? '').trim();
    const dateRaw = value('date');
    const date = parseWealthDate(dateRaw);
    const account = value('account');
    const kind = value('kind').toLowerCase();
    const category = value('category');
    const balance = parseOptionalWealthAmount(value('balance'));
    const note = value('note');
    if (!dateRaw) {
      errors.push({
        row: rowNumber,
        code: 'incomplete-date',
        message: 'Date is required.'
      });
    } else if (!date) {
      errors.push({
        row: rowNumber,
        code: 'invalid-date',
        message: 'Date must use YYYY-MM-DD.'
      });
    }
    if (!account) {
      errors.push({
        row: rowNumber,
        code: 'account',
        message: 'Account name is required.'
      });
    }
    if (!WEALTH_ACCOUNT_KINDS.includes(kind)) {
      errors.push({
        row: rowNumber,
        code: 'kind',
        message: 'Kind must be asset or liability.'
      });
    }
    if (!category) {
      errors.push({
        row: rowNumber,
        code: 'category',
        message: 'Category is required.'
      });
    }
    if (balance === null || balance < 0) {
      errors.push({
        row: rowNumber,
        code: 'balance',
        message: 'Balance must be a non-negative number.'
      });
    }
    const normalizedDate = formatWealthDate(date);
    const dateAccountKey = `${normalizedDate}|${account.toLocaleLowerCase()}`;
    if (normalizedDate && account && seenAccountDates.has(dateAccountKey)) {
      errors.push({
        row: rowNumber,
        code: 'duplicate-account-date',
        message: 'The same account appears more than once on this date.'
      });
    }
    if (normalizedDate && account) seenAccountDates.add(dateAccountKey);
    const candidate = {
      row: rowNumber,
      date: normalizedDate,
      account,
      kind,
      category,
      balance,
      note
    };
    rows.push(candidate);
    const key = accountKey(candidate);
    if (account && WEALTH_ACCOUNT_KINDS.includes(kind) && category) {
      const existing = existingAccounts.find(
        (item) => accountKey(item) === key
      );
      if (!existing && !candidateAccounts.has(key)) {
        candidateAccounts.set(key, { name: account, kind, category });
      }
    }
  });
  const conflictDates = Array.from(
    new Set(
      rows
        .filter(
          (row) =>
            row.date &&
            !errors.some(
              (error) => error.row === row.row && error.code.includes('date')
            )
        )
        .map((row) => row.date)
        .filter((date) => findWealthSnapshotByDate(history, date))
    )
  );
  if (conflictDates.length) {
    warnings.push({
      code: 'existing-dates',
      message: `${conflictDates.length} date(s) already have snapshots and will be skipped unless Replace is selected.`
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rows,
    newAccounts: Array.from(candidateAccounts.values()),
    conflictDates,
    validRows: rows.length - new Set(errors.map((error) => error.row)).size
  };
}

export function applyWealthCsvImport(
  data,
  preview,
  { replaceExistingDates = false } = {}
) {
  if (!preview?.ok) {
    return { ok: false, reason: 'invalid-preview', state: data };
  }
  const next = normalizeWealthData(data);
  const accounts = next.wealthAccounts.slice();
  const byKey = new Map(
    accounts.map((account) => [accountKey(account), account])
  );
  const history = next.wealthHistory.slice();
  const grouped = new Map();
  preview.rows.forEach((row) => {
    if (!grouped.has(row.date)) grouped.set(row.date, []);
    grouped.get(row.date).push(row);
  });
  const importableDates = new Set(
    Array.from(grouped.keys()).filter(
      (date) => !findWealthSnapshotByDate(history, date) || replaceExistingDates
    )
  );
  const createdAccounts = [];
  (Array.isArray(preview.newAccounts) ? preview.newAccounts : []).forEach(
    (candidate) => {
      const key = accountKey(candidate);
      if (
        byKey.has(key) ||
        !preview.rows.some(
          (row) => importableDates.has(row.date) && accountKey(row) === key
        )
      ) {
        return;
      }
      const account = normalizeWealthAccount({ id: uuid(), ...candidate });
      accounts.push(account);
      byKey.set(key, account);
      createdAccounts.push(account);
    }
  );
  const importedDates = [];
  const skippedDates = [];
  const replacedDates = [];
  grouped.forEach((rows, date) => {
    const existing = findWealthSnapshotByDate(history, date);
    if (existing && !replaceExistingDates) {
      skippedDates.push(date);
      return;
    }
    const breakdown = rows.map((row) => ({
      accountId: byKey.get(accountKey(row))?.id || '',
      balance: row.balance
    }));
    const composition = rollUpWealthBreakdown(breakdown, accounts);
    if (!composition.complete) {
      skippedDates.push(date);
      return;
    }
    const notes = Array.from(
      new Set(rows.map((row) => row.note).filter(Boolean))
    );
    const snapshot = existing
      ? {
          ...existing,
          date,
          amount: composition.netWorth,
          breakdown,
          note: notes.join(' · ')
        }
      : {
          id: uuid(),
          date,
          amount: composition.netWorth,
          breakdown,
          note: notes.join(' · ')
        };
    const index = existing
      ? history.findIndex((entry) => entry.id === existing.id)
      : -1;
    if (index >= 0) {
      history[index] = snapshot;
      replacedDates.push(date);
    } else {
      history.push(snapshot);
    }
    importedDates.push(date);
  });
  next.wealthAccounts = accounts;
  next.wealthHistory = history.sort(
    (left, right) =>
      parseWealthDate(left.date).getTime() -
      parseWealthDate(right.date).getTime()
  );
  return {
    ok: true,
    state: normalizeWealthData(next),
    importedDates,
    skippedDates,
    replacedDates,
    createdAccounts
  };
}

export const parseWealthCsvPreview = previewWealthCsvImport;
export const importWealthCsv = applyWealthCsvImport;
