const WINDOW_DAYS = [7, 30, 90];

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function toIso(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function round(value, decimals = 2) {
  const scale = 10 ** decimals;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function getEntryFocusFactor(entry) {
  const candidates = [entry?.focusFactor, entry?.manualFactor, entry?.factor];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function normalizeEntry(entry, nowMs) {
  const start = toIso(entry?.start);
  if (!start) return null;
  const end = toIso(entry?.end);
  const focusFactor = getEntryFocusFactor(entry);
  const savedEffectiveSeconds = finiteNonNegative(entry?.duration, NaN);
  const elapsedSeconds = Math.max(
    0,
    ((end ? new Date(end).getTime() : nowMs) - new Date(start).getTime()) / 1000
  );
  const effectiveSeconds = Number.isFinite(savedEffectiveSeconds)
    ? savedEffectiveSeconds
    : elapsedSeconds * focusFactor;
  const wallClockSeconds =
    focusFactor > 0 ? effectiveSeconds / focusFactor : effectiveSeconds;
  return {
    id: String(entry?.id || ''),
    projectId: String(entry?.projectId || ''),
    description: String(entry?.description || '').trim(),
    start,
    end,
    isRunning: entry?.isRunning === true || !end,
    focusFactor: round(focusFactor, 4),
    wallClockSeconds: Math.round(wallClockSeconds),
    effectiveSeconds: Math.round(effectiveSeconds),
    source: String(entry?.source || (entry?.manual ? 'manual' : 'timer'))
  };
}

function makeUsageBucket() {
  return {
    entries: 0,
    wallClockSeconds: 0,
    effectiveSeconds: 0
  };
}

function addToBucket(bucket, entry) {
  bucket.entries += 1;
  bucket.wallClockSeconds += entry.wallClockSeconds;
  bucket.effectiveSeconds += entry.effectiveSeconds;
}

function presentBucket(bucket) {
  return {
    entries: bucket.entries,
    wallClockHours: round(bucket.wallClockSeconds / 3600),
    effectiveHours: round(bucket.effectiveSeconds / 3600)
  };
}

function makeWindowBuckets() {
  return {
    all: makeUsageBucket(),
    '7d': makeUsageBucket(),
    '30d': makeUsageBucket(),
    '90d': makeUsageBucket()
  };
}

function addEntryToWindows(windows, entry, nowMs) {
  addToBucket(windows.all, entry);
  const startMs = new Date(entry.start).getTime();
  WINDOW_DAYS.forEach((days) => {
    if (startMs >= nowMs - days * 24 * 60 * 60 * 1000) {
      addToBucket(windows[`${days}d`], entry);
    }
  });
}

function presentWindows(windows) {
  return Object.fromEntries(
    Object.entries(windows).map(([key, bucket]) => [key, presentBucket(bucket)])
  );
}

function normalizeProject(project) {
  const scheduleType =
    project?.scheduleType === 'weekly' ? 'weekly' : 'deadline';
  return {
    id: String(project?.id || ''),
    name: String(project?.name || '').trim(),
    client: String(project?.client || '').trim() || null,
    archived: project?.archived === true || project?.isActive === false,
    scheduleType,
    startDate: String(project?.startDate || ''),
    deadline:
      scheduleType === 'deadline' ? String(project?.deadline || '') : '',
    budgetHours:
      scheduleType === 'deadline'
        ? round(finiteNonNegative(project?.budgetHours))
        : 0,
    weeklyExpectedHours:
      scheduleType === 'weekly'
        ? round(finiteNonNegative(project?.weeklyExpectedHours))
        : 0,
    createdAt: toIso(project?.createdAt)
  };
}

/**
 * Build a deliberately scoped local snapshot for product-development context.
 * Financial, workout, wealth, backup, and integration fields are omitted.
 */
export function buildCodexDevelopmentContext(data, { now = new Date() } = {}) {
  const generatedAt = new Date(now);
  const nowMs = Number.isNaN(generatedAt.getTime())
    ? Date.now()
    : generatedAt.getTime();
  const projects = (Array.isArray(data?.projects) ? data.projects : [])
    .map(normalizeProject)
    .filter((project) => project.id || project.name);
  const projectUsage = new Map(
    projects.map((project) => [project.id, makeWindowBuckets()])
  );
  const overallUsage = makeWindowBuckets();
  const sources = {};
  const focusFactors = {};
  const activeDays = new Set();
  const normalizedEntries = (Array.isArray(data?.entries) ? data.entries : [])
    .map((entry) => normalizeEntry(entry, nowMs))
    .filter(Boolean)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

  normalizedEntries.forEach((entry) => {
    addEntryToWindows(overallUsage, entry, nowMs);
    if (!projectUsage.has(entry.projectId)) {
      projectUsage.set(entry.projectId, makeWindowBuckets());
    }
    addEntryToWindows(projectUsage.get(entry.projectId), entry, nowMs);
    sources[entry.source] = (sources[entry.source] || 0) + 1;
    const factorKey = String(entry.focusFactor);
    focusFactors[factorKey] = (focusFactors[factorKey] || 0) + 1;
    activeDays.add(entry.start.slice(0, 10));
  });

  const firstEntry = normalizedEntries.at(-1) || null;
  const lastEntry = normalizedEntries[0] || null;

  return {
    schema: 'timekeeper-codex-development-context/v1',
    generatedAt: new Date(nowMs).toISOString(),
    dataUpdatedAt: toIso(data?.updatedAt),
    privacy: {
      storage: 'local-gitignored-file',
      includes:
        'project names, clients, planning fields, usage aggregates, and complete time-entry history',
      excludes:
        'finances, wealth, workouts, backup configuration, integration configuration, and tokens'
    },
    coverage: {
      totalProjects: projects.length,
      activeProjects: projects.filter((project) => !project.archived).length,
      totalEntries: normalizedEntries.length,
      activeDays: activeDays.size,
      firstEntryAt: firstEntry?.start || null,
      lastEntryAt: lastEntry?.start || null,
      entriesIncluded: normalizedEntries.length,
      entriesTruncated: false
    },
    usage: {
      windows: presentWindows(overallUsage),
      runningTimers: normalizedEntries.filter((entry) => entry.isRunning)
        .length,
      entrySources: sources,
      focusFactorCounts: focusFactors,
      timerPresets: Array.isArray(data?.timerPresets)
        ? data.timerPresets.length
        : 0,
      savedBillingViews: Array.isArray(data?.entryBillingViews)
        ? data.entryBillingViews.length
        : 0
    },
    projects: projects.map((project) => ({
      ...project,
      usage: presentWindows(projectUsage.get(project.id) || makeWindowBuckets())
    })),
    entries: normalizedEntries
  };
}
