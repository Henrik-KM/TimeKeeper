export const LONG_ENTRY_REVIEW_SECONDS = 12 * 60 * 60;
export const ENTRY_GROUP_GAP_SECONDS = 15 * 60;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function validDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

function focusFactor(entry) {
  for (const candidate of [
    entry?.focusFactor,
    entry?.manualFactor,
    entry?.factor
  ]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

export function getEntrySource(entry) {
  const savedSource = String(entry?.source || '').toLowerCase();
  if (savedSource === 'codex') return 'codex';
  if (entry?.manual === true || savedSource === 'manual') {
    return 'manual';
  }
  return 'timer';
}

export function getEntryTimestampSeconds(entry, now = new Date()) {
  const start = validDate(entry?.startTime || entry?.start);
  const end =
    validDate(entry?.endTime || entry?.end) ||
    (entry?.isRunning ? validDate(now) : null);
  if (!start || !end || end <= start) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

export function getEntryElapsedSeconds(entry, now = new Date()) {
  const saved = Number(entry?.elapsedSeconds);
  if (Number.isFinite(saved) && saved >= 0) {
    if (!entry?.isRunning || entry?.pausedAt) return Math.round(saved);
    const last =
      validDate(entry?.lastUpdateTime) || validDate(entry?.startTime);
    const current = validDate(now);
    if (!last || !current || current <= last) return Math.round(saved);
    return Math.round(saved + (current.getTime() - last.getTime()) / 1000);
  }
  // A stopped entry's timestamps are the best available record of active
  // elapsed time. Effective duration may reflect one or more historical focus
  // factors and cannot reliably reconstruct the original elapsed time.
  if (!entry?.isRunning) {
    const timestampSeconds = getEntryTimestampSeconds(entry, now);
    if (timestampSeconds > 0) return timestampSeconds;
  }
  const effective = Number(
    entry?.isRunning ? entry?.effectiveSeconds : entry?.duration
  );
  const factor = focusFactor(entry);
  if (Number.isFinite(effective) && effective >= 0 && factor > 0) {
    return Math.round(effective / factor);
  }
  return getEntryTimestampSeconds(entry, now);
}

export function normalizeEntryTiming(entry, now = new Date()) {
  if (!entry || typeof entry !== 'object') return entry;
  const normalized = { ...entry };
  const saved = Number(normalized.elapsedSeconds);
  if (!Number.isFinite(saved) || saved < 0) {
    normalized.elapsedSeconds = getEntryElapsedSeconds(normalized, now);
  } else {
    normalized.elapsedSeconds = Math.round(saved);
  }
  return normalized;
}

export function entryCrossesLocalDay(entry) {
  const start = validDate(entry?.startTime);
  const end = validDate(entry?.endTime);
  if (!start || !end) return false;
  return (
    start.getFullYear() !== end.getFullYear() ||
    start.getMonth() !== end.getMonth() ||
    start.getDate() !== end.getDate()
  );
}

export function getEntryIntegrityReasons(
  entry,
  { longSeconds = LONG_ENTRY_REVIEW_SECONDS } = {}
) {
  if (!entry || entry.isRunning || entry.integrityReviewedAt) return [];
  const reasons = [];
  const elapsedSeconds = getEntryElapsedSeconds(entry);
  const timestampSeconds = getEntryTimestampSeconds(entry);
  if (Math.max(elapsedSeconds, timestampSeconds) >= longSeconds) {
    reasons.push('long');
  }
  if (entryCrossesLocalDay(entry)) reasons.push('crosses-day');
  return reasons;
}

function localDateKey(value) {
  const date = validDate(value);
  if (!date) return 'invalid-date';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function makeGroup(entry, suffix) {
  const start = validDate(entry?.startTime);
  const end = validDate(entry?.endTime) || start;
  return {
    id: `${getEntrySource(entry)}:${localDateKey(entry?.startTime)}:${String(entry?.projectId || '')}:${suffix}`,
    source: getEntrySource(entry),
    projectId: String(entry?.projectId || ''),
    dateKey: localDateKey(entry?.startTime),
    start,
    end,
    entries: [entry]
  };
}

function presentGroup(group) {
  const entries = group.entries;
  return {
    ...group,
    count: entries.length,
    effectiveSeconds: Math.round(
      entries.reduce(
        (sum, entry) => sum + finiteNonNegative(entry?.duration),
        0
      )
    ),
    elapsedSeconds: Math.round(
      entries.reduce((sum, entry) => sum + getEntryElapsedSeconds(entry), 0)
    ),
    descriptionCount: new Set(
      entries
        .map((entry) => String(entry?.description || '').trim())
        .filter(Boolean)
    ).size
  };
}

export function groupTimeEntries(
  entries,
  { gapSeconds = ENTRY_GROUP_GAP_SECONDS } = {}
) {
  const ordered = (Array.isArray(entries) ? entries : [])
    .slice()
    .filter((entry) => validDate(entry?.startTime))
    .sort(
      (left, right) =>
        validDate(left.startTime).getTime() -
        validDate(right.startTime).getTime()
    );
  const groups = [];
  const codexGroups = new Map();
  ordered.forEach((entry) => {
    const source = getEntrySource(entry);
    const dateKey = localDateKey(entry.startTime);
    const projectId = String(entry.projectId || '');
    if (source === 'codex') {
      const key = `codex:${dateKey}:${projectId}`;
      let group = codexGroups.get(key);
      if (!group) {
        group = makeGroup(entry, 'day');
        codexGroups.set(key, group);
        groups.push(group);
      } else {
        group.entries.push(entry);
        const start = validDate(entry.startTime);
        const end = validDate(entry.endTime) || start;
        if (start && (!group.start || start < group.start)) group.start = start;
        if (end && (!group.end || end > group.end)) group.end = end;
      }
      return;
    }

    const previous = groups.at(-1);
    const start = validDate(entry.startTime);
    const end = validDate(entry.endTime) || start;
    const gap =
      previous?.end && start
        ? (start.getTime() - previous.end.getTime()) / 1000
        : Number.POSITIVE_INFINITY;
    if (
      previous &&
      previous.source === source &&
      previous.dateKey === dateKey &&
      previous.projectId === projectId &&
      gap <= gapSeconds
    ) {
      previous.entries.push(entry);
      if (end && (!previous.end || end > previous.end)) previous.end = end;
      return;
    }
    groups.push(
      makeGroup(
        entry,
        String(
          entry.id || validDate(entry.startTime)?.getTime() || groups.length
        )
      )
    );
  });
  return groups
    .map(presentGroup)
    .sort(
      (left, right) =>
        (right.start?.getTime() || 0) - (left.start?.getTime() || 0)
    );
}

export function computeUnionSeconds(entries) {
  const intervals = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const start = validDate(entry?.startTime);
      const end = validDate(entry?.endTime);
      return start && end && end > start
        ? [start.getTime(), end.getTime()]
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);
  if (!intervals.length) return 0;
  let [currentStart, currentEnd] = intervals[0];
  let totalMs = 0;
  intervals.slice(1).forEach(([start, end]) => {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  });
  totalMs += currentEnd - currentStart;
  return Math.round(totalMs / 1000);
}

function median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function getWeekdayCapacityProfile(
  entries,
  { now = new Date(), lookbackDays = 90, includeWeekends = false } = {}
) {
  const current = validDate(now) || new Date();
  const cutoff = current.getTime() - lookbackDays * 86400000;
  const days = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry || entry.isRunning) return;
    const start = validDate(entry.startTime);
    if (!start || start.getTime() < cutoff || start > current) return;
    if (getEntryTimestampSeconds(entry) >= LONG_ENTRY_REVIEW_SECONDS) return;
    const key = localDateKey(start);
    const currentDay = days.get(key) || {
      weekday: start.getDay(),
      effectiveSeconds: 0
    };
    currentDay.effectiveSeconds += finiteNonNegative(entry.duration);
    days.set(key, currentDay);
  });
  const samples = Array.from({ length: 7 }, () => []);
  days.forEach((day) => samples[day.weekday].push(day.effectiveSeconds / 3600));
  const medians = samples.map((values) => median(values));
  const weekdayReference = median(
    medians.slice(1, 5).filter((value) => value > 0)
  );
  const fallback = weekdayReference > 0 ? weekdayReference : 1;
  const weights = medians.map((value, weekday) => {
    if (!includeWeekends && (weekday === 0 || weekday === 6)) return 0;
    if (samples[weekday].length < 3 || value <= 0) {
      return weekday === 0 || weekday === 6 ? 0 : 1;
    }
    return Math.max(0.2, Math.min(1.5, value / fallback));
  });
  return {
    weights,
    medians,
    sampleDays: samples.map((values) => values.length),
    learned:
      samples.slice(1, 6).filter((values) => values.length >= 3).length >= 3
  };
}

export function getCapacityShareForDateRange(
  start,
  endExclusive,
  weights,
  { includeWeekends = false } = {}
) {
  const first = validDate(start);
  const end = validDate(endExclusive);
  if (!first || !end || first >= end) return { todayWeight: 0, totalWeight: 0 };
  let totalWeight = 0;
  let todayWeight = 0;
  for (
    let cursor = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate()
    );
    cursor < end;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const weekday = cursor.getDay();
    const weight =
      !includeWeekends && (weekday === 0 || weekday === 6)
        ? 0
        : finiteNonNegative(
            weights?.[weekday],
            weekday === 0 || weekday === 6 ? 0 : 1
          );
    if (cursor.toDateString() === first.toDateString()) todayWeight = weight;
    totalWeight += weight;
  }
  return { todayWeight, totalWeight };
}

export function getRecentProjectHours(
  entries,
  { now = new Date(), days = 30 } = {}
) {
  const current = validDate(now) || new Date();
  const cutoff = current.getTime() - days * 86400000;
  const totals = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry || entry.isRunning) return;
    const start = validDate(entry.startTime);
    if (!start || start.getTime() < cutoff || start > current) return;
    const projectId = String(entry.projectId || '');
    totals.set(
      projectId,
      (totals.get(projectId) || 0) + finiteNonNegative(entry.duration) / 3600
    );
  });
  return totals;
}
