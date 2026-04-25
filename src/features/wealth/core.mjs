import { uuid } from '../../shared/id.mjs';

/**
 * @typedef {{ x: number, y: number }} RegressionPoint
 * @typedef {{ id?: string, date?: string, amount?: number | string, note?: string }} WealthEntryInput
 * @typedef {{ id: string, date: string, amount: number, note: string }} WealthEntry
 */

const DEFAULT_WEALTH_POINTS = [
  { date: '2020-01-01', amount: 1150000 },
  { date: '2022-01-01', amount: 1280000 },
  { date: '2023-04-25', amount: 1350000 },
  { date: '2024-01-01', amount: 1415000 },
  { date: '2024-01-25', amount: 1488400 },
  { date: '2024-02-26', amount: 1518000 },
  { date: '2024-03-25', amount: 1515000, note: '1,565,000 without taxes' },
  { date: '2024-04-25', amount: 1507000 },
  { date: '2024-05-24', amount: 1567000 },
  { date: '2024-06-25', amount: 1600000 },
  { date: '2024-07-25', amount: 1661000 },
  { date: '2024-08-25', amount: 1629000 },
  { date: '2024-09-25', amount: 1630000 },
  { date: '2024-10-25', amount: 1715000 },
  { date: '2024-11-25', amount: 1773000 },
  { date: '2024-12-23', amount: 1755200 },
  { date: '2025-01-24', amount: 1830000 },
  { date: '2025-09-24', amount: 1931600 },
  { date: '2025-10-24', amount: 1962000 },
  { date: '2025-11-05', amount: 2010000 }
];

export function parseWealthAmount(raw) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, '')
    .replace(/[^0-9.-]/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {WealthEntryInput | null | undefined} entry
 * @returns {WealthEntry}
 */
export function normalizeWealthEntry(entry) {
  const obj = entry && typeof entry === 'object' ? { ...entry } : {};
  return {
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
  return DEFAULT_WEALTH_POINTS.map((point) => normalizeWealthEntry(point));
}

export function makeDefaultWealthGoal() {
  return { amount: 2000000, date: '' };
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
