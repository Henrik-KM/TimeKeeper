import { uuid } from '../../shared/id.mjs';

/**
 * @typedef {{ x: number, y: number }} RegressionPoint
 * @typedef {{ [key: string]: unknown, id?: string, date?: string, amount?: number | string, note?: string }} WealthEntryInput
 * @typedef {{ id: string, date: string, amount: number, note: string }} WealthEntry
 */

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

/**
 * @param {WealthEntryInput | null | undefined} entry
 * @returns {WealthEntry}
 */
export function normalizeWealthEntry(entry) {
  const obj = entry && typeof entry === 'object' ? { ...entry } : {};
  return {
    ...obj,
    id: obj.id || uuid(),
    date: typeof obj.date === 'string' ? obj.date.trim() : '',
    amount: parseWealthAmount(obj.amount),
    note: typeof obj.note === 'string' ? obj.note : ''
  };
}

/**
 * @returns {WealthEntry[]}
 */
export function getDefaultWealthHistory() {
  return [];
}

export function makeDefaultWealthGoal() {
  return { amount: 2000000, date: '' };
}

export function validateWealthGoal(amountRaw, dateRaw = '') {
  const amount = parseOptionalWealthAmount(amountRaw);
  if (amount === null || amount <= 0) {
    return { ok: false, reason: 'amount' };
  }
  const date = String(dateRaw || '').trim();
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, reason: 'date' };
    }
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return { ok: false, reason: 'date' };
    }
  }
  return { ok: true, goal: { amount, date } };
}

/**
 * @param {RegressionPoint[]} points
 */
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
