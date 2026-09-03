// @ts-nocheck

import { uuid } from '../../shared/id.mjs';

export const WEALTH_SCHEMA_VERSION = 3;
export const WEALTH_ACCOUNT_KINDS = ['asset', 'liability'];
export const WEALTH_DEFAULT_STALE_AFTER_DAYS = 45;
export const WEALTH_DAYS_PER_YEAR = 365.2425;
export const WEALTH_TRAILING_MONTHS = 18;
export const WEALTH_MIN_PACE_SNAPSHOTS = 3;
export const WEALTH_MIN_PACE_SPAN_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;

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
  return { amount: null, date: '' };
}

export function normalizeWealthGoal(goal) {
  const obj = isObject(goal) ? { ...goal } : {};
  const normalized = {
    ...obj,
    amount: hasOwn(obj, 'amount')
      ? parseOptionalWealthAmount(obj.amount)
      : null,
    date: normalizeText(obj.date)
  };
  if (normalized.amount !== null && normalized.amount < 0) {
    normalized.amount = null;
  }
  return normalized;
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
    !Number.isFinite(sourceSchemaVersion) || sourceSchemaVersion < 2;
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
  const now =
    isObject(goalOptions) && goalOptions.now ? goalOptions.now : new Date();
  const parsedDate = date ? parseWealthDate(date) : null;
  if (!date || !parsedDate) {
    return { ok: false, reason: 'date' };
  }
  if (parsedDate && startOfDay(toValidDate(now)) >= parsedDate) {
    return { ok: false, reason: 'date-past' };
  }
  return { ok: true, goal: { amount, date } };
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

export function getLatestWealthSnapshot(
  history,
  { now = new Date(), includeFuture = false } = {}
) {
  const valid = includeFuture
    ? getValidWealthHistory(history)
    : getPastWealthSnapshots(history, now).snapshots;
  return valid.length ? valid[valid.length - 1] : null;
}

export function getPreviousWealthSnapshot(
  history,
  latest = null,
  { now = new Date() } = {}
) {
  const valid = getPastWealthSnapshots(history, now).snapshots;
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

function calendarDayNumber(value) {
  const date = value instanceof Date ? value : parseWealthDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function calendarDaysBetween(later, earlier) {
  const laterDay = calendarDayNumber(later);
  const earlierDay = calendarDayNumber(earlier);
  return laterDay === null || earlierDay === null
    ? null
    : laterDay - earlierDay;
}

export function calculateWealthFreshness(
  history,
  now = new Date(),
  settings = {}
) {
  const latest = getLatestWealthSnapshot(history, { now });
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
  const ageDays = Math.max(0, calendarDaysBetween(now, latestDate) || 0);
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
      calendarDaysBetween(currentDate, previousDate) || 0
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
  const valid = getPastWealthSnapshots(history, now).snapshots;
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
  const pace = calculateObservedWealthPace(history, {
    now,
    range,
    settings
  });
  const freshness = calculateWealthFreshness(history, now, settings);
  if (!pace.available) {
    return {
      available: false,
      canProject: false,
      reason: 'insufficient-history',
      label:
        'Historical trend diagnostic needs three snapshots spanning 90 days.',
      freshness,
      pace
    };
  }
  const points = pace.snapshots.map((entry) => ({
    x: calendarDaysBetween(entry.date, pace.snapshots[0].date),
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
    monthlyChange: regression
      ? regression.slope * (WEALTH_DAYS_PER_YEAR / 12)
      : null,
    regression,
    freshness,
    pace
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

function toValidDate(value, fallback = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value);
  }
  const parsed = parseWealthDate(value);
  return parsed || new Date(fallback);
}

function subtractClampedMonths(date, months) {
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
  result.setHours(0, 0, 0, 0);
  return result;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function getPastWealthSnapshots(history, now = new Date()) {
  const today = startOfDay(toValidDate(now));
  const todayTime = today.getTime();
  const byDate = new Map();
  const duplicateDates = new Set();
  const futureSnapshots = [];
  getValidWealthHistory(history).forEach((entry) => {
    const date = parseWealthDate(entry.date);
    if (!date) return;
    if (date.getTime() > todayTime) {
      futureSnapshots.push(entry);
      return;
    }
    if (byDate.has(entry.date)) duplicateDates.add(entry.date);
    byDate.set(entry.date, entry);
  });
  return {
    snapshots: Array.from(byDate.values()).sort(
      (left, right) =>
        parseWealthDate(left.date).getTime() -
        parseWealthDate(right.date).getTime()
    ),
    futureSnapshots,
    duplicateDates: Array.from(duplicateDates)
  };
}

export function getFutureWealthSnapshots(history, now = new Date()) {
  return getPastWealthSnapshots(history, now).futureSnapshots;
}

function hasPaceCoverage(snapshots, minSnapshots, minSpanDays) {
  if (snapshots.length < minSnapshots) return false;
  const first = parseWealthDate(snapshots[0].date);
  const last = parseWealthDate(snapshots[snapshots.length - 1].date);
  const spanDays = calendarDaysBetween(last, first);
  return !!first && !!last && spanDays >= minSpanDays;
}

function buildPairwiseSlopes(snapshots) {
  const pairs = [];
  for (let left = 0; left < snapshots.length; left += 1) {
    const leftDate = parseWealthDate(snapshots[left].date);
    for (let right = left + 1; right < snapshots.length; right += 1) {
      const rightDate = parseWealthDate(snapshots[right].date);
      const days = calendarDaysBetween(rightDate, leftDate);
      if (days <= 0) continue;
      pairs.push({
        fromDate: snapshots[left].date,
        toDate: snapshots[right].date,
        days,
        slopePerDay: (snapshots[right].amount - snapshots[left].amount) / days
      });
    }
  }
  return pairs;
}

/**
 * Estimate net-worth pace from robust pairwise slopes. Contributions,
 * investment movement, property, cash, and debt are intentionally treated as
 * one recorded net-worth trajectory.
 */
export function calculateObservedWealthPace(
  history,
  {
    now = new Date(),
    trailingMonths = WEALTH_TRAILING_MONTHS,
    minSnapshots = WEALTH_MIN_PACE_SNAPSHOTS,
    minSpanDays = WEALTH_MIN_PACE_SPAN_DAYS
  } = {}
) {
  const today = startOfDay(toValidDate(now));
  const {
    snapshots: allSnapshots,
    futureSnapshots,
    duplicateDates
  } = getPastWealthSnapshots(history, today);
  const latestSnapshot = allSnapshots.at(-1) || null;
  const trailingBoundary = subtractClampedMonths(today, -trailingMonths);
  const trailingSnapshots = allSnapshots.filter(
    (entry) =>
      parseWealthDate(entry.date).getTime() >= trailingBoundary.getTime()
  );
  const trailingHasCoverage = hasPaceCoverage(
    trailingSnapshots,
    minSnapshots,
    minSpanDays
  );
  const allHasCoverage = hasPaceCoverage(
    allSnapshots,
    minSnapshots,
    minSpanDays
  );
  const snapshots = trailingHasCoverage
    ? trailingSnapshots
    : allHasCoverage
      ? allSnapshots
      : trailingSnapshots.length
        ? trailingSnapshots
        : allSnapshots;
  const source = trailingHasCoverage
    ? 'trailing-18-months'
    : allHasCoverage
      ? 'all-history-fallback'
      : 'insufficient-history';
  const pairwiseSlopes = buildPairwiseSlopes(snapshots);
  const slopeValues = pairwiseSlopes.map((pair) => pair.slopePerDay);
  const available = trailingHasCoverage || allHasCoverage;
  const slopePerDay = available ? percentile(slopeValues, 0.5) : null;
  const lowerSlopePerDay = available ? percentile(slopeValues, 0.25) : null;
  const upperSlopePerDay = available ? percentile(slopeValues, 0.75) : null;
  const latestRecordedAmount = latestSnapshot?.amount ?? null;
  const daysSinceLatest = latestSnapshot
    ? Math.max(0, calendarDaysBetween(today, latestSnapshot.date) || 0)
    : null;
  const annualGrowthSek = available ? slopePerDay * WEALTH_DAYS_PER_YEAR : null;
  const annualGrowthPercent =
    available && latestRecordedAmount !== 0
      ? annualGrowthSek / latestRecordedAmount
      : null;
  const observedMonthlyGrowth = available
    ? annualGrowthSek / MONTHS_PER_YEAR
    : null;
  const estimatedToday = latestSnapshot
    ? latestRecordedAmount + (available ? slopePerDay * daysSinceLatest : 0)
    : null;
  return {
    available,
    reason: available ? null : 'insufficient-history',
    source,
    snapshots,
    allSnapshots,
    trailingSnapshots,
    futureSnapshots,
    duplicateDates,
    latestSnapshot,
    latestRecordedAmount,
    latestRecordedDate: latestSnapshot?.date || '',
    daysSinceLatest,
    spanDays:
      snapshots.length >= 2
        ? calendarDaysBetween(snapshots.at(-1).date, snapshots[0].date)
        : 0,
    snapshotCount: snapshots.length,
    pairwiseSlopes,
    slopes: slopeValues,
    slopePerDay,
    lowerSlopePerDay,
    upperSlopePerDay,
    annualGrowthSek,
    annualGrowthPercent,
    observedMonthlyGrowth,
    lowerMonthlyGrowth: available
      ? (lowerSlopePerDay * WEALTH_DAYS_PER_YEAR) / MONTHS_PER_YEAR
      : null,
    upperMonthlyGrowth: available
      ? (upperSlopePerDay * WEALTH_DAYS_PER_YEAR) / MONTHS_PER_YEAR
      : null,
    estimatedToday,
    minSnapshots,
    minSpanDays,
    trailingMonths
  };
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatRoundedDate(date) {
  return formatWealthDate(startOfDay(date));
}

function calculateEstimatedGoalDate(today, amount, goalAmount, slopePerDay) {
  if (!Number.isFinite(amount) || !Number.isFinite(goalAmount)) return null;
  if (amount >= goalAmount) return formatRoundedDate(today);
  if (!Number.isFinite(slopePerDay) || slopePerDay <= 0) return null;
  const days = (goalAmount - amount) / slopePerDay;
  if (!Number.isFinite(days) || days < 0 || days > 3652425) return null;
  return formatRoundedDate(addDays(today, days));
}

export function calculateWealthGoalTrajectory(
  history,
  goal,
  { now = new Date(), pace: suppliedPace = null } = {}
) {
  const normalizedGoal = normalizeWealthGoal(goal);
  const today = startOfDay(toValidDate(now));
  const pace =
    suppliedPace || calculateObservedWealthPace(history, { now: today });
  const latest = pace.latestSnapshot;
  const goalAmount = normalizedGoal.amount;
  const goalDate = parseWealthDate(normalizedGoal.date);
  const base = {
    available: false,
    goal: normalizedGoal,
    goalAmount,
    goalDate: normalizedGoal.date,
    today: formatWealthDate(today),
    latestSnapshot: latest,
    latestRecordedAmount: pace.latestRecordedAmount,
    futureSnapshots: pace.futureSnapshots,
    observedPace: pace,
    paceAvailable: pace.available,
    status: 'no-goal',
    reason: null,
    estimatedToday: pace.estimatedToday,
    annualGrowthSek: pace.annualGrowthSek,
    annualGrowthPercent: pace.annualGrowthPercent,
    projectedAtGoal: null,
    projectedShortfallOrSurplus: null,
    requiredAnnualGrowth: null,
    requiredMonthlyGrowth: null,
    additionalMonthlyPace: null,
    estimatedGoalDateAtCurrentPace: null,
    yearsRemaining: null,
    monthsRemaining: null,
    daysToGoal: null,
    historicalPaceRange: pace.available
      ? {
          lowerMonthlyGrowth: pace.lowerMonthlyGrowth,
          upperMonthlyGrowth: pace.upperMonthlyGrowth,
          lowerSlopePerDay: pace.lowerSlopePerDay,
          upperSlopePerDay: pace.upperSlopePerDay
        }
      : null,
    uncertaintyAtGoal: null
  };
  if (goalAmount === null || !Number.isFinite(goalAmount) || goalAmount <= 0) {
    base.reason = 'missing-goal-amount';
    return base;
  }
  if (!normalizedGoal.date) {
    base.reason = 'missing-goal-date';
    return base;
  }
  if (!goalDate) {
    base.reason = 'invalid-goal-date';
    return base;
  }
  if (goalDate.getTime() <= today.getTime()) {
    base.reason = 'expired-goal';
    base.status = 'expired';
    return base;
  }
  if (!latest) {
    base.reason = 'insufficient-history';
    base.status = 'insufficient-history';
    return base;
  }
  const estimatedToday =
    pace.estimatedToday === null ? latest.amount : pace.estimatedToday;
  const daysToGoal = calendarDaysBetween(goalDate, today);
  const yearsRemaining = daysToGoal / WEALTH_DAYS_PER_YEAR;
  const monthsRemaining = yearsRemaining * MONTHS_PER_YEAR;
  const requiredAnnualGrowth = (goalAmount - estimatedToday) / yearsRemaining;
  const requiredMonthlyGrowth = requiredAnnualGrowth / MONTHS_PER_YEAR;
  const projectedAtGoal = pace.available
    ? pace.latestRecordedAmount +
      pace.slopePerDay * calendarDaysBetween(goalDate, latest.date)
    : null;
  const projectedShortfallOrSurplus =
    projectedAtGoal === null ? null : projectedAtGoal - goalAmount;
  const estimatedGoalDateAtCurrentPace = calculateEstimatedGoalDate(
    today,
    estimatedToday,
    goalAmount,
    pace.slopePerDay
  );
  const additionalMonthlyPace = pace.available
    ? requiredMonthlyGrowth - pace.observedMonthlyGrowth
    : null;
  const uncertaintyAtGoal = pace.available
    ? {
        lower:
          pace.latestRecordedAmount +
          pace.lowerSlopePerDay * calendarDaysBetween(goalDate, latest.date),
        upper:
          pace.latestRecordedAmount +
          pace.upperSlopePerDay * calendarDaysBetween(goalDate, latest.date)
      }
    : null;
  const status =
    estimatedToday >= goalAmount
      ? 'achieved'
      : !pace.available
        ? 'insufficient-history'
        : projectedAtGoal >= goalAmount
          ? 'on-track'
          : 'shortfall';
  return {
    ...base,
    available: true,
    reason: null,
    status,
    goalDate: formatWealthDate(goalDate),
    estimatedToday,
    projectedAtGoal,
    projectedShortfallOrSurplus,
    requiredAnnualGrowth,
    requiredMonthlyGrowth,
    additionalMonthlyPace,
    estimatedGoalDateAtCurrentPace,
    yearsRemaining,
    monthsRemaining,
    daysToGoal,
    uncertaintyAtGoal
  };
}

/** Build every Wealth graph series and its domain from the same trajectory values used by the cards. */
export function buildWealthGoalChartSeries(
  history,
  goal,
  { now = new Date(), range = 'one-year', pace = null } = {}
) {
  const today = startOfDay(toValidDate(now));
  const trajectory = calculateWealthGoalTrajectory(history, goal, {
    now: today,
    pace
  });
  const selectedHistory = getWealthHistoryRange(history, range, today);
  const latest = trajectory.latestSnapshot;
  const recorded = selectedHistory.slice();
  const recordedData = recorded.map((entry) => ({
    x: parseWealthDate(entry.date).getTime(),
    y: entry.amount
  }));
  const latestDate = latest ? parseWealthDate(latest.date) : null;
  const goalDate = parseWealthDate(trajectory.goalDate);
  const goalIsUsable = !!goalDate && trajectory.reason !== 'expired-goal';
  const goalPoint = goalIsUsable
    ? [{ x: goalDate.getTime(), y: trajectory.goalAmount }]
    : goalDate && trajectory.goalAmount !== null
      ? [{ x: goalDate.getTime(), y: trajectory.goalAmount }]
      : [];
  const observedData =
    trajectory.paceAvailable && latestDate && goalIsUsable
      ? [
          { x: latestDate.getTime(), y: trajectory.latestRecordedAmount },
          { x: goalDate.getTime(), y: trajectory.projectedAtGoal }
        ]
      : latestDate
        ? [{ x: latestDate.getTime(), y: trajectory.latestRecordedAmount }]
        : [];
  const requiredData =
    trajectory.available && goalIsUsable
      ? [
          { x: today.getTime(), y: trajectory.estimatedToday },
          { x: goalDate.getTime(), y: trajectory.goalAmount }
        ]
      : goalIsUsable && trajectory.goalAmount !== null
        ? [{ x: goalDate.getTime(), y: trajectory.goalAmount }]
        : [];
  const lowerData =
    trajectory.uncertaintyAtGoal && latestDate && goalIsUsable
      ? [
          { x: latestDate.getTime(), y: trajectory.latestRecordedAmount },
          { x: goalDate.getTime(), y: trajectory.uncertaintyAtGoal.lower }
        ]
      : [];
  const upperData =
    trajectory.uncertaintyAtGoal && latestDate && goalIsUsable
      ? [
          { x: latestDate.getTime(), y: trajectory.latestRecordedAmount },
          { x: goalDate.getTime(), y: trajectory.uncertaintyAtGoal.upper }
        ]
      : [];
  const allPoints = [
    ...recordedData,
    ...observedData,
    ...requiredData,
    ...goalPoint,
    ...lowerData,
    ...upperData
  ];
  const xValues = allPoints.map((point) => point.x).filter(Number.isFinite);
  const xMin = xValues.length
    ? Math.min(...xValues, today.getTime())
    : today.getTime();
  const xMax = goalIsUsable
    ? Math.max(goalDate.getTime(), today.getTime())
    : xValues.length
      ? Math.max(...xValues)
      : today.getTime();
  const rangeLabel =
    range === 'one-year'
      ? 'the last year'
      : range === 'three-year'
        ? 'the last three years'
        : 'all recorded time';
  return {
    range,
    rangeLabel,
    trajectory,
    selectedHistory,
    recorded,
    xMin,
    xMax,
    datasets: [
      {
        key: 'recorded',
        label: 'Recorded wealth',
        data: recordedData,
        style: 'solid'
      },
      {
        key: 'projected',
        label: 'Current data-derived trajectory',
        data: observedData,
        style: 'dashed'
      },
      {
        key: 'required',
        label: 'Required trajectory',
        data: requiredData,
        style: 'dashed'
      },
      {
        key: 'goal',
        label: 'Goal',
        data: goalPoint,
        style: 'marker'
      },
      {
        key: 'pace-lower',
        label: 'Historical pace range (lower)',
        data: lowerData,
        style: 'band-lower'
      },
      {
        key: 'pace-upper',
        label: 'Historical pace range (upper)',
        data: upperData,
        style: 'band-upper'
      }
    ]
  };
}

export const buildWealthChartSeries = buildWealthGoalChartSeries;

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
