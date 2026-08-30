import {
  DEFAULT_CODEX_FOCUS_POLICY,
  normalizeCodexEffort,
  normalizeCodexFastMode,
  normalizeCodexFocusPolicy,
  resolveCodexFocusFactor
} from './policy.mjs';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundFactor(value) {
  return Number(Number(value).toFixed(4));
}

function firstText(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

export function isCodexEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const source = String(entry.source || '').toLowerCase();
  const externalId = String(entry.externalId || '').toLowerCase();
  const description = String(entry.description || '').toLowerCase();
  return (
    source === 'codex' ||
    source.includes('codex') ||
    externalId.startsWith('codex-') ||
    externalId.startsWith('codex:') ||
    description.startsWith('codex:')
  );
}

function getElapsedSeconds(entry, rawRows) {
  const explicit = finiteNumber(entry.elapsedSeconds);
  if (explicit !== null && explicit > 0) {
    return { seconds: explicit, recovered: false };
  }
  const start = Date.parse(String(entry.startTime || ''));
  const end = Date.parse(String(entry.endTime || ''));
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return {
      seconds: Math.floor((end - start) / 1000),
      recovered: true
    };
  }
  const storedWall = finiteNumber(entry.wallSeconds ?? entry.codexWallSeconds);
  if (storedWall !== null && storedWall > 0) {
    return { seconds: storedWall, recovered: true };
  }
  if (rawRows.length === 1) {
    const rowWall = finiteNumber(
      rawRows[0]?.wallSeconds ?? rawRows[0]?.activeSeconds
    );
    if (rowWall !== null && rowWall > 0) {
      return { seconds: rowWall, recovered: true };
    }
  }
  return null;
}

function getRawRows(entry) {
  if (
    Array.isArray(entry.codexModelBreakdown) &&
    entry.codexModelBreakdown.length
  ) {
    return entry.codexModelBreakdown;
  }
  if (Array.isArray(entry.modelBreakdown)) return entry.modelBreakdown;
  if (Array.isArray(entry.codexModelBreakdown))
    return entry.codexModelBreakdown;
  return [];
}

function getRepositoryMultiplier(entry, rawRows, policy) {
  const repositoryName = firstText(
    entry.codexRepoName,
    entry.repoName,
    entry.projectKey,
    entry.repository
  ).toLowerCase();
  const configured = finiteNumber(policy.repositoryMultipliers[repositoryName]);
  if (configured !== null && configured > 0) return configured;

  const storedEntryMultiplier = finiteNumber(entry.repositoryFocusMultiplier);
  if (storedEntryMultiplier !== null && storedEntryMultiplier > 0) {
    return storedEntryMultiplier;
  }
  const storedRow = rawRows.find((row) => {
    const value = finiteNumber(row?.repositoryMultiplier);
    return value !== null && value > 0;
  });
  return storedRow ? finiteNumber(storedRow.repositoryMultiplier) : 1;
}

function getRowWallSeconds(row, rawRows, elapsedSeconds) {
  const explicit = finiteNumber(row?.wallSeconds ?? row?.activeSeconds);
  if (explicit !== null && explicit >= 0) return Math.floor(explicit);
  if (rawRows.length === 1 && elapsedSeconds > 0) {
    return Math.floor(elapsedSeconds);
  }
  return null;
}

function makeInferredRow(entry, elapsedSeconds) {
  return {
    model: firstText(entry.codexModel, entry.model),
    effort: firstText(entry.codexEffort, entry.effort),
    fastMode: entry.codexFastMode ?? entry.fastMode ?? entry.fast_mode,
    role: firstText(entry.codexRole, entry.role),
    wallSeconds: elapsedSeconds
  };
}

function getRowModel(row, entry) {
  return firstText(row?.model, row?.codexModel, entry.codexModel, entry.model);
}

function getRowEffort(row, entry) {
  return normalizeCodexEffort(
    firstText(
      row?.effort,
      row?.reasoningEffort,
      entry.codexEffort,
      entry.effort
    )
  );
}

function getRowFastMode(row, entry) {
  const value =
    row?.fastMode ??
    row?.fast_mode ??
    row?.mode ??
    entry.codexFastMode ??
    entry.fastMode ??
    entry.fast_mode;
  return normalizeCodexFastMode(value, false);
}

function getRowRole(row, entry) {
  const role = firstText(row?.role, entry.codexRole, entry.role).toLowerCase();
  return role === 'subagent' ? 'subagent' : 'parent';
}

function buildBreakdownRows(entry, rawRows, elapsedSeconds, policy) {
  const sourceRows = rawRows.length
    ? rawRows
    : [makeInferredRow(entry, elapsedSeconds)];
  const repositoryMultiplier = getRepositoryMultiplier(entry, rawRows, policy);
  const rows = [];

  for (const sourceRow of sourceRows) {
    const wallSeconds = getRowWallSeconds(
      sourceRow,
      rawRows.length ? rawRows : sourceRows,
      elapsedSeconds
    );
    if (wallSeconds === null) return null;
    const rawModel = getRowModel(sourceRow, entry);
    const model = rawModel || 'unknown';
    const effort = getRowEffort(sourceRow, entry) || 'unknown';
    const fastMode = getRowFastMode(sourceRow, entry);
    const role = getRowRole(sourceRow, entry);
    const resolved = resolveCodexFocusFactor({
      model,
      effort,
      fastMode,
      focusPolicy: policy
    });
    // baseFactor is the existing pre-repository field: model plus Fast mode.
    const baseFactor = resolved.factor;
    const factor = roundFactor(baseFactor * repositoryMultiplier);
    const creditMultiplier = role === 'subagent' ? policy.delegationCredit : 1;
    const creditedFactor = roundFactor(factor * creditMultiplier);
    rows.push({
      ...(sourceRow && typeof sourceRow === 'object' ? sourceRow : {}),
      model,
      effort,
      role,
      fastMode,
      fastModeMultiplier: resolved.fastModeMultiplier,
      baseFactor,
      factor,
      creditMultiplier,
      creditedFactor,
      repositoryMultiplier,
      wallSeconds,
      effectiveSeconds: Math.floor(wallSeconds * creditedFactor)
    });
  }
  return { rows, repositoryMultiplier };
}

function getPatchValue(entry, key, value) {
  return JSON.stringify(entry[key] ?? null) === JSON.stringify(value ?? null)
    ? null
    : value;
}

/**
 * Revalue one imported Codex entry without changing its identity or timing.
 * The returned patch contains only Codex-owned calculated fields.
 */
export function revalueCodexEntry(
  entry,
  focusPolicy = DEFAULT_CODEX_FOCUS_POLICY
) {
  if (!isCodexEntry(entry)) return { status: 'skipped', patch: null };
  const policy = normalizeCodexFocusPolicy(focusPolicy);
  const rawRows = getRawRows(entry);
  const elapsed = getElapsedSeconds(entry, rawRows);
  if (!elapsed || elapsed.seconds <= 0) {
    return { status: 'unable', patch: null, reason: 'missing elapsed time' };
  }
  const breakdown = buildBreakdownRows(entry, rawRows, elapsed.seconds, policy);
  if (!breakdown || !breakdown.rows.length) {
    return {
      status: 'unable',
      patch: null,
      reason: 'missing reliable breakdown wall time'
    };
  }
  const effectiveSeconds = breakdown.rows.reduce(
    (total, row) => total + row.effectiveSeconds,
    0
  );
  const focusFactor = roundFactor(effectiveSeconds / elapsed.seconds);
  const patch = {
    duration: effectiveSeconds,
    focusFactor,
    manualFactor: focusFactor,
    codexFocusPolicyVersion: policy.version,
    codexModelBreakdown: breakdown.rows,
    repositoryFocusMultiplier: breakdown.repositoryMultiplier
  };
  if (
    (entry.elapsedSeconds === undefined ||
      finiteNumber(entry.elapsedSeconds) === null ||
      finiteNumber(entry.elapsedSeconds) <= 0) &&
    elapsed.recovered
  ) {
    patch.elapsedSeconds = elapsed.seconds;
  }
  const changed = Object.keys(patch).some(
    (key) => getPatchValue(entry, key, patch[key]) !== null
  );
  return { status: changed ? 'updated' : 'unchanged', patch };
}

export function migrateCodexEntries(
  entries = [],
  focusPolicy = DEFAULT_CODEX_FOCUS_POLICY
) {
  const policy = normalizeCodexFocusPolicy(focusPolicy);
  let scanned = 0;
  let updated = 0;
  let unable = 0;
  let unchanged = 0;
  const migratedEntries = Array.isArray(entries)
    ? entries.map((entry) => {
        if (!isCodexEntry(entry)) return entry;
        scanned += 1;
        if (Number(entry.codexFocusPolicyVersion) >= policy.version) {
          unchanged += 1;
          return entry;
        }
        const result = revalueCodexEntry(entry, policy);
        if (result.status === 'unable') {
          unable += 1;
          return entry;
        }
        if (result.status === 'updated') {
          updated += 1;
          return { ...entry, ...result.patch };
        }
        unchanged += 1;
        return entry;
      })
    : [];
  return {
    entries: migratedEntries,
    report: {
      version: policy.version,
      scanned,
      updated,
      unable,
      unchanged
    }
  };
}
