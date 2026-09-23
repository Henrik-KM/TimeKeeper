import crypto from 'node:crypto';

import {
  DEFAULT_CLAUDE_POLICY,
  getClaudeModelFamily,
  normalizeClaudePolicy
} from '../src/features/claude/policy.mjs';
import {
  findTrackedProjectForCwd,
  getGitHubProjectPathInfo,
  getRepoNameFromCwd,
  normalizeTrackedProjects
} from './codex-usage-core.mjs';

function validDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseClaudeTranscript(
  text = '',
  { parentSessionId = '', agentId = '', windowStart = null } = {}
) {
  const cutoff =
    windowStart instanceof Date ? windowStart.getTime() : -Infinity;
  const events = [];
  let sessionId = String(parentSessionId || '').trim();
  let cwd = '';
  let foundAgentId = String(agentId || '').trim();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'user' && event?.type !== 'assistant') continue;
    const time = validDate(event.timestamp);
    if (!time || time.getTime() < cutoff) continue;
    sessionId ||= String(event.sessionId || '').trim();
    cwd ||= String(event.cwd || '').trim();
    foundAgentId ||= String(event.agentId || '').trim();
    events.push({
      time: time.getTime(),
      model:
        event.type === 'assistant' && event.message?.model !== '<synthetic>'
          ? getClaudeModelFamily(event.message?.model)
          : ''
    });
  }
  events.sort((left, right) => left.time - right.time);
  const initialModel = events.find((event) => event.model)?.model || 'unknown';
  let activeModel = initialModel;
  const activity = [];
  for (const event of events) {
    activeModel = event.model || activeModel;
    if (activity.at(-1)?.time === event.time) {
      activity[activity.length - 1].model = activeModel;
    } else {
      activity.push({ time: event.time, model: activeModel });
    }
  }
  return {
    sessionId,
    cwd,
    agentId: foundAgentId,
    isSubagent: Boolean(foundAgentId),
    activity
  };
}

function makeIntervals(session, policy) {
  const points = Array.isArray(session.activity) ? session.activity : [];
  const intervals = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const gap = current.time - previous.time;
    if (gap <= 0 || gap > policy.idleGapMinutes * 60000) continue;
    const model = getClaudeModelFamily(previous.model);
    const factor = policy.modelFactors[model];
    intervals.push({
      start: previous.time,
      end: current.time,
      model,
      factor,
      role: session.isSubagent ? 'subagent' : 'parent',
      agentId: session.agentId || '',
      creditMultiplier: session.isSubagent ? policy.delegationCredit : 1
    });
  }
  return intervals;
}

function splitAtIdleGaps(intervals, idleGapMs) {
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const groups = [];
  for (const interval of sorted) {
    const group = groups.at(-1);
    if (!group || interval.start - group.end > idleGapMs) {
      groups.push({
        start: interval.start,
        end: interval.end,
        intervals: [interval]
      });
    } else {
      group.end = Math.max(group.end, interval.end);
      group.intervals.push(interval);
    }
  }
  return groups;
}

function aggregateGroup(group) {
  const events = group.intervals
    .flatMap((interval, index) => [
      { time: interval.start, start: true, index, interval },
      { time: interval.end, start: false, index, interval }
    ])
    .sort(
      (left, right) =>
        left.time - right.time || Number(left.start) - Number(right.start)
    );
  const active = new Map();
  const breakdown = new Map();
  const agents = new Set();
  let wallMs = 0;
  let effectiveMs = 0;
  let lastTime = group.start;
  for (const event of events) {
    const gap = event.time - lastTime;
    if (gap > 0 && active.size) {
      wallMs += gap;
      for (const interval of active.values()) {
        const credited = interval.factor * interval.creditMultiplier;
        effectiveMs += gap * credited;
        if (interval.role === 'subagent' && interval.agentId) {
          agents.add(interval.agentId);
        }
        const key = `${interval.role}:${interval.model}`;
        const row = breakdown.get(key) || {
          role: interval.role,
          model: interval.model,
          factor: interval.factor,
          creditMultiplier: interval.creditMultiplier,
          wallMs: 0,
          effectiveMs: 0
        };
        row.wallMs += gap;
        row.effectiveMs += gap * credited;
        breakdown.set(key, row);
      }
    }
    if (event.start) active.set(event.index, event.interval);
    else active.delete(event.index);
    lastTime = event.time;
  }
  return {
    wallSeconds: Math.floor(wallMs / 1000),
    effectiveSeconds: Math.floor(effectiveMs / 1000),
    delegatedSessionCount: agents.size,
    modelBreakdown: [...breakdown.values()].map((row) => ({
      role: row.role,
      model: row.model,
      factor: row.factor,
      creditMultiplier: row.creditMultiplier,
      creditedFactor: Number((row.factor * row.creditMultiplier).toFixed(4)),
      wallSeconds: Math.floor(row.wallMs / 1000),
      effectiveSeconds: Math.floor(row.effectiveMs / 1000)
    }))
  };
}

export function buildClaudeUsageRecordsFromSessionGroup({
  sessions = [],
  trackedProjects = [],
  mappings = [],
  now = new Date(),
  policy = DEFAULT_CLAUDE_POLICY
} = {}) {
  const normalizedPolicy = normalizeClaudePolicy(policy);
  const parent = sessions.find((session) => !session.isSubagent);
  const root = parent || sessions[0];
  if (!root?.sessionId || !root.cwd) return [];
  const projects = normalizeTrackedProjects(trackedProjects);
  const matched = findTrackedProjectForCwd(root.cwd, projects, mappings);
  const project = projects.find(
    (item) => item.projectId === matched?.projectId
  );
  if (!project) return [];
  const repoName =
    getGitHubProjectPathInfo(root.cwd)?.repoName ||
    getRepoNameFromCwd(root.cwd);
  const intervals = sessions.flatMap((session) =>
    makeIntervals(session, normalizedPolicy)
  );
  return splitAtIdleGaps(intervals, normalizedPolicy.idleGapMinutes * 60000)
    .filter(
      (group) =>
        now.getTime() - group.end >= normalizedPolicy.matureMinutes * 60000
    )
    .map((group) => {
      const aggregate = aggregateGroup(group);
      if (!aggregate.wallSeconds || !aggregate.effectiveSeconds) return null;
      const startTime = new Date(group.start).toISOString();
      const endTime = new Date(group.end).toISOString();
      const parentStart = Math.min(
        ...group.intervals
          .filter((interval) => interval.role === 'parent')
          .map((interval) => interval.start)
      );
      const anchorTime = Number.isFinite(parentStart)
        ? parentStart
        : group.start;
      const hash = crypto
        .createHash('sha256')
        .update(
          `${root.sessionId}\u001f${project.projectId}\u001f${new Date(anchorTime).toISOString()}`
        )
        .digest('hex')
        .slice(0, 32);
      return {
        id: `claude:${hash}`,
        sessionId: root.sessionId,
        timekeeperProjectId: project.projectId,
        timekeeperProjectName: project.name,
        repoName,
        description: `Claude: ${repoName || project.name}`,
        startTime,
        endTime,
        ...aggregate,
        focusFactor: Number(
          (aggregate.effectiveSeconds / aggregate.wallSeconds).toFixed(4)
        ),
        focusPolicyVersion: normalizedPolicy.version,
        delegationCredit: normalizedPolicy.delegationCredit
      };
    })
    .filter(Boolean);
}
