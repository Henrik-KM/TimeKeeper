export const PRIVATE_BRIDGE_TOKEN_KEY = 'timekeeperPrivateBridgeToken';
export const PRIVATE_BRIDGE_SETTINGS_KEY = 'timekeeperPrivateBridgeSettings';
export const PRIVATE_BRIDGE_DEVICE_ID_KEY = 'timekeeperPrivateBridgeDeviceId';

export const DEFAULT_PRIVATE_BRIDGE_SETTINGS = Object.freeze({
  repository: 'Henrik-KM/timekeeper-private-context',
  branch: 'main'
});

const LEGACY_TOKEN_KEYS = [
  'timekeeperCompanyOperatorToken',
  'timekeeperCodexIntegrationToken'
];

export function migratePrivateBridgeConnection(storage = localStorage) {
  migratePrivateBridgeSettings(storage);
  const current = String(
    storage.getItem(PRIVATE_BRIDGE_TOKEN_KEY) || ''
  ).trim();
  if (current) {
    syncLegacyTokens(storage, current);
    return current;
  }
  for (const key of LEGACY_TOKEN_KEYS) {
    const token = String(storage.getItem(key) || '').trim();
    if (!token) continue;
    storage.setItem(PRIVATE_BRIDGE_TOKEN_KEY, token);
    syncLegacyTokens(storage, token);
    return token;
  }
  return '';
}

function migratePrivateBridgeSettings(storage) {
  if (storage.getItem(PRIVATE_BRIDGE_SETTINGS_KEY)) return;
  const company = readJson(storage, 'timekeeperCompanyOperatorSettings');
  const appData = readJson(storage, 'timekeeperDataPro');
  const codex =
    appData?.codexIntegration && typeof appData.codexIntegration === 'object'
      ? appData.codexIntegration
      : {};
  const repository =
    normalizeRepository(company?.repository) ||
    normalizeRepository(codex.contextRepository);
  const branch =
    cleanText(company?.branch, 120) || cleanText(codex.contextBranch, 120);
  if (!repository && !branch) return;
  storage.setItem(
    PRIVATE_BRIDGE_SETTINGS_KEY,
    JSON.stringify(
      normalizePrivateBridgeSettings({
        repository: repository || DEFAULT_PRIVATE_BRIDGE_SETTINGS.repository,
        branch: branch || DEFAULT_PRIVATE_BRIDGE_SETTINGS.branch
      })
    )
  );
}

export function getPrivateBridgeToken(storage = localStorage) {
  return migratePrivateBridgeConnection(storage);
}

export function savePrivateBridgeToken(token, storage = localStorage) {
  const normalized = String(token || '').trim();
  if (!normalized) {
    storage.removeItem(PRIVATE_BRIDGE_TOKEN_KEY);
    LEGACY_TOKEN_KEYS.forEach((key) => storage.removeItem(key));
    return '';
  }
  storage.setItem(PRIVATE_BRIDGE_TOKEN_KEY, normalized);
  syncLegacyTokens(storage, normalized);
  return normalized;
}

export function normalizePrivateBridgeSettings(value = {}) {
  const source = asRecord(value);
  return {
    repository:
      normalizeRepository(source.repository) ||
      DEFAULT_PRIVATE_BRIDGE_SETTINGS.repository,
    branch:
      cleanText(source.branch, 120) || DEFAULT_PRIVATE_BRIDGE_SETTINGS.branch
  };
}

export function getPrivateBridgeSettings(storage = localStorage) {
  let value = null;
  try {
    value = JSON.parse(storage.getItem(PRIVATE_BRIDGE_SETTINGS_KEY) || 'null');
  } catch {
    value = null;
  }
  return normalizePrivateBridgeSettings(value);
}

export function savePrivateBridgeSettings(value, storage = localStorage) {
  const normalized = normalizePrivateBridgeSettings(value);
  storage.setItem(PRIVATE_BRIDGE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function getPrivateBridgeDeviceId(storage = localStorage, createId) {
  const current = cleanText(storage.getItem(PRIVATE_BRIDGE_DEVICE_ID_KEY), 100);
  if (current) return current;
  const generated = cleanText(createId?.(), 100);
  if (!generated) return '';
  storage.setItem(PRIVATE_BRIDGE_DEVICE_ID_KEY, generated);
  return generated;
}

export function normalizeMobileNotificationConfig(value = {}) {
  const source = asRecord(value);
  const publicKey = cleanText(source.public_key || source.publicKey, 220);
  return {
    available:
      source.available === true && /^[A-Za-z0-9_-]{40,200}$/.test(publicKey),
    publicKey,
    subscriptionsPath: normalizePath(
      source.subscriptions_path || source.subscriptionsPath,
      'mobile-notifications/subscriptions.json'
    ),
    weekdayTime:
      cleanText(source.weekday_time || source.weekdayTime, 8) || '07:45',
    lateUntil: cleanText(source.late_until || source.lateUntil, 8) || '10:00',
    timezone: cleanText(source.timezone, 80) || 'Europe/Berlin',
    quietHours: Array.isArray(source.quiet_hours || source.quietHours)
      ? (source.quiet_hours || source.quietHours)
          .map((item) => cleanText(item, 20))
          .filter(Boolean)
          .slice(0, 4)
      : ['20:00-07:00'],
    privacyMode:
      cleanText(source.privacy_mode || source.privacyMode, 40) || 'private'
  };
}

export function normalizePushSubscriptionDocument(value = {}) {
  const source = asRecord(value);
  const rows = Array.isArray(source.subscriptions) ? source.subscriptions : [];
  return {
    schema_version: 1,
    updated_at: cleanText(source.updated_at, 80),
    subscriptions: rows
      .map(normalizePushSubscription)
      .filter(Boolean)
      .slice(-10)
  };
}

/**
 * @param {any} subscription
 * @param {{deviceId?: string, now?: Date}} options
 */
export function pushSubscriptionToDocumentRow(
  subscription,
  { deviceId, now = new Date() } = {}
) {
  const json = subscription?.toJSON?.() || subscription || {};
  const keys = json.keys && typeof json.keys === 'object' ? json.keys : {};
  return normalizePushSubscription({
    device_id: deviceId,
    enabled: true,
    endpoint: json.endpoint,
    expiration_time: json.expirationTime,
    keys,
    updated_at: now.toISOString()
  });
}

export function upsertPushSubscription(document, row) {
  const normalized = normalizePushSubscriptionDocument(document);
  const next = normalizePushSubscription(row);
  if (!next) return normalized;
  const rows = normalized.subscriptions.filter(
    (item) =>
      item.device_id !== next.device_id && item.endpoint !== next.endpoint
  );
  rows.push(next);
  return {
    schema_version: 1,
    updated_at: next.updated_at,
    subscriptions: rows.slice(-10)
  };
}

export function disablePushSubscription(document, deviceId, now = new Date()) {
  const normalized = normalizePushSubscriptionDocument(document);
  return {
    schema_version: 1,
    updated_at: now.toISOString(),
    subscriptions: normalized.subscriptions.map((item) =>
      item.device_id === deviceId
        ? { ...item, enabled: false, updated_at: now.toISOString() }
        : item
    )
  };
}

export function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (String(value).length % 4)) % 4);
  const base64 = `${String(value)}${padding}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function normalizePushSubscription(value) {
  const source = asRecord(value);
  const keys = asRecord(source.keys);
  const endpoint = cleanText(source.endpoint, 2000);
  const deviceId = cleanText(source.device_id || source.deviceId, 100);
  const p256dh = cleanText(keys.p256dh, 512);
  const auth = cleanText(keys.auth, 256);
  if (!endpoint.startsWith('https://') || !deviceId || !p256dh || !auth) {
    return null;
  }
  return {
    device_id: deviceId,
    enabled: source.enabled === true,
    endpoint,
    expiration_time: source.expiration_time ?? source.expirationTime ?? null,
    keys: { p256dh, auth },
    updated_at: cleanText(source.updated_at || source.updatedAt, 80)
  };
}

function syncLegacyTokens(storage, token) {
  LEGACY_TOKEN_KEYS.forEach((key) => {
    if (storage.getItem(key) !== token) storage.setItem(key, token);
  });
}

function readJson(storage, key) {
  try {
    return asRecord(JSON.parse(storage.getItem(key) || 'null'));
  } catch {
    return {};
  }
}

function normalizeRepository(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : '';
}

function normalizePath(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  return normalized || fallback;
}

function cleanText(value, limit) {
  return [...String(value || '')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** @returns {Record<string, any>} */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}
