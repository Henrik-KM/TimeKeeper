import { uuid } from '../../shared/id.mjs';

export const CLAUDE_INBOX_PATH = 'assets/timekeeper-claude-inbox';

/** @param {Record<string, any>} value */
export function normalizeClaudeIntegration(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: input.enabled === true,
    inboxPath: CLAUDE_INBOX_PATH,
    retractedRecordIds: normalizeRecordIds(input.retractedRecordIds),
    lastImportAt:
      typeof input.lastImportAt === 'string' ? input.lastImportAt : null,
    lastImportSummary:
      input.lastImportSummary && typeof input.lastImportSummary === 'object'
        ? input.lastImportSummary
        : null
  };
}

function normalizeRecordIds(ids) {
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id || '').trim())
        .filter((id) => /^claude:[0-9a-f]{32}$/.test(id))
    )
  ];
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
  now = new Date(),
  { allowHistorical = false } = {}
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
    (!allowHistorical && start < windowStart) ||
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

/** @param {{ entries?: any[], payloads?: any[], retractedExternalIds?: string[], minimumPolicyVersion?: number, activeProjectIds?: Set<string>, windowStart?: Date, now?: Date, createId?: () => string }} options */
export function importClaudeInboxRecords({
  entries = [],
  payloads = [],
  retractedExternalIds = [],
  minimumPolicyVersion = 1,
  activeProjectIds = new Set(),
  windowStart,
  now = new Date(),
  createId = uuid
} = {}) {
  const validPayloads = payloads.filter(
    (payload) =>
      payload?.source === 'timekeeper-claude-bridge' &&
      Array.isArray(payload.records)
  );
  const retractedIds = new Set(
    normalizeRecordIds([
      ...retractedExternalIds,
      ...validPayloads.flatMap((payload) =>
        Number(payload.focusPolicyVersion) >= 2 &&
        Array.isArray(payload.retractedExternalIds)
          ? payload.retractedExternalIds
          : []
      )
    ])
  );
  const next = entries.filter(
    (entry) =>
      !(entry.source === 'claude' && retractedIds.has(entry.externalId))
  );
  const reconciled = entries.length - next.length;
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = payloads.length - validPayloads.length;
  const candidates = validPayloads
    .flatMap((payload) =>
      payload.records.map((raw) => ({
        raw,
        updatedAt: validTimestamp(payload.updatedAt)?.toISOString() || null
      }))
    )
    .sort(
      (left, right) =>
        (Number(left.raw?.focusPolicyVersion) || 1) -
          (Number(right.raw?.focusPolicyVersion) || 1) ||
        Date.parse(left.updatedAt || '1970-01-01') -
          Date.parse(right.updatedAt || '1970-01-01')
    );
  for (const { raw, updatedAt } of candidates) {
    const existing = next.find(
      (entry) => entry.source === 'claude' && entry.externalId === raw?.id
    );
    if (
      (Number(raw?.focusPolicyVersion) || 1) < minimumPolicyVersion ||
      retractedIds.has(raw?.id) ||
      (raw?.repairOnly && !existing)
    ) {
      skipped += 1;
      continue;
    }
    const normalized = validateClaudeRecord(
      raw,
      activeProjectIds,
      windowStart,
      now,
      { allowHistorical: Boolean(existing) }
    );
    if (!normalized) {
      skipped += 1;
      continue;
    }
    if (updatedAt) normalized.claudeRecordUpdatedAt = updatedAt;
    if (existing) {
      const oldVersion = Number(existing.claudeFocusPolicyVersion) || 1;
      if (
        normalized.claudeFocusPolicyVersion < oldVersion ||
        (normalized.claudeFocusPolicyVersion === oldVersion &&
          Date.parse(existing.claudeRecordUpdatedAt || '') >
            Date.parse(updatedAt || '1970-01-01'))
      ) {
        skipped += 1;
        continue;
      }
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
  return {
    entries: next,
    imported,
    updated,
    unchanged,
    skipped,
    reconciled,
    retractedExternalIds: [...retractedIds]
  };
}
