const HOUR_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_USAGE_GAP_HOURS = 3;
const DEFAULT_MAX_USAGE_DELTA = 40;
const DEFAULT_RESET_TIME_TOLERANCE_MINUTES = 5;

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function normalizeLabel(value, fallback = 'unknown') {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  return text || fallback;
}

function normalizeDisplayLabel(value, fallback = 'Unknown') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeDivide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getUsageWindow(sample, windowKey) {
  if (!sample || typeof sample !== 'object') return null;
  if (sample[windowKey] && typeof sample[windowKey] === 'object') {
    return sample[windowKey];
  }
  if (
    sample.usageLimits &&
    typeof sample.usageLimits === 'object' &&
    sample.usageLimits[windowKey] &&
    typeof sample.usageLimits[windowKey] === 'object'
  ) {
    return sample.usageLimits[windowKey];
  }
  return null;
}

export function normalizeCodexUsageSample(sample, windowKey = 'primary') {
  const window = getUsageWindow(sample, windowKey);
  if (!window) return null;
  const observedAt =
    sample.observedAt ||
    sample.capturedAt ||
    sample.updatedAt ||
    sample.usageLimits?.observedAt;
  const observedMs = parseTime(observedAt);
  if (observedMs === null) return null;
  const toNumber = (value) =>
    value === null || value === undefined || value === ''
      ? Number.NaN
      : Number(value);
  let usedPercent = toNumber(window.usedPercent);
  let remainingPercent = toNumber(window.remainingPercent);
  if (!Number.isFinite(usedPercent) && Number.isFinite(remainingPercent)) {
    usedPercent = 100 - remainingPercent;
  }
  if (!Number.isFinite(remainingPercent) && Number.isFinite(usedPercent)) {
    remainingPercent = 100 - usedPercent;
  }
  if (!Number.isFinite(usedPercent)) return null;
  const windowMinutes = positiveNumber(window.windowMinutes, 0);
  return {
    observedAt: new Date(observedMs).toISOString(),
    observedMs,
    usedPercent: clamp(usedPercent, 0, 100),
    remainingPercent: Number.isFinite(remainingPercent)
      ? clamp(remainingPercent, 0, 100)
      : clamp(100 - usedPercent, 0, 100),
    windowMinutes,
    resetsAt: parseTime(window.resetsAt)
      ? new Date(parseTime(window.resetsAt)).toISOString()
      : null,
    sourceMachineId: normalizeDisplayLabel(
      sample.sourceMachineId || sample.machineId,
      ''
    ),
    windowKey
  };
}

export function computeCodexQuotaProgress(quotaWindow, now = new Date()) {
  if (!quotaWindow || typeof quotaWindow !== 'object') return null;
  const nowMs = parseTime(now);
  const resetMs = parseTime(quotaWindow.resetsAt);
  const windowMinutes = positiveNumber(quotaWindow.windowMinutes, 0);
  if (nowMs === null || resetMs === null || windowMinutes <= 0) return null;

  const windowStartMs = resetMs - windowMinutes * 60 * 1000;
  if (windowStartMs >= resetMs || nowMs >= resetMs) return null;
  const rawUsedPercent = finiteNumber(quotaWindow.usedPercent, Number.NaN);
  const rawRemainingPercent = finiteNumber(
    quotaWindow.remainingPercent,
    Number.NaN
  );
  const usedPercent = Number.isFinite(rawUsedPercent)
    ? rawUsedPercent
    : Number.isFinite(rawRemainingPercent)
      ? 100 - rawRemainingPercent
      : Number.NaN;
  if (!Number.isFinite(usedPercent)) return null;

  const expectedUsedPercent = clamp(
    ((nowMs - windowStartMs) / (resetMs - windowStartMs)) * 100,
    0,
    100
  );
  const normalizedUsedPercent = clamp(usedPercent, 0, 100);
  return {
    usedPercent: round(normalizedUsedPercent, 1),
    remainingPercent: round(100 - normalizedUsedPercent, 1),
    expectedUsedPercent: round(expectedUsedPercent, 1),
    expectedRemainingPercent: round(100 - expectedUsedPercent, 1),
    windowStartAt: new Date(windowStartMs).toISOString(),
    resetsAt: new Date(resetMs).toISOString()
  };
}

function dedupeUsageSamples(samples) {
  const byTimestamp = new Map();
  samples.forEach((sample) => {
    const key = String(sample.observedMs);
    const existing = byTimestamp.get(key);
    if (!existing || sample.usedPercent !== existing.usedPercent) {
      byTimestamp.set(key, sample);
    }
  });
  return [...byTimestamp.values()].sort(
    (left, right) => left.observedMs - right.observedMs
  );
}

function sameUsageWindow(
  previous,
  current,
  resetTimeToleranceMs = DEFAULT_RESET_TIME_TOLERANCE_MINUTES * 60 * 1000
) {
  if (!previous || !current) return false;
  if (
    previous.windowMinutes > 0 &&
    current.windowMinutes > 0 &&
    previous.windowMinutes !== current.windowMinutes
  ) {
    return false;
  }
  if (previous.resetsAt && current.resetsAt) {
    const previousResetMs = parseTime(previous.resetsAt);
    const currentResetMs = parseTime(current.resetsAt);
    if (previousResetMs !== null && currentResetMs !== null) {
      return Math.abs(currentResetMs - previousResetMs) <= resetTimeToleranceMs;
    }
    return previous.resetsAt === current.resetsAt;
  }
  return current.usedPercent >= previous.usedPercent;
}

export function computeCodexUsageIntervals(
  usageHistory,
  {
    windowKey = 'primary',
    maxGapHours = DEFAULT_MAX_USAGE_GAP_HOURS,
    maxUsageDelta = DEFAULT_MAX_USAGE_DELTA,
    resetTimeToleranceMinutes = DEFAULT_RESET_TIME_TOLERANCE_MINUTES
  } = {}
) {
  const rawSamples = Array.isArray(usageHistory)
    ? usageHistory
    : Array.isArray(usageHistory?.samples)
      ? usageHistory.samples
      : [];
  const samples = dedupeUsageSamples(
    rawSamples
      .map((sample) => normalizeCodexUsageSample(sample, windowKey))
      .filter(Boolean)
  );
  const intervals = [];
  let resetTransitions = 0;
  let skippedLargeGaps = 0;
  let skippedAnomalies = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const durationMs = current.observedMs - previous.observedMs;
    if (durationMs <= 0) continue;
    if (
      !sameUsageWindow(
        previous,
        current,
        Math.max(0, resetTimeToleranceMinutes) * 60 * 1000
      )
    ) {
      resetTransitions += 1;
      continue;
    }
    const durationHours = durationMs / (60 * 60 * 1000);
    if (durationHours > maxGapHours) {
      skippedLargeGaps += 1;
      continue;
    }
    const delta = current.usedPercent - previous.usedPercent;
    if (delta < 0 || delta > maxUsageDelta) {
      skippedAnomalies += 1;
      continue;
    }
    intervals.push({
      startMs: previous.observedMs,
      endMs: current.observedMs,
      startAt: previous.observedAt,
      endAt: current.observedAt,
      durationHours,
      usagePoints: delta,
      previousUsedPercent: previous.usedPercent,
      currentUsedPercent: current.usedPercent,
      windowMinutes: current.windowMinutes || previous.windowMinutes,
      resetsAt: current.resetsAt || previous.resetsAt,
      windowKey
    });
  }
  return {
    windowKey,
    samples,
    intervals,
    resetTransitions,
    skippedLargeGaps,
    skippedAnomalies,
    coverageStartMs: samples.length ? samples[0].observedMs : null,
    coverageEndMs: samples.length
      ? samples[samples.length - 1].observedMs
      : null,
    totalUsagePoints: intervals.reduce(
      (total, interval) => total + interval.usagePoints,
      0
    )
  };
}

function isCodexEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const source = String(entry.source || '').toLowerCase();
  const externalId = String(entry.externalId || entry.id || '').toLowerCase();
  const description = String(entry.description || '').toLowerCase();
  return (
    source.includes('codex') ||
    externalId.startsWith('codex-') ||
    externalId.startsWith('codex:') ||
    description.startsWith('codex:')
  );
}

function inferSessionTimes(entry) {
  const startMs =
    parseTime(entry.startTime) ??
    parseTime(entry.timestamp) ??
    parseTime(entry.createdAt);
  if (startMs === null) return null;
  const explicitEndMs = parseTime(entry.endTime);
  const elapsedSeconds = positiveNumber(
    entry.elapsedSeconds ?? entry.wallSeconds ?? entry.codexWallSeconds,
    0
  );
  const focusFactor = positiveNumber(
    entry.focusFactor ?? entry.manualFactor,
    0
  );
  const effectiveSeconds = positiveNumber(
    entry.duration ?? entry.effectiveSeconds,
    0
  );
  const inferredWallSeconds =
    elapsedSeconds > 0
      ? elapsedSeconds
      : focusFactor > 0
        ? effectiveSeconds / focusFactor
        : effectiveSeconds;
  const endMs =
    explicitEndMs !== null && explicitEndMs > startMs
      ? explicitEndMs
      : startMs + Math.max(1, inferredWallSeconds) * 1000;
  return {
    startMs,
    endMs,
    wallSeconds: inferredWallSeconds,
    effectiveSeconds,
    focusFactor
  };
}

function normalizeModelBreakdown(entry, session) {
  const raw = Array.isArray(entry.codexModelBreakdown)
    ? entry.codexModelBreakdown
    : Array.isArray(entry.modelBreakdown)
      ? entry.modelBreakdown
      : [];
  const rows = raw
    .map((row) => {
      const wallSeconds = positiveNumber(
        row?.wallSeconds ?? row?.activeSeconds,
        0
      );
      const effectiveSeconds = positiveNumber(row?.effectiveSeconds, 0);
      return {
        model: normalizeLabel(row?.model),
        effort: normalizeLabel(row?.effort),
        role: normalizeLabel(row?.role, 'parent'),
        wallSeconds,
        effectiveSeconds,
        factor: positiveNumber(row?.creditedFactor ?? row?.factor, 0)
      };
    })
    .filter((row) => row.wallSeconds > 0 || row.effectiveSeconds > 0);
  if (rows.length) return rows;
  return [
    {
      model: normalizeLabel(entry.codexModel ?? entry.model),
      effort: normalizeLabel(entry.codexEffort ?? entry.effort),
      role: normalizeLabel(entry.codexRole ?? entry.role, 'parent'),
      wallSeconds: session.wallSeconds,
      effectiveSeconds: session.effectiveSeconds,
      factor: session.focusFactor
    }
  ];
}

export function normalizeCodexSessions(entries, projects = []) {
  const projectNames = new Map(
    (Array.isArray(projects) ? projects : []).map((project) => [
      String(project?.id || ''),
      normalizeDisplayLabel(project?.name, 'Unknown project')
    ])
  );
  return (Array.isArray(entries) ? entries : [])
    .filter(isCodexEntry)
    .map((entry) => {
      const times = inferSessionTimes(entry);
      if (!times) return null;
      const projectName =
        normalizeDisplayLabel(
          entry.timekeeperProjectName ||
            entry.projectName ||
            projectNames.get(String(entry.projectId || '')),
          'Unknown project'
        ) || 'Unknown project';
      const session = {
        id: String(entry.externalId || entry.id || `${times.startMs}`),
        startMs: times.startMs,
        endMs: times.endMs,
        wallSeconds: times.wallSeconds,
        effectiveSeconds: times.effectiveSeconds,
        focusFactor: times.focusFactor,
        projectName,
        repoName: normalizeDisplayLabel(
          entry.repoName || entry.codexRepoName || entry.projectKey,
          projectName
        ),
        description: normalizeDisplayLabel(entry.description, 'Codex session'),
        delegatedSessionCount: positiveNumber(
          entry.codexDelegatedSessionCount ?? entry.delegatedSessionCount,
          0
        )
      };
      session.modelBreakdown = normalizeModelBreakdown(entry, session);
      return session;
    })
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs);
}

function getLocalPeriodStart(date, period) {
  if (period === 'month') {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }
  const dayOfWeek = date.getDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - daysFromMonday
  );
}

function getElapsedCalendarDays(start, end) {
  const startDay = Date.UTC(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  );
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(1, Math.floor((endDay - startDay) / DAY_MS) + 1);
}

function sumSourceEffectiveSeconds(entries, startMs, endMs, source) {
  return (Array.isArray(entries) ? entries : []).reduce((total, entry) => {
    if (!entry || entry.isRunning) return total;
    const entryStartMs = parseTime(
      entry.startTime || entry.timestamp || entry.createdAt
    );
    if (
      entryStartMs === null ||
      entryStartMs < startMs ||
      entryStartMs > endMs
    ) {
      return total;
    }
    const isCodex = isCodexEntry(entry);
    if ((source === 'codex') !== isCodex) return total;
    return total + positiveNumber(entry.duration, 0);
  }, 0);
}

export function buildCodexSourceAverages(entries = [], now = new Date()) {
  const nowMs = parseTime(now);
  if (nowMs === null) return null;
  const current = new Date(nowMs);
  const buildPeriod = (key, label) => {
    const start = getLocalPeriodStart(current, key);
    const startMs = start.getTime();
    const daysElapsed = getElapsedCalendarDays(start, current);
    const meEffectiveSeconds = sumSourceEffectiveSeconds(
      entries,
      startMs,
      nowMs,
      'me'
    );
    const codexEffectiveSeconds = sumSourceEffectiveSeconds(
      entries,
      startMs,
      nowMs,
      'codex'
    );
    return {
      key,
      label,
      startAt: start.toISOString(),
      daysElapsed,
      meEffectiveSeconds: round(meEffectiveSeconds, 0),
      codexEffectiveSeconds: round(codexEffectiveSeconds, 0),
      meAverageHoursPerDay: round(
        meEffectiveSeconds / HOUR_SECONDS / daysElapsed,
        2
      ),
      codexAverageHoursPerDay: round(
        codexEffectiveSeconds / HOUR_SECONDS / daysElapsed,
        2
      )
    };
  };
  return {
    week: buildPeriod('week', 'This week'),
    month: buildPeriod('month', 'This month')
  };
}

function overlapMs(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function clipInterval(interval, rangeStartMs, rangeEndMs) {
  const durationMs = interval.endMs - interval.startMs;
  const clippedMs = overlapMs(
    interval.startMs,
    interval.endMs,
    rangeStartMs,
    rangeEndMs
  );
  if (durationMs <= 0 || clippedMs <= 0) return null;
  const fraction = clippedMs / durationMs;
  return {
    ...interval,
    startMs: Math.max(interval.startMs, rangeStartMs),
    endMs: Math.min(interval.endMs, rangeEndMs),
    durationHours: clippedMs / (60 * 60 * 1000),
    usagePoints: interval.usagePoints * fraction
  };
}

function getSessionClip(session, rangeStartMs, rangeEndMs) {
  const spanMs = session.endMs - session.startMs;
  const clippedMs = overlapMs(
    session.startMs,
    session.endMs,
    rangeStartMs,
    rangeEndMs
  );
  if (spanMs <= 0 || clippedMs <= 0) return null;
  return {
    fraction: clamp(clippedMs / spanMs, 0, 1),
    clippedMs
  };
}

function makeAggregate(key, label, extras = {}) {
  return {
    key,
    label,
    wallSeconds: 0,
    effectiveSeconds: 0,
    measuredWallSeconds: 0,
    measuredEffectiveSeconds: 0,
    usagePoints: 0,
    sessions: new Set(),
    allocatedIntervals: new Set(),
    parentWallSeconds: 0,
    subagentWallSeconds: 0,
    delegatedSessions: 0,
    ...extras
  };
}

function ensureAggregate(map, key, label, extras) {
  if (!map.has(key)) {
    map.set(key, makeAggregate(key, label, extras));
  }
  return map.get(key);
}

function addTimeToAggregate(
  aggregate,
  segment,
  session,
  rangeFraction,
  measurementFraction
) {
  const wallSeconds = segment.wallSeconds * rangeFraction;
  const effectiveSeconds = segment.effectiveSeconds * rangeFraction;
  aggregate.wallSeconds += wallSeconds;
  aggregate.effectiveSeconds += effectiveSeconds;
  aggregate.measuredWallSeconds += segment.wallSeconds * measurementFraction;
  aggregate.measuredEffectiveSeconds +=
    segment.effectiveSeconds * measurementFraction;
  aggregate.sessions.add(session.id);
  aggregate.delegatedSessions += session.delegatedSessionCount * rangeFraction;
  if (segment.role === 'subagent') {
    aggregate.subagentWallSeconds += wallSeconds;
  } else {
    aggregate.parentWallSeconds += wallSeconds;
  }
}

function addUsageToAggregate(aggregate, usagePoints, intervalIndex) {
  aggregate.usagePoints += usagePoints;
  aggregate.allocatedIntervals.add(intervalIndex);
}

function getSegmentWeight(segment) {
  if (segment.wallSeconds > 0) return segment.wallSeconds;
  if (segment.effectiveSeconds > 0) return segment.effectiveSeconds;
  return Math.max(0, segment.factor);
}

function finalizeAggregate(aggregate, totalAttributedUsagePoints) {
  const wallHours = aggregate.wallSeconds / HOUR_SECONDS;
  const effectiveHours = aggregate.effectiveSeconds / HOUR_SECONDS;
  const measuredWallHours = aggregate.measuredWallSeconds / HOUR_SECONDS;
  const measuredEffectiveHours =
    aggregate.measuredEffectiveSeconds / HOUR_SECONDS;
  const usagePoints = aggregate.usagePoints;
  let confidence = 'low';
  if (
    usagePoints >= 2 &&
    measuredWallHours >= 2 &&
    aggregate.allocatedIntervals.size >= 3
  ) {
    confidence = 'high';
  } else if (
    usagePoints >= 0.5 &&
    measuredWallHours >= 0.5 &&
    aggregate.allocatedIntervals.size >= 1
  ) {
    confidence = 'medium';
  }
  return {
    ...aggregate,
    sessions: aggregate.sessions.size,
    allocatedIntervals: aggregate.allocatedIntervals.size,
    wallHours: round(wallHours),
    effectiveHours: round(effectiveHours),
    measuredWallHours: round(measuredWallHours),
    measuredEffectiveHours: round(measuredEffectiveHours),
    usagePoints: round(usagePoints),
    usagePerWallHour: round(safeDivide(usagePoints, measuredWallHours)),
    usagePerEffectiveHour: round(
      safeDivide(usagePoints, measuredEffectiveHours)
    ),
    effectiveHoursPerUsagePoint: round(
      safeDivide(measuredEffectiveHours, usagePoints)
    ),
    wallHoursPerUsagePoint: round(safeDivide(measuredWallHours, usagePoints)),
    focusConversion: round(
      safeDivide(aggregate.effectiveSeconds, aggregate.wallSeconds)
    ),
    usageShare: round(safeDivide(usagePoints, totalAttributedUsagePoints)),
    subagentShare: round(
      safeDivide(
        aggregate.subagentWallSeconds,
        aggregate.parentWallSeconds + aggregate.subagentWallSeconds
      )
    ),
    confidence
  };
}

function median(values) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function dateKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function rankRows(rows, selector, direction = 'desc') {
  return rows
    .filter((row) => Number.isFinite(selector(row)))
    .slice()
    .sort((left, right) => {
      const delta = selector(left) - selector(right);
      return direction === 'asc' ? delta : -delta;
    });
}

function buildInsights(analytics) {
  const insights = [];
  const selectedWindow =
    analytics.windowKey === 'secondary' ? 'secondary' : 'primary';
  const qualified = analytics.byModel.filter(
    (row) => row.confidence !== 'low' && row.usagePoints > 0
  );
  const highestBurn = rankRows(qualified, (row) => row.usagePerWallHour)[0];
  if (highestBurn) {
    insights.push({
      tone: 'warning',
      title: 'Highest measured quota burn',
      detail: `${highestBurn.label} used ${highestBurn.usagePerWallHour.toFixed(2)} quota points per active hour.`
    });
  }
  const bestYield = rankRows(
    qualified,
    (row) => row.effectiveHoursPerUsagePoint
  )[0];
  if (bestYield) {
    insights.push({
      tone: 'positive',
      title: 'Best effective-time yield',
      detail: `${bestYield.label} produced ${bestYield.effectiveHoursPerUsagePoint.toFixed(2)} effective hours per quota point.`
    });
  }
  const topEffective = rankRows(
    analytics.byModel,
    (row) => row.effectiveHours
  )[0];
  if (topEffective) {
    insights.push({
      tone: 'neutral',
      title: 'Largest effective-time contribution',
      detail: `${topEffective.label} contributed ${topEffective.effectiveHours.toFixed(1)} effective hours in the selected range.`
    });
  }
  if (analytics.overall.unknownModelShare >= 0.1) {
    insights.push({
      tone: 'warning',
      title: 'Model attribution needs cleanup',
      detail: `${Math.round(analytics.overall.unknownModelShare * 100)}% of effective time is assigned to an unknown model.`
    });
  }
  if (
    analytics.overall.attributionRate < 0.7 &&
    analytics.overall.totalUsagePoints > 0
  ) {
    insights.push({
      tone: 'warning',
      title: 'Quota attribution is incomplete',
      detail: `${Math.round(analytics.overall.attributionRate * 100)}% of measured quota change overlapped imported Codex activity.`
    });
  }
  if (analytics.overall.projectedUsedAtReset !== null) {
    const projected = analytics.overall.projectedUsedAtReset;
    insights.push({
      tone: projected >= 100 ? 'warning' : 'neutral',
      title: 'Projected quota at reset',
      detail: `At the measured burn rate, the ${selectedWindow} window would reach approximately ${projected.toFixed(0)}% used by reset.`
    });
  }
  return insights.slice(0, 6);
}

export function buildCodexAnalytics({
  entries = [],
  projects = [],
  usageHistory = [],
  rangeDays = 7,
  now = new Date(),
  windowKey = 'primary',
  maxUsageGapHours = DEFAULT_MAX_USAGE_GAP_HOURS,
  resetTimeToleranceMinutes = DEFAULT_RESET_TIME_TOLERANCE_MINUTES
} = {}) {
  const nowMs = parseTime(now) ?? Date.now();
  const requestedRangeDays = clamp(positiveNumber(rangeDays, 7), 1 / 24, 365);
  const requestedStartMs = nowMs - requestedRangeDays * DAY_MS;
  const usage = computeCodexUsageIntervals(usageHistory, {
    windowKey,
    maxGapHours: maxUsageGapHours,
    resetTimeToleranceMinutes
  });
  const sessions = normalizeCodexSessions(entries, projects).filter(
    (session) => session.endMs > requestedStartMs && session.startMs < nowMs
  );
  const relevantSampleCutoffMs =
    requestedStartMs - maxUsageGapHours * 60 * 60 * 1000;
  const relevantSamples = usage.samples.filter(
    (sample) =>
      sample.observedMs >= relevantSampleCutoffMs && sample.observedMs <= nowMs
  );
  const usageCoverageStartMs = relevantSamples.length
    ? relevantSamples[0].observedMs
    : null;
  const usageCoverageEndMs = relevantSamples.length
    ? relevantSamples[relevantSamples.length - 1].observedMs
    : null;
  const overlappingMeasurementStartMs =
    usageCoverageStartMs === null
      ? null
      : Math.max(requestedStartMs, usageCoverageStartMs);
  const overlappingMeasurementEndMs =
    usageCoverageEndMs === null ? null : Math.min(nowMs, usageCoverageEndMs);
  const hasMeasurementWindow =
    overlappingMeasurementStartMs !== null &&
    overlappingMeasurementEndMs !== null &&
    overlappingMeasurementEndMs > overlappingMeasurementStartMs;
  const measurementStartMs = hasMeasurementWindow
    ? overlappingMeasurementStartMs
    : null;
  const measurementEndMs = hasMeasurementWindow
    ? overlappingMeasurementEndMs
    : null;
  const clippedIntervals = hasMeasurementWindow
    ? usage.intervals
        .map((interval) =>
          clipInterval(interval, measurementStartMs, measurementEndMs)
        )
        .filter(Boolean)
    : [];

  const maps = {
    model: new Map(),
    modelEffort: new Map(),
    effort: new Map(),
    project: new Map(),
    role: new Map()
  };
  let unknownModelEffectiveSeconds = 0;
  let totalEffectiveSeconds = 0;
  let totalWallSeconds = 0;
  let measuredEffectiveSeconds = 0;
  let measuredWallSeconds = 0;
  let subagentWallSeconds = 0;
  const sessionDurationsMinutes = [];
  let mixedModelSessions = 0;

  sessions.forEach((session) => {
    const rangeClip = getSessionClip(session, requestedStartMs, nowMs);
    if (!rangeClip) return;
    const measurementClip = hasMeasurementWindow
      ? getSessionClip(session, measurementStartMs, measurementEndMs)
      : null;
    const measurementFraction = measurementClip?.fraction ?? 0;
    totalWallSeconds += session.wallSeconds * rangeClip.fraction;
    totalEffectiveSeconds += session.effectiveSeconds * rangeClip.fraction;
    measuredWallSeconds += session.wallSeconds * measurementFraction;
    measuredEffectiveSeconds += session.effectiveSeconds * measurementFraction;
    sessionDurationsMinutes.push(
      (session.wallSeconds * rangeClip.fraction) / 60
    );
    const distinctModels = new Set(
      session.modelBreakdown
        .filter((segment) => getSegmentWeight(segment) > 0)
        .map((segment) => segment.model)
    );
    if (distinctModels.size > 1) mixedModelSessions += 1;
    session.modelBreakdown.forEach((segment) => {
      const model = segment.model;
      const effort = segment.effort;
      const role = segment.role;
      const modelAggregate = ensureAggregate(maps.model, model, model);
      const modelEffortKey = `${model}::${effort}`;
      const modelEffortAggregate = ensureAggregate(
        maps.modelEffort,
        modelEffortKey,
        `${model} · ${effort}`,
        { model, effort }
      );
      const effortAggregate = ensureAggregate(maps.effort, effort, effort);
      const projectAggregate = ensureAggregate(
        maps.project,
        session.projectName,
        session.projectName
      );
      const roleAggregate = ensureAggregate(maps.role, role, role);
      [
        modelAggregate,
        modelEffortAggregate,
        effortAggregate,
        projectAggregate,
        roleAggregate
      ].forEach((aggregate) =>
        addTimeToAggregate(
          aggregate,
          segment,
          session,
          rangeClip.fraction,
          measurementFraction
        )
      );
      if (model === 'unknown') {
        unknownModelEffectiveSeconds +=
          segment.effectiveSeconds * rangeClip.fraction;
      }
      if (role === 'subagent') {
        subagentWallSeconds += segment.wallSeconds * rangeClip.fraction;
      }
    });
  });

  let attributedUsagePoints = 0;
  let unattributedUsagePoints = 0;
  clippedIntervals.forEach((interval, intervalIndex) => {
    if (interval.usagePoints <= 0) return;
    const candidates = [];
    sessions.forEach((session) => {
      const overlap = overlapMs(
        session.startMs,
        session.endMs,
        interval.startMs,
        interval.endMs
      );
      const spanMs = session.endMs - session.startMs;
      if (overlap <= 0 || spanMs <= 0) return;
      const fraction = overlap / spanMs;
      session.modelBreakdown.forEach((segment) => {
        const weight = getSegmentWeight(segment) * fraction;
        if (weight <= 0) return;
        candidates.push({ session, segment, weight });
      });
    });
    const totalWeight = candidates.reduce(
      (total, candidate) => total + candidate.weight,
      0
    );
    if (totalWeight <= 0) {
      unattributedUsagePoints += interval.usagePoints;
      return;
    }
    attributedUsagePoints += interval.usagePoints;
    candidates.forEach(({ session, segment, weight }) => {
      const allocated = interval.usagePoints * (weight / totalWeight);
      const modelAggregate = ensureAggregate(
        maps.model,
        segment.model,
        segment.model
      );
      const modelEffortKey = `${segment.model}::${segment.effort}`;
      const modelEffortAggregate = ensureAggregate(
        maps.modelEffort,
        modelEffortKey,
        `${segment.model} · ${segment.effort}`,
        { model: segment.model, effort: segment.effort }
      );
      const effortAggregate = ensureAggregate(
        maps.effort,
        segment.effort,
        segment.effort
      );
      const projectAggregate = ensureAggregate(
        maps.project,
        session.projectName,
        session.projectName
      );
      const roleAggregate = ensureAggregate(
        maps.role,
        segment.role,
        segment.role
      );
      [
        modelAggregate,
        modelEffortAggregate,
        effortAggregate,
        projectAggregate,
        roleAggregate
      ].forEach((aggregate) =>
        addUsageToAggregate(aggregate, allocated, intervalIndex)
      );
    });
  });

  const finalizeMap = (map) =>
    [...map.values()]
      .map((aggregate) => finalizeAggregate(aggregate, attributedUsagePoints))
      .sort((left, right) => right.effectiveHours - left.effectiveHours);
  const byModel = finalizeMap(maps.model);
  const byModelEffort = finalizeMap(maps.modelEffort);
  const byEffort = finalizeMap(maps.effort);
  const byProject = finalizeMap(maps.project);
  const byRole = finalizeMap(maps.role);

  const totalUsagePoints = clippedIntervals.reduce(
    (total, interval) => total + interval.usagePoints,
    0
  );
  const measurementHours = hasMeasurementWindow
    ? Math.max(0, (measurementEndMs - measurementStartMs) / (60 * 60 * 1000))
    : 0;
  const latestSample = relevantSamples
    .filter((sample) => sample.observedMs <= nowMs)
    .slice(-1)[0];
  const positiveMeasurementHours = measurementHours > 0 ? measurementHours : 0;
  const burnPerHour = safeDivide(totalUsagePoints, positiveMeasurementHours);
  let projectedUsedAtReset = null;
  if (latestSample?.resetsAt && burnPerHour !== null) {
    const resetMs = parseTime(latestSample.resetsAt);
    if (resetMs !== null && resetMs > latestSample.observedMs) {
      projectedUsedAtReset = round(
        latestSample.usedPercent +
          burnPerHour *
            ((resetMs - latestSample.observedMs) / (60 * 60 * 1000)),
        2
      );
    }
  }

  const dailyMap = new Map();
  clippedIntervals.forEach((interval) => {
    const key = dateKey(interval.endMs);
    const row = dailyMap.get(key) || {
      date: key,
      usagePoints: 0,
      wallSeconds: 0,
      effectiveSeconds: 0,
      measuredWallSeconds: 0,
      measuredEffectiveSeconds: 0
    };
    row.usagePoints += interval.usagePoints;
    dailyMap.set(key, row);
  });
  sessions.forEach((session) => {
    const clip = getSessionClip(session, requestedStartMs, nowMs);
    if (!clip) return;
    const key = dateKey(Math.max(session.startMs, requestedStartMs));
    const row = dailyMap.get(key) || {
      date: key,
      usagePoints: 0,
      wallSeconds: 0,
      effectiveSeconds: 0,
      measuredWallSeconds: 0,
      measuredEffectiveSeconds: 0
    };
    row.wallSeconds += session.wallSeconds * clip.fraction;
    row.effectiveSeconds += session.effectiveSeconds * clip.fraction;
    const measurementClip = hasMeasurementWindow
      ? getSessionClip(session, measurementStartMs, measurementEndMs)
      : null;
    if (measurementClip) {
      row.measuredWallSeconds += session.wallSeconds * measurementClip.fraction;
      row.measuredEffectiveSeconds +=
        session.effectiveSeconds * measurementClip.fraction;
    }
    dailyMap.set(key, row);
  });
  const daily = [...dailyMap.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => ({
      ...row,
      usagePoints: round(row.usagePoints),
      wallHours: round(row.wallSeconds / HOUR_SECONDS),
      effectiveHours: round(row.effectiveSeconds / HOUR_SECONDS),
      measuredWallHours: round(row.measuredWallSeconds / HOUR_SECONDS),
      measuredEffectiveHours: round(
        row.measuredEffectiveSeconds / HOUR_SECONDS
      ),
      usagePerWallHour: round(
        safeDivide(row.usagePoints, row.measuredWallSeconds / HOUR_SECONDS)
      )
    }));

  let measurementState = 'collecting';
  const attributionRate = safeDivide(attributedUsagePoints, totalUsagePoints);
  const requestedHours = requestedRangeDays * 24;
  const timeCoverage = safeDivide(measurementHours, requestedHours);
  if (hasMeasurementWindow && relevantSamples.length >= 2) {
    measurementState =
      clippedIntervals.length > 0 &&
      (attributionRate ?? 1) >= 0.7 &&
      (timeCoverage ?? 0) >= 0.5
        ? 'ready'
        : 'partial';
  }
  const analytics = {
    generatedAt: new Date(nowMs).toISOString(),
    rangeDays: requestedRangeDays,
    windowKey,
    measurementState,
    coverage: {
      requestedStartAt: new Date(requestedStartMs).toISOString(),
      measurementStartAt: measurementStartMs
        ? new Date(measurementStartMs).toISOString()
        : null,
      measurementEndAt: measurementEndMs
        ? new Date(measurementEndMs).toISOString()
        : null,
      measurementHours: round(measurementHours),
      requestedHours: round(requestedHours),
      timeCoverage: round(timeCoverage),
      sampleCount: relevantSamples.length,
      intervalCount: clippedIntervals.length,
      resetTransitions: usage.resetTransitions,
      skippedLargeGaps: usage.skippedLargeGaps,
      skippedAnomalies: usage.skippedAnomalies
    },
    overall: {
      sessions: sessions.length,
      totalWallHours: round(totalWallSeconds / HOUR_SECONDS),
      totalEffectiveHours: round(totalEffectiveSeconds / HOUR_SECONDS),
      measuredWallHours: round(measuredWallSeconds / HOUR_SECONDS),
      measuredEffectiveHours: round(measuredEffectiveSeconds / HOUR_SECONDS),
      totalUsagePoints: round(totalUsagePoints),
      attributedUsagePoints: round(attributedUsagePoints),
      unattributedUsagePoints: round(
        Math.max(
          unattributedUsagePoints,
          totalUsagePoints - attributedUsagePoints
        )
      ),
      attributionRate: round(attributionRate),
      usagePerWallHour: round(
        safeDivide(totalUsagePoints, measuredWallSeconds / HOUR_SECONDS)
      ),
      usagePerEffectiveHour: round(
        safeDivide(totalUsagePoints, measuredEffectiveSeconds / HOUR_SECONDS)
      ),
      effectiveHoursPerUsagePoint: round(
        safeDivide(measuredEffectiveSeconds / HOUR_SECONDS, totalUsagePoints)
      ),
      focusConversion: round(
        safeDivide(totalEffectiveSeconds, totalWallSeconds)
      ),
      burnPerDay: round(burnPerHour === null ? null : burnPerHour * 24),
      latestUsedPercent: latestSample?.usedPercent ?? null,
      latestRemainingPercent: latestSample?.remainingPercent ?? null,
      resetsAt: latestSample?.resetsAt ?? null,
      projectedUsedAtReset,
      medianSessionMinutes: round(median(sessionDurationsMinutes)),
      sessionsPerEffectiveHour: round(
        safeDivide(sessions.length, totalEffectiveSeconds / HOUR_SECONDS)
      ),
      mixedModelSessionShare: round(
        safeDivide(mixedModelSessions, sessions.length)
      ),
      subagentWallShare: round(
        safeDivide(subagentWallSeconds, totalWallSeconds)
      ),
      unknownModelShare: round(
        safeDivide(unknownModelEffectiveSeconds, totalEffectiveSeconds)
      )
    },
    byModel,
    byModelEffort,
    byEffort,
    byProject,
    byRole,
    daily,
    quotaTimeline: clippedIntervals.map((interval) => ({
      startAt: interval.startAt,
      endAt: interval.endAt,
      usagePoints: round(interval.usagePoints),
      currentUsedPercent: interval.currentUsedPercent,
      resetsAt: interval.resetsAt
    })),
    quotaTrajectory: relevantSamples.map((sample) => ({
      observedAt: sample.observedAt,
      usedPercent: sample.usedPercent,
      remainingPercent: sample.remainingPercent,
      resetsAt: sample.resetsAt,
      windowKey: sample.windowKey
    }))
  };
  analytics.insights = buildInsights(analytics);
  return analytics;
}
