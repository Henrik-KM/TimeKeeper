import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_FOCUS_FACTOR = 0.5;
export const DEFAULT_IDLE_GAP_MS = 15 * 60 * 1000;
export const DEFAULT_MATURE_MS = 17 * 60 * 1000;
export const DEFAULT_CODEX_LOOKBACK_DAYS = 7;
export const DEFAULT_CODEX_FOCUS_POLICY = {
  version: 2,
  defaultFactor: DEFAULT_CODEX_FOCUS_FACTOR,
  minimumFactor: 0.25,
  maximumFactor: 0.8,
  delegationCredit: 0.35,
  modelBaseFactors: {
    luna: 0.35,
    terra: 0.45,
    sol: 0.55
  },
  modelOverrides: {},
  effortAdjustments: {
    low: -0.05,
    medium: 0,
    high: 0.05,
    xhigh: 0.1,
    max: 0.15,
    ultra: 0.15
  }
};

function getFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumberMap(value, fallback, { positiveOnly = false } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = { ...fallback };
  Object.entries(source).forEach(([key, rawValue]) => {
    const name = String(key || '')
      .trim()
      .toLowerCase();
    const number = Number(rawValue);
    if (!name || !Number.isFinite(number) || (positiveOnly && number <= 0)) {
      return;
    }
    normalized[name] = number;
  });
  return normalized;
}

export function normalizeCodexFocusPolicy(
  value = {},
  fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
) {
  const source = /** @type {Record<string, any>} */ (
    value && typeof value === 'object' ? value : {}
  );
  const minimumFactor = Math.max(
    0.01,
    getFiniteNumber(
      source.minimumFactor,
      DEFAULT_CODEX_FOCUS_POLICY.minimumFactor
    )
  );
  const maximumFactor = Math.max(
    minimumFactor,
    getFiniteNumber(
      source.maximumFactor,
      DEFAULT_CODEX_FOCUS_POLICY.maximumFactor
    )
  );
  const requestedDefault = getFiniteNumber(
    source.defaultFactor,
    getFiniteNumber(fallbackFactor, DEFAULT_CODEX_FOCUS_FACTOR)
  );
  return {
    version: Math.max(
      1,
      Math.floor(
        getFiniteNumber(source.version, DEFAULT_CODEX_FOCUS_POLICY.version)
      )
    ),
    defaultFactor: Math.min(
      maximumFactor,
      Math.max(minimumFactor, requestedDefault)
    ),
    minimumFactor,
    maximumFactor,
    delegationCredit: Math.max(
      0,
      getFiniteNumber(
        source.delegationCredit,
        DEFAULT_CODEX_FOCUS_POLICY.delegationCredit
      )
    ),
    modelBaseFactors: normalizeNumberMap(
      source.modelBaseFactors,
      DEFAULT_CODEX_FOCUS_POLICY.modelBaseFactors,
      { positiveOnly: true }
    ),
    modelOverrides: normalizeNumberMap(
      source.modelOverrides,
      {},
      {
        positiveOnly: true
      }
    ),
    effortAdjustments: normalizeNumberMap(
      source.effortAdjustments,
      DEFAULT_CODEX_FOCUS_POLICY.effortAdjustments
    )
  };
}

export function normalizeCodexEffort(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (normalized === 'light') return 'low';
  if (normalized === 'extra-high' || normalized === 'extra-high-reasoning') {
    return 'xhigh';
  }
  return normalized;
}

/**
 * @param {{
 *   model?: string,
 *   effort?: string,
 *   policy: ReturnType<typeof normalizeCodexFocusPolicy>
 * }} options
 */
function resolveNormalizedCodexFocusFactor({
  model = '',
  effort = '',
  policy
}) {
  const normalizedModel = String(model || '')
    .trim()
    .toLowerCase();
  const normalizedEffort = normalizeCodexEffort(effort);
  let modelFamily = '';
  let baseFactor = policy.modelOverrides[normalizedModel];
  let hasModelRule = Number.isFinite(baseFactor);
  if (!Number.isFinite(baseFactor)) {
    const modelParts = normalizedModel.split(/[-_.]+/).filter(Boolean);
    modelFamily = Object.keys(policy.modelBaseFactors).find((family) =>
      modelParts.includes(family)
    );
    baseFactor = modelFamily
      ? policy.modelBaseFactors[modelFamily]
      : policy.defaultFactor;
    hasModelRule = !!modelFamily;
  }
  const adjustment = hasModelRule
    ? getFiniteNumber(policy.effortAdjustments[normalizedEffort], 0)
    : 0;
  const factor = Number(
    Math.min(
      policy.maximumFactor,
      Math.max(policy.minimumFactor, baseFactor + adjustment)
    ).toFixed(4)
  );
  return {
    factor,
    model: normalizedModel,
    modelFamily,
    effort: normalizedEffort,
    policyVersion: policy.version,
    source: hasModelRule ? 'model-effort' : 'default'
  };
}

export function resolveCodexFocusFactor({
  model = '',
  effort = '',
  focusPolicy = {},
  fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
} = {}) {
  return resolveNormalizedCodexFocusFactor({
    model,
    effort,
    policy: normalizeCodexFocusPolicy(focusPolicy, fallbackFactor)
  });
}

export function getLocalDayStart(referenceDate = new Date()) {
  return new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  );
}

export function getLocalLookbackStart(
  referenceDate = new Date(),
  days = DEFAULT_CODEX_LOOKBACK_DAYS
) {
  const normalizedDays = Math.max(1, Math.floor(Number(days) || 1));
  const start = getLocalDayStart(referenceDate);
  start.setDate(start.getDate() - (normalizedDays - 1));
  return start;
}

export function sanitizeMachineId(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'desktop';
}

export function getDefaultMachineId() {
  return sanitizeMachineId(
    [os.hostname(), process.env.USERNAME || process.env.USER || 'user'].join(
      '-'
    )
  );
}

export function getRepoNameFromCwd(cwd = '') {
  const normalized = String(cwd || '').trim();
  if (!normalized) return '';
  return path.basename(normalized.replace(/[\\/]+$/g, ''));
}

export function getGitHubProjectPathInfo(cwd = '') {
  const normalized = String(cwd || '').trim();
  if (!normalized) return null;
  const parts = normalized
    .replace(/[\\/]+$/g, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  const gitHubIndex = parts
    .map((part) => part.toLowerCase())
    .lastIndexOf('github');
  if (gitHubIndex < 0) return null;
  const projectFolder = parts[gitHubIndex + 1] || '';
  const repoName = parts[gitHubIndex + 2] || projectFolder;
  if (!projectFolder) return null;
  return { projectFolder, repoName };
}

export function normalizeTrackedProjects(projects = []) {
  if (!Array.isArray(projects)) return [];
  return projects
    .map((project) => {
      const obj = project && typeof project === 'object' ? project : {};
      const name = String(obj.name || obj.projectName || '').trim();
      const projectId = String(
        obj.projectId || obj.timekeeperProjectId || obj.id || ''
      ).trim();
      if (!name || !projectId) return null;
      return { name, projectId };
    })
    .filter(Boolean);
}

export function normalizeCodexMappings(mappings = []) {
  if (!Array.isArray(mappings)) return [];
  return mappings
    .map((mapping) => {
      const obj = mapping && typeof mapping === 'object' ? mapping : {};
      const matchType =
        obj.matchType === 'pathIncludes' ? 'pathIncludes' : 'repoName';
      const match = String(obj.match || obj.repoName || '').trim();
      if (!match) return null;
      const projectId =
        obj.projectId === null
          ? null
          : String(obj.projectId || obj.timekeeperProjectId || '').trim();
      return {
        matchType,
        match,
        projectId: projectId || null
      };
    })
    .filter(Boolean);
}

export function findCodexMappingForCwd(cwd = '', mappings = []) {
  const normalizedMappings = normalizeCodexMappings(mappings);
  const repoName = getRepoNameFromCwd(cwd);
  const lowerRepoName = repoName.toLowerCase();
  const lowerCwd = String(cwd || '').toLowerCase();
  const mapping = normalizedMappings.find((candidate) => {
    const lowerMatch = candidate.match.toLowerCase();
    if (candidate.matchType === 'pathIncludes') {
      return lowerCwd.includes(lowerMatch);
    }
    return lowerRepoName === lowerMatch;
  });
  return mapping ? { ...mapping, repoName } : null;
}

export function findTrackedProjectForCwd(
  cwd = '',
  trackedProjects = [],
  fallbackMappings = []
) {
  const pathInfo = getGitHubProjectPathInfo(cwd);
  const normalizedProjects = normalizeTrackedProjects(trackedProjects);
  if (pathInfo) {
    const lowerProjectFolder = pathInfo.projectFolder.toLowerCase();
    const project = normalizedProjects.find(
      (candidate) => candidate.name.toLowerCase() === lowerProjectFolder
    );
    if (project) {
      return {
        matchType: 'githubParentFolder',
        match: pathInfo.projectFolder,
        projectId: project.projectId,
        projectName: project.name,
        repoName: pathInfo.repoName
      };
    }
    if (normalizedProjects.length) return null;
  }
  const mapping = findCodexMappingForCwd(cwd, fallbackMappings);
  if (!mapping) return null;
  return {
    ...mapping,
    projectName: ''
  };
}

export function parseCodexJsonl(text = '') {
  const events = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        events.push(parsed);
      } catch {
        // Ignore partial/truncated lines from a session that is still writing.
      }
    });
  return events;
}

export function getCodexSessionMeta(events = []) {
  const metaEvent = events.find((event) => event?.type === 'session_meta');
  const payload = metaEvent?.payload || {};
  const firstTimestamp = events
    .map((event) => parseTimestamp(event?.timestamp))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    id: String(payload.id || '').trim(),
    cwd: String(payload.cwd || '').trim(),
    timestamp: parseTimestamp(payload.timestamp) || firstTimestamp || null
  };
}

export function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getSessionEventTimestamps(events = [], dayStart = null) {
  const minTime = dayStart instanceof Date ? dayStart.getTime() : null;
  const timestamps = events
    .map((event) => parseTimestamp(event?.timestamp))
    .filter((date) => date && (minTime === null || date.getTime() >= minTime))
    .sort((a, b) => a.getTime() - b.getTime());
  const unique = [];
  let lastTime = null;
  timestamps.forEach((date) => {
    const time = date.getTime();
    if (time !== lastTime) {
      unique.push(date);
      lastTime = time;
    }
  });
  return unique;
}

export function getCodexSessionActivity(events = [], dayStart = null) {
  const minTime = dayStart instanceof Date ? dayStart.getTime() : null;
  let activeModel = '';
  let activeEffort = '';
  const activity = [];
  events.forEach((event) => {
    if (event?.type === 'turn_context') {
      activeModel = String(event?.payload?.model || activeModel || '').trim();
      activeEffort = String(
        event?.payload?.effort ||
          event?.payload?.reasoning_effort ||
          activeEffort ||
          ''
      ).trim();
    }
    const timestamp = parseTimestamp(event?.timestamp);
    if (!timestamp || (minTime !== null && timestamp.getTime() < minTime)) {
      return;
    }
    const point = {
      timestamp,
      model: activeModel,
      effort: activeEffort
    };
    const previous = activity[activity.length - 1];
    if (previous && previous.timestamp.getTime() === timestamp.getTime()) {
      activity[activity.length - 1] = point;
    } else {
      activity.push(point);
    }
  });
  return activity.sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
  );
}

export function buildActiveSpans(
  timestamps = [],
  {
    idleGapMs = DEFAULT_IDLE_GAP_MS,
    matureMs = DEFAULT_MATURE_MS,
    now = new Date()
  } = {}
) {
  if (!Array.isArray(timestamps) || timestamps.length < 2) return [];
  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const spans = [];
  let spanStart = sorted[0];
  let spanEnd = sorted[0];
  let activeMs = 0;
  const closeSpan = () => {
    if (activeMs > 0) {
      spans.push({ start: spanStart, end: spanEnd, activeMs });
    }
  };
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gap = current.getTime() - previous.getTime();
    if (gap > idleGapMs) {
      closeSpan();
      spanStart = current;
      spanEnd = current;
      activeMs = 0;
      continue;
    }
    activeMs += Math.max(0, gap);
    spanEnd = current;
  }
  if (now.getTime() - spanEnd.getTime() >= matureMs) {
    closeSpan();
  }
  return spans;
}

export function buildModelWeightedActiveSpans(
  activity = [],
  {
    idleGapMs = DEFAULT_IDLE_GAP_MS,
    matureMs = DEFAULT_MATURE_MS,
    now = new Date(),
    focusPolicy = {},
    fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
  } = {}
) {
  if (!Array.isArray(activity) || activity.length < 2) return [];
  const sorted = activity
    .map((point) => ({
      timestamp:
        point?.timestamp instanceof Date
          ? point.timestamp
          : parseTimestamp(point?.timestamp),
      model: String(point?.model || '').trim(),
      effort: String(point?.effort || '').trim()
    }))
    .filter((point) => point.timestamp)
    .sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
    );
  if (sorted.length < 2) return [];
  const policy = normalizeCodexFocusPolicy(focusPolicy, fallbackFactor);
  const spans = [];
  let spanStart = sorted[0].timestamp;
  let spanEnd = sorted[0].timestamp;
  let activeMs = 0;
  let effectiveMs = 0;
  let breakdown = new Map();
  const closeSpan = () => {
    if (activeMs <= 0) return;
    const modelBreakdown = Array.from(breakdown.values()).map((item) => ({
      model: item.model || 'unknown',
      effort: item.effort || 'unknown',
      factor: item.factor,
      wallSeconds: Math.floor(item.wallMs / 1000),
      effectiveSeconds: Math.floor(item.effectiveMs / 1000)
    }));
    spans.push({
      start: spanStart,
      end: spanEnd,
      activeMs,
      effectiveMs,
      focusFactor: effectiveMs / activeMs,
      focusPolicyVersion: policy.version,
      modelBreakdown
    });
  };
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gap = current.timestamp.getTime() - previous.timestamp.getTime();
    if (gap > idleGapMs) {
      closeSpan();
      spanStart = current.timestamp;
      spanEnd = current.timestamp;
      activeMs = 0;
      effectiveMs = 0;
      breakdown = new Map();
      continue;
    }
    if (gap <= 0) continue;
    const resolved = resolveNormalizedCodexFocusFactor({
      model: previous.model,
      effort: previous.effort,
      policy
    });
    const weightedGap = gap * resolved.factor;
    activeMs += gap;
    effectiveMs += weightedGap;
    spanEnd = current.timestamp;
    const key = [resolved.model, resolved.effort, resolved.factor].join(
      '\u001f'
    );
    const currentBreakdown = breakdown.get(key) || {
      model: resolved.model,
      effort: resolved.effort,
      factor: resolved.factor,
      wallMs: 0,
      effectiveMs: 0
    };
    currentBreakdown.wallMs += gap;
    currentBreakdown.effectiveMs += weightedGap;
    breakdown.set(key, currentBreakdown);
  }
  if (now.getTime() - spanEnd.getTime() >= matureMs) {
    closeSpan();
  }
  return spans;
}

export function makeCodexRecordId(parts = []) {
  const hash = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 24);
  return `codex-${hash}`;
}

/**
 * @param {{
 *   meta?: { id?: string, cwd?: string },
 *   timestamps?: Array<Date>,
 *   activity?: Array<{ timestamp: Date, model?: string, effort?: string }>,
 *   trackedProjects?: Array<object>,
 *   mappings?: Array<object>,
 *   threadNamesById?: Map<string, string>,
 *   now?: Date,
 *   idleGapMs?: number,
 *   matureMs?: number,
 *   focusFactor?: number,
 *   focusPolicy?: object,
 *   sourceFile?: string
 * }} options
 */
export function buildCodexUsageRecordsFromSessionData({
  meta = {},
  timestamps = [],
  activity = [],
  trackedProjects,
  mappings,
  threadNamesById = new Map(),
  now = new Date(),
  idleGapMs = DEFAULT_IDLE_GAP_MS,
  matureMs = DEFAULT_MATURE_MS,
  focusFactor = DEFAULT_CODEX_FOCUS_FACTOR,
  focusPolicy = {},
  sourceFile = ''
} = {}) {
  const projectMatch = findTrackedProjectForCwd(
    meta.cwd,
    trackedProjects,
    mappings
  );
  if (!projectMatch || !projectMatch.projectId) return [];
  const normalizedPolicy = normalizeCodexFocusPolicy(focusPolicy, focusFactor);
  const spans = activity.length
    ? buildModelWeightedActiveSpans(activity, {
        idleGapMs,
        matureMs,
        now,
        focusPolicy: normalizedPolicy,
        fallbackFactor: normalizedPolicy.defaultFactor
      })
    : buildActiveSpans(timestamps, { idleGapMs, matureMs, now }).map(
        (span) => ({
          ...span,
          effectiveMs: span.activeMs * normalizedPolicy.defaultFactor,
          focusFactor: normalizedPolicy.defaultFactor,
          focusPolicyVersion: normalizedPolicy.version,
          modelBreakdown: []
        })
      );
  const threadName = threadNamesById.get(meta.id) || '';
  return spans
    .map((span) => {
      const wallSeconds = Math.floor(span.activeMs / 1000);
      const effectiveSeconds = Math.floor(span.effectiveMs / 1000);
      if (wallSeconds <= 0 || effectiveSeconds <= 0) return null;
      const recordFocusFactor = Number(span.focusFactor.toFixed(4));
      const startIso = span.start.toISOString();
      const endIso = span.end.toISOString();
      return {
        id: makeCodexRecordId([
          meta.id || sourceFile,
          projectMatch.projectId,
          startIso,
          endIso,
          wallSeconds
        ]),
        threadId: meta.id || null,
        projectKey: projectMatch.repoName,
        timekeeperProjectId: projectMatch.projectId,
        timekeeperProjectName: projectMatch.projectName || '',
        startTime: startIso,
        endTime: endIso,
        wallSeconds,
        focusFactor: recordFocusFactor,
        effectiveSeconds,
        focusPolicyVersion: span.focusPolicyVersion,
        modelBreakdown: span.modelBreakdown,
        description: threadName
          ? `Codex: ${threadName}`
          : `Codex: ${projectMatch.repoName}`
      };
    })
    .filter(Boolean);
}

function buildCodexActivityIntervals(
  session,
  {
    idleGapMs = DEFAULT_IDLE_GAP_MS,
    focusPolicy = {},
    fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
  } = {}
) {
  const activity = Array.isArray(session?.activity) ? session.activity : [];
  const sorted = activity
    .map((point) => ({
      timestamp:
        point?.timestamp instanceof Date
          ? point.timestamp
          : parseTimestamp(point?.timestamp),
      model: String(point?.model || '').trim(),
      effort: String(point?.effort || '').trim()
    }))
    .filter((point) => point.timestamp)
    .sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
    );
  const policy = normalizeCodexFocusPolicy(focusPolicy, fallbackFactor);
  const isSubagent = session?.meta?.isSubagent === true;
  const role = isSubagent ? 'subagent' : 'parent';
  const creditMultiplier = isSubagent ? policy.delegationCredit : 1;
  const intervals = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gap = current.timestamp.getTime() - previous.timestamp.getTime();
    if (gap <= 0 || gap > idleGapMs) continue;
    const resolved = resolveNormalizedCodexFocusFactor({
      model: previous.model,
      effort: previous.effort,
      policy
    });
    const interval = {
      start: previous.timestamp,
      end: current.timestamp,
      factor: resolved.factor,
      creditedFactor: Number((resolved.factor * creditMultiplier).toFixed(4)),
      creditMultiplier,
      model: resolved.model,
      effort: resolved.effort,
      role,
      sessionId: String(session?.meta?.id || '').trim()
    };
    const last = intervals[intervals.length - 1];
    if (
      last &&
      last.end.getTime() === interval.start.getTime() &&
      last.factor === interval.factor &&
      last.model === interval.model &&
      last.effort === interval.effort &&
      last.role === interval.role &&
      last.sessionId === interval.sessionId
    ) {
      last.end = interval.end;
    } else {
      intervals.push(interval);
    }
  }
  return intervals;
}

function splitCodexIntervalsAtIdleGaps(
  intervals = [],
  idleGapMs = DEFAULT_IDLE_GAP_MS
) {
  const sorted = [...intervals].sort(
    (left, right) =>
      left.start.getTime() - right.start.getTime() ||
      left.end.getTime() - right.end.getTime()
  );
  const groups = [];
  let current = [];
  let currentEnd = null;
  sorted.forEach((interval) => {
    if (
      currentEnd &&
      interval.start.getTime() - currentEnd.getTime() > idleGapMs
    ) {
      groups.push(current);
      current = [];
      currentEnd = null;
    }
    current.push(interval);
    if (!currentEnd || interval.end > currentEnd) currentEnd = interval.end;
  });
  if (current.length) groups.push(current);
  return groups;
}

function aggregateCodexIntervals(intervals = []) {
  const events = intervals
    .flatMap((interval, index) => [
      { time: interval.start.getTime(), type: 'start', index, interval },
      { time: interval.end.getTime(), type: 'end', index, interval }
    ])
    .sort((left, right) => left.time - right.time);
  if (events.length < 2) return null;
  const active = new Map();
  const breakdown = new Map();
  const delegatedSessions = new Set();
  let wallMs = 0;
  let effectiveMs = 0;
  let previousTime = events[0].time;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    const currentTime = events[eventIndex].time;
    const elapsedMs = currentTime - previousTime;
    if (elapsedMs > 0 && active.size) {
      wallMs += elapsedMs;
      let combinedFactor = 0;
      active.forEach((interval) => {
        combinedFactor += interval.creditedFactor;
        if (interval.role === 'subagent' && interval.sessionId) {
          delegatedSessions.add(interval.sessionId);
        }
        const key = [
          interval.role,
          interval.model,
          interval.effort,
          interval.factor,
          interval.creditMultiplier
        ].join('\u001f');
        const item = breakdown.get(key) || {
          role: interval.role,
          model: interval.model,
          effort: interval.effort,
          factor: interval.factor,
          creditMultiplier: interval.creditMultiplier,
          wallMs: 0,
          effectiveMs: 0
        };
        item.wallMs += elapsedMs;
        item.effectiveMs += elapsedMs * interval.creditedFactor;
        breakdown.set(key, item);
      });
      effectiveMs += elapsedMs * combinedFactor;
    }
    const simultaneous = [];
    while (
      eventIndex < events.length &&
      events[eventIndex].time === currentTime
    ) {
      simultaneous.push(events[eventIndex]);
      eventIndex += 1;
    }
    simultaneous
      .filter((event) => event.type === 'end')
      .forEach((event) => active.delete(event.index));
    simultaneous
      .filter((event) => event.type === 'start')
      .forEach((event) => active.set(event.index, event.interval));
    previousTime = currentTime;
  }
  if (wallMs <= 0 || effectiveMs <= 0) return null;
  const modelBreakdown = Array.from(breakdown.values())
    .map((item) => ({
      role: item.role,
      model: item.model || 'unknown',
      effort: item.effort || 'unknown',
      factor: item.factor,
      creditMultiplier: item.creditMultiplier,
      creditedFactor: Number((item.factor * item.creditMultiplier).toFixed(4)),
      wallSeconds: Math.floor(item.wallMs / 1000),
      effectiveSeconds: Math.floor(item.effectiveMs / 1000)
    }))
    .sort((left, right) => String(left.role).localeCompare(String(right.role)));
  return {
    start: new Date(events[0].time),
    end: new Date(events[events.length - 1].time),
    wallMs,
    effectiveMs,
    focusFactor: effectiveMs / wallMs,
    delegatedSessionCount: delegatedSessions.size,
    modelBreakdown
  };
}

/**
 * @param {{
 *   sessions?: Array<{
 *     meta?: {
 *       id?: string,
 *       sessionId?: string,
 *       cwd?: string,
 *       isSubagent?: boolean
 *     },
 *     activity?: Array<{ timestamp: Date, model?: string, effort?: string }>,
 *     sourceFile?: string
 *   }>,
 *   trackedProjects?: Array<object>,
 *   mappings?: Array<object>,
 *   threadNamesById?: Map<string, string>,
 *   now?: Date,
 *   idleGapMs?: number,
 *   matureMs?: number,
 *   focusFactor?: number,
 *   focusPolicy?: object
 * }} options
 * @returns {Array<Record<string, any>>}
 */
export function buildCodexUsageRecordsFromSessionGroup({
  sessions = [],
  trackedProjects,
  mappings,
  threadNamesById = new Map(),
  now = new Date(),
  idleGapMs = DEFAULT_IDLE_GAP_MS,
  matureMs = DEFAULT_MATURE_MS,
  focusFactor = DEFAULT_CODEX_FOCUS_FACTOR,
  focusPolicy = {}
} = {}) {
  const usableSessions = sessions.filter(
    (session) => session?.meta?.id && Array.isArray(session?.activity)
  );
  if (!usableSessions.length) return [];
  const hasSubagents = usableSessions.some(
    (session) => session.meta.isSubagent === true
  );
  if (!hasSubagents) {
    return usableSessions.flatMap((session) =>
      buildCodexUsageRecordsFromSessionData({
        ...session,
        trackedProjects,
        mappings,
        threadNamesById,
        now,
        idleGapMs,
        matureMs,
        focusFactor,
        focusPolicy,
        sourceFile: session.sourceFile || ''
      })
    );
  }
  const parent =
    usableSessions.find((session) => session.meta.isSubagent !== true) ||
    usableSessions[0];
  const rootSessionId = String(
    parent.meta.sessionId ||
      parent.meta.id ||
      usableSessions[0].meta.sessionId ||
      usableSessions[0].meta.id
  ).trim();
  const parentMeta = {
    ...parent.meta,
    id: rootSessionId
  };
  const projectMatch = findTrackedProjectForCwd(
    parentMeta.cwd,
    trackedProjects,
    mappings
  );
  if (!projectMatch || !projectMatch.projectId) return [];
  const normalizedPolicy = normalizeCodexFocusPolicy(focusPolicy, focusFactor);
  const intervals = usableSessions.flatMap((session) =>
    buildCodexActivityIntervals(session, {
      idleGapMs,
      focusPolicy: normalizedPolicy,
      fallbackFactor: normalizedPolicy.defaultFactor
    })
  );
  const collectiveGroups = splitCodexIntervalsAtIdleGaps(intervals, idleGapMs);
  const legacyRecords = usableSessions.flatMap((session) =>
    buildCodexUsageRecordsFromSessionData({
      ...session,
      meta: {
        ...session.meta,
        id: rootSessionId
      },
      trackedProjects,
      mappings,
      threadNamesById,
      now,
      idleGapMs,
      matureMs,
      focusFactor,
      focusPolicy: normalizedPolicy,
      sourceFile: session.sourceFile || ''
    })
  );
  const threadName = threadNamesById.get(rootSessionId) || '';
  return collectiveGroups
    .map((group, index) => {
      const span = aggregateCodexIntervals(group);
      if (!span) return null;
      const isLast = index === collectiveGroups.length - 1;
      if (isLast && now.getTime() - span.end.getTime() < matureMs) return null;
      const wallSeconds = Math.floor(span.wallMs / 1000);
      const effectiveSeconds = Math.floor(span.effectiveMs / 1000);
      if (wallSeconds <= 0 || effectiveSeconds <= 0) return null;
      const startIso = span.start.toISOString();
      const endIso = span.end.toISOString();
      const supersedesExternalIds = legacyRecords
        .filter((record) => {
          const start = parseTimestamp(record.startTime);
          const end = parseTimestamp(record.endTime);
          return start && end && start < span.end && end > span.start;
        })
        .map((record) => record.id);
      return {
        id: makeCodexRecordId([
          rootSessionId,
          projectMatch.projectId,
          startIso,
          'delegated-v1'
        ]),
        threadId: rootSessionId,
        projectKey: projectMatch.repoName,
        timekeeperProjectId: projectMatch.projectId,
        timekeeperProjectName: projectMatch.projectName || '',
        startTime: startIso,
        endTime: endIso,
        wallSeconds,
        focusFactor: Number(span.focusFactor.toFixed(4)),
        effectiveSeconds,
        focusPolicyVersion: normalizedPolicy.version,
        delegationCredit: normalizedPolicy.delegationCredit,
        delegatedSessionCount: span.delegatedSessionCount,
        modelBreakdown: span.modelBreakdown,
        supersedesExternalIds: [...new Set(supersedesExternalIds)],
        description: threadName
          ? `Codex: ${threadName}`
          : `Codex: ${projectMatch.repoName}`
      };
    })
    .filter(Boolean);
}

/**
 * @param {{
 *   text?: string,
 *   trackedProjects?: Array<object>,
 *   mappings?: Array<object>,
 *   threadNamesById?: Map<string, string>,
 *   dayStart?: Date,
 *   now?: Date,
 *   idleGapMs?: number,
 *   matureMs?: number,
 *   focusFactor?: number,
 *   focusPolicy?: object,
 *   sourceFile?: string
 * }} options
 */
export function buildCodexUsageRecordsFromSessionText({
  text,
  trackedProjects,
  mappings,
  threadNamesById = new Map(),
  dayStart = getLocalDayStart(),
  now = new Date(),
  idleGapMs = DEFAULT_IDLE_GAP_MS,
  matureMs = DEFAULT_MATURE_MS,
  focusFactor = DEFAULT_CODEX_FOCUS_FACTOR,
  focusPolicy = {},
  sourceFile = ''
} = {}) {
  const events = parseCodexJsonl(text);
  const meta = getCodexSessionMeta(events);
  const activity = getCodexSessionActivity(events, dayStart);
  const timestamps = activity.map((point) => point.timestamp);
  return buildCodexUsageRecordsFromSessionData({
    meta,
    timestamps,
    activity,
    trackedProjects,
    mappings,
    threadNamesById,
    now,
    idleGapMs,
    matureMs,
    focusFactor,
    focusPolicy,
    sourceFile
  });
}
