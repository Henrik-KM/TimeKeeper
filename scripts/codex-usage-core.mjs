import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_FOCUS_FACTOR = 0.5;
export const DEFAULT_IDLE_GAP_MS = 15 * 60 * 1000;
export const DEFAULT_MATURE_MS = 17 * 60 * 1000;
export const DEFAULT_CODEX_LOOKBACK_DAYS = 7;

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
  const repoName = parts[gitHubIndex + 2] || '';
  if (!projectFolder || !repoName) return null;
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
 *   trackedProjects?: Array<object>,
 *   mappings?: Array<object>,
 *   threadNamesById?: Map<string, string>,
 *   now?: Date,
 *   idleGapMs?: number,
 *   matureMs?: number,
 *   focusFactor?: number,
 *   sourceFile?: string
 * }} options
 */
export function buildCodexUsageRecordsFromSessionData({
  meta = {},
  timestamps = [],
  trackedProjects,
  mappings,
  threadNamesById = new Map(),
  now = new Date(),
  idleGapMs = DEFAULT_IDLE_GAP_MS,
  matureMs = DEFAULT_MATURE_MS,
  focusFactor = DEFAULT_CODEX_FOCUS_FACTOR,
  sourceFile = ''
} = {}) {
  const projectMatch = findTrackedProjectForCwd(
    meta.cwd,
    trackedProjects,
    mappings
  );
  if (!projectMatch || !projectMatch.projectId) return [];
  const spans = buildActiveSpans(timestamps, { idleGapMs, matureMs, now });
  const threadName = threadNamesById.get(meta.id) || '';
  return spans
    .map((span) => {
      const wallSeconds = Math.floor(span.activeMs / 1000);
      const effectiveSeconds = Math.floor(wallSeconds * focusFactor);
      if (wallSeconds <= 0 || effectiveSeconds <= 0) return null;
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
        focusFactor,
        effectiveSeconds,
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
  sourceFile = ''
} = {}) {
  const events = parseCodexJsonl(text);
  const meta = getCodexSessionMeta(events);
  const timestamps = getSessionEventTimestamps(events, dayStart);
  return buildCodexUsageRecordsFromSessionData({
    meta,
    timestamps,
    trackedProjects,
    mappings,
    threadNamesById,
    now,
    idleGapMs,
    matureMs,
    focusFactor,
    sourceFile
  });
}
