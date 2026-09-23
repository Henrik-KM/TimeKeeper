import { uuid } from '../../shared/id.mjs';

export const CLAUDE_INBOX_PATH = 'assets/timekeeper-claude-inbox';

/** @param {Record<string, any>} value */
export function normalizeClaudeIntegration(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: input.enabled === true,
    inboxPath: CLAUDE_INBOX_PATH,
    lastImportAt:
      typeof input.lastImportAt === 'string' ? input.lastImportAt : null,
    lastImportSummary:
      input.lastImportSummary && typeof input.lastImportSummary === 'object'
        ? input.lastImportSummary
        : null
  };
}

function validTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && Number.isInteger(number)
    ? number
    : null;
}

export function validateClaudeRecord(
  record,
  activeProjectIds,
  windowStart,
  now = new Date()
) {
  if (!record || typeof record !== 'object') return null;
  const externalId = String(record.id || '');
  const projectId = String(record.timekeeperProjectId || '');
  const sessionId = String(record.sessionId || '');
  const start = validTimestamp(record.startTime);
  const end = validTimestamp(record.endTime);
  const elapsedSeconds = nonNegativeInteger(record.wallSeconds);
  const duration = nonNegativeInteger(record.effectiveSeconds);
  const delegatedCount = nonNegativeInteger(record.delegatedSessionCount);
  if (
    !/^claude:[0-9a-f]{32}$/.test(externalId) ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId) ||
    !activeProjectIds.has(projectId) ||
    !start ||
    !end ||
    end <= start ||
    start < windowStart ||
    start > now ||
    end > now ||
    elapsedSeconds === null ||
    elapsedSeconds <= 0 ||
    elapsedSeconds > (end.getTime() - start.getTime()) / 1000 ||
    duration === null ||
    duration <= 0 ||
    delegatedCount === null
  )
    return null;
  const breakdown = Array.isArray(record.modelBreakdown)
    ? record.modelBreakdown
    : [];
  if (
    !breakdown.length ||
    breakdown.length > 20 ||
    breakdown.some(
      (row) =>
        !row ||
        !['parent', 'subagent'].includes(row.role) ||
        !['fable', 'opus', 'sonnet', 'haiku', 'unknown'].includes(row.model) ||
        nonNegativeInteger(row.wallSeconds) === null ||
        nonNegativeInteger(row.effectiveSeconds) === null ||
        !Number.isFinite(Number(row.factor)) ||
        !Number.isFinite(Number(row.creditedFactor))
    )
  )
    return null;
  const repoName = String(record.repoName || '').trim();
  const safeRepoName = /^[\p{L}\p{N}_. -]{1,80}$/u.test(repoName)
    ? repoName
    : '';
  const focusFactor = duration / elapsedSeconds;
  return {
    externalId,
    projectId,
    claudeSessionId: sessionId,
    description: safeRepoName ? `Claude: ${safeRepoName}` : 'Claude work',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    elapsedSeconds,
    duration,
    focusFactor,
    manualFactor: focusFactor,
    claudeModelBreakdown: breakdown.map((row) => ({
      role: row.role,
      model: row.model,
      factor: Number(row.factor),
      creditMultiplier: Number(row.creditMultiplier) || 0,
      creditedFactor: Number(row.creditedFactor),
      wallSeconds: row.wallSeconds,
      effectiveSeconds: row.effectiveSeconds
    })),
    claudeDelegatedSessionCount: delegatedCount,
    claudeFocusPolicyVersion: Math.max(
      1,
      Math.floor(Number(record.focusPolicyVersion) || 1)
    )
  };
}

/** @param {{ entries?: any[], payloads?: any[], activeProjectIds?: Set<string>, windowStart?: Date, now?: Date, createId?: () => string }} options */
export function importClaudeInboxRecords({
  entries = [],
  payloads = [],
  activeProjectIds = new Set(),
  windowStart,
  now = new Date(),
  createId = uuid
} = {}) {
  const next = [...entries];
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const payload of payloads) {
    if (
      payload?.source !== 'timekeeper-claude-bridge' ||
      !Array.isArray(payload.records)
    ) {
      skipped += 1;
      continue;
    }
    for (const raw of payload.records) {
      const normalized = validateClaudeRecord(
        raw,
        activeProjectIds,
        windowStart,
        now
      );
      if (!normalized) {
        skipped += 1;
        continue;
      }
      const existing = next.find(
        (entry) =>
          entry.source === 'claude' &&
          entry.externalId === normalized.externalId
      );
      if (existing) {
        const changed = Object.entries(normalized).some(
          ([key, value]) =>
            JSON.stringify(existing[key] ?? null) !==
            JSON.stringify(value ?? null)
        );
        if (changed) {
          Object.assign(existing, normalized);
          updated += 1;
        } else {
          unchanged += 1;
        }
      } else {
        next.push({
          id: createId(),
          source: 'claude',
          isRunning: false,
          createdAt: now.toISOString(),
          ...normalized
        });
        imported += 1;
      }
    }
  }
  return { entries: next, imported, updated, unchanged, skipped };
}
