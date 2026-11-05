export function normalizeCodexRecordIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => /^codex[-:]/.test(id))
    )
  ];
}

export function normalizeCodexCorrections(value) {
  return (Array.isArray(value) ? value : []).filter(
    (item) =>
      item &&
      typeof item.entryId === 'string' &&
      typeof item.replacementEntryId === 'string' &&
      item.entryId !== item.replacementEntryId &&
      typeof item.projectId === 'string' &&
      Number.isFinite(Date.parse(item.startTime)) &&
      Number.isFinite(Date.parse(item.endTime)) &&
      Number.isFinite(item.effectiveSeconds) &&
      ['duplicate', 'superseded'].includes(item.reason)
  );
}

function isManagedEntry(entry) {
  const source = String(entry?.source || '').toLowerCase();
  if (source) return source === 'codex';
  return /^codex[-:]/.test(String(entry?.externalId || ''));
}

function rank(entry) {
  return [
    Number(entry.codexFocusPolicyVersion) || 0,
    Date.parse(entry.codexRecordUpdatedAt || '') || 0,
    Number(entry.codexDelegatedSessionCount) || 0
  ];
}

function prefer(left, right) {
  const a = rank(left);
  const b = rank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? left : right;
  }
  return left;
}

function isAggregate(entry) {
  return entry.codexIsAggregate || entry.codexDelegatedSessionCount > 0;
}

function hasContinuousTiming(entry) {
  const span = (Date.parse(entry.endTime) - Date.parse(entry.startTime)) / 1000;
  return span > 0 && Math.abs(span - Number(entry.elapsedSeconds)) <= 2;
}

/**
 * Reconcile imported identity and explicit replacements, never descriptions or
 * overlapping timestamps alone. Removed entries are returned intact for recovery.
 * @param {any[]} entries
 * @param {{ retractedExternalIds?: string[], corrections?: any[] }} options
 */
export function reconcileCodexEntries(
  entries = [],
  { retractedExternalIds = [], corrections = [] } = {}
) {
  const retired = new Set(normalizeCodexRecordIds(retractedExternalIds));
  const removed = [];
  const removals = new Map();
  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  const remove = (entry, reason, replacement = null) => {
    if (!removals.has(entry)) {
      removals.set(entry, {
        reason,
        replacementEntryId: replacement?.id || null
      });
    }
  };
  for (const correction of normalizeCodexCorrections(corrections)) {
    const entry = byId.get(correction.entryId);
    const replacement = byId.get(correction.replacementEntryId);
    if (
      !isManagedEntry(entry) ||
      !isManagedEntry(replacement) ||
      removals.has(replacement) ||
      entry.projectId !== correction.projectId ||
      replacement.projectId !== entry.projectId ||
      entry.startTime !== correction.startTime ||
      entry.endTime !== correction.endTime ||
      Number(entry.duration) !== correction.effectiveSeconds ||
      Date.parse(replacement.startTime) > Date.parse(entry.startTime) ||
      Date.parse(replacement.endTime) < Date.parse(entry.endTime)
    )
      continue;
    if (
      correction.reason === 'duplicate' &&
      (replacement.startTime !== entry.startTime ||
        replacement.endTime !== entry.endTime ||
        replacement.duration !== entry.duration ||
        replacement.description !== entry.description)
    )
      continue;
    remove(entry, correction.reason, replacement);
    if (
      entry.externalId &&
      entry.externalId !== replacement.externalId &&
      !entries.some(
        (other) =>
          other !== entry &&
          !removals.has(other) &&
          other.externalId === entry.externalId
      )
    ) {
      normalizeCodexRecordIds([entry.externalId]).forEach((id) =>
        retired.add(id)
      );
    }
  }

  // Saved replacement metadata remains authoritative after its inbox ages out.
  for (const entry of entries) {
    if (
      !isManagedEntry(entry) ||
      removals.has(entry) ||
      retired.has(entry.externalId)
    )
      continue;
    normalizeCodexRecordIds(entry.codexSupersedesExternalIds)
      .filter((id) => id !== entry.externalId)
      .forEach((id) => retired.add(id));
  }

  const external = new Map();
  const identities = new Map();
  for (const entry of entries) {
    if (!isManagedEntry(entry) || removals.has(entry)) continue;
    if (retired.has(entry.externalId)) {
      remove(entry, 'retracted');
      continue;
    }
    const externalId = String(entry.externalId || '');
    const thread = String(entry.codexThreadId || '');
    const identity =
      thread && entry.startTime && entry.endTime
        ? JSON.stringify([
            thread,
            entry.projectId,
            entry.startTime,
            entry.endTime
          ])
        : '';
    const previous =
      (externalId && external.get(externalId)) ||
      (identity && identities.get(identity));
    if (previous && !removals.has(previous)) {
      const keeper = prefer(previous, entry);
      const duplicate = keeper === previous ? entry : previous;
      remove(duplicate, 'duplicate', keeper);
      if (duplicate.externalId && duplicate.externalId !== keeper.externalId) {
        normalizeCodexRecordIds([duplicate.externalId]).forEach((id) =>
          retired.add(id)
        );
      }
      if (externalId) external.set(externalId, keeper);
      if (keeper.externalId) external.set(keeper.externalId, keeper);
      if (identity) identities.set(identity, keeper);
    } else {
      if (externalId) external.set(externalId, entry);
      if (identity) identities.set(identity, entry);
    }
  }
  const threads = new Map();
  for (const entry of entries) {
    if (!isManagedEntry(entry) || removals.has(entry) || !entry.codexThreadId)
      continue;
    const key = JSON.stringify([entry.codexThreadId, entry.projectId]);
    const group = threads.get(key) || [];
    group.push(entry);
    threads.set(key, group);
  }
  for (const group of threads.values()) {
    const aggregates = group
      .filter((entry) => isAggregate(entry) || hasContinuousTiming(entry))
      .sort(
        (a, b) =>
          Date.parse(b.endTime) -
          Date.parse(b.startTime) -
          (Date.parse(a.endTime) - Date.parse(a.startTime))
      );
    for (const aggregate of aggregates) {
      if (removals.has(aggregate)) continue;
      for (const entry of group) {
        if (
          entry === aggregate ||
          removals.has(entry) ||
          (!isAggregate(aggregate) &&
            (isAggregate(entry) || !hasContinuousTiming(entry))) ||
          Date.parse(aggregate.startTime) > Date.parse(entry.startTime) ||
          Date.parse(aggregate.endTime) < Date.parse(entry.endTime) ||
          !Number.isFinite(Date.parse(entry.startTime)) ||
          !Number.isFinite(Date.parse(entry.endTime))
        )
          continue;
        remove(entry, 'superseded', aggregate);
        if (entry.externalId !== aggregate.externalId) {
          normalizeCodexRecordIds([entry.externalId]).forEach((id) =>
            retired.add(id)
          );
        }
      }
    }
  }
  const next = entries.filter((entry) => {
    const reason = removals.get(entry);
    if (!reason) return true;
    removed.push({ entry, ...reason });
    return false;
  });
  return {
    entries: next,
    removed,
    retractedExternalIds: [...retired]
  };
}
