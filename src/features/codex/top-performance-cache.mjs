const STORAGE_KEY = 'timekeeperCodexTopPerformanceCacheV1';
const CACHE_VERSION = 1;

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
    if (
      !parsed ||
      parsed.version !== CACHE_VERSION ||
      !parsed.rows ||
      typeof parsed.rows !== 'object'
    ) {
      return null;
    }
    return {
      version: CACHE_VERSION,
      signature: String(parsed.signature || ''),
      computedAt: String(parsed.computedAt || ''),
      rows: {
        7: parsed.rows['7'] || null,
        30: parsed.rows['30'] || null
      }
    };
  } catch {
    return null;
  }
}

export function writeCodexTopPerformanceCache(
  { signature = '', rows = {}, computedAt = new Date().toISOString() } = {},
  storage
) {
  const target = getStorage(storage);
  if (!target) return false;
  try {
    target.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: CACHE_VERSION,
        signature: String(signature || ''),
        computedAt,
        rows: {
          7: rows['7'] || null,
          30: rows['30'] || null
        }
      })
    );
    return true;
  } catch {
    return false;
  }
}
