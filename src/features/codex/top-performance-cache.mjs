const STORAGE_KEY = 'timekeeperCodexTopPerformanceCacheV1';
const CACHE_VERSION = 2;

function normalizeRows(value) {
  if (Array.isArray(value)) {
    return value.filter((row) => row && typeof row === 'object').slice(0, 3);
  }
  return value && typeof value === 'object' ? [value] : [];
}

function normalizeRangeRows(source = {}) {
  return {
    7: normalizeRows(source['7']),
    30: normalizeRows(source['30'])
  };
}

function getStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function getCodexAnalyticsDataSignature(data = {}) {
  const integration = data?.codexIntegration || {};
  const usageLimits =
    integration.usageLimits ||
    integration.lastUsageLimits ||
    data?.codexUsageLimits ||
    {};
  const primary = usageLimits.primary || {};
  return [
    data?.updatedAt || '',
    data?.entries?.length || 0,
    primary.usedPercent ?? '',
    primary.remainingPercent ?? '',
    primary.windowMinutes ?? '',
    primary.resetsAt || ''
  ].join('|');
}

export function readCodexTopPerformanceCache(storage) {
  const target = getStorage(storage);
  if (!target) return null;
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) || 'null');
    if (!parsed || ![1, CACHE_VERSION].includes(parsed.version)) {
      return null;
    }
    const topRows = normalizeRangeRows(parsed.topRows || parsed.rows);
    return {
      version: parsed.version,
      signature: String(parsed.signature || ''),
      computedAt: String(parsed.computedAt || ''),
      topRows,
      rows: {
        7: topRows['7'][0] || null,
        30: topRows['30'][0] || null
      }
    };
  } catch {
    return null;
  }
}

export function writeCodexTopPerformanceCache(
  {
    signature = '',
    topRows = null,
    rows = {},
    computedAt = new Date().toISOString()
  } = {},
  storage
) {
  const target = getStorage(storage);
  if (!target) return false;
  try {
    const normalizedTopRows = normalizeRangeRows(topRows || rows);
    target.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: CACHE_VERSION,
        signature: String(signature || ''),
        computedAt,
        topRows: normalizedTopRows,
        rows: {
          7: normalizedTopRows['7'][0] || null,
          30: normalizedTopRows['30'][0] || null
        }
      })
    );
    return true;
  } catch {
    return false;
  }
}
