import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildCodexUsageRecordsFromSessionData,
  DEFAULT_CODEX_FOCUS_FACTOR,
  findTrackedProjectForSession
} from './codex-usage-core.mjs';

export const EMAIL_USAGE_BACKFILL_DAYS = 90;
export const AUTHORING_USAGE_SCHEMA_VERSION = 2;
const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fields = new Set([
  'schema_version',
  'source',
  'session_id',
  'project',
  'repository',
  'model',
  'reasoning_effort',
  'started_at',
  'finished_at',
  'duration_seconds',
  'timing_source',
  'outcome',
  'usage'
]);
const version2Fields = new Set([
  ...fields,
  'provider',
  'cwd',
  'parent_session_id'
]);
const workflowLabels = {
  'henrik-email': 'email drafting',
  'henrik-outreach': 'outreach',
  'henrik-writing': 'writing'
};
const tokenFields = new Set([
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens'
]);

export function validateEmailUsage(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const legacy = value.schema_version === 1;
  if (value.schema_version !== AUTHORING_USAGE_SCHEMA_VERSION && !legacy)
    return null;
  const allowedFields = legacy ? fields : version2Fields;
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  if (
    (legacy && value.source !== 'henrik-email') ||
    !Object.hasOwn(workflowLabels, value.source) ||
    (!legacy && !['codex', 'openai-responses'].includes(value.provider)) ||
    typeof value.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.model) ||
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(
      value.reasoning_effort
    ) ||
    typeof value.session_id !== 'string' ||
    !sessionIdPattern.test(value.session_id) ||
    !['measured', 'legacy_file_time'].includes(value.timing_source) ||
    !['completed', 'failed', 'timeout', 'interrupted'].includes(value.outcome)
  )
    return null;
  const writing = value.source === 'henrik-writing';
  if (writing) {
    if (
      value.project !== undefined ||
      value.repository !== undefined ||
      (value.cwd !== undefined &&
        (typeof value.cwd !== 'string' ||
          value.cwd.length > 1024 ||
          /[\r\n]/.test(value.cwd) ||
          value.cwd.includes('\0'))) ||
      (value.parent_session_id !== undefined &&
        (typeof value.parent_session_id !== 'string' ||
          !sessionIdPattern.test(value.parent_session_id)))
    )
      return null;
  } else if (
    value.project !== 'IFLAI' ||
    value.repository !== 'email-helper' ||
    value.cwd !== undefined ||
    value.parent_session_id !== undefined
  )
    return null;
  if (
    value.provider === 'openai-responses' &&
    value.timing_source !== 'measured'
  )
    return null;
  if (
    typeof value.started_at !== 'string' ||
    typeof value.finished_at !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value.started_at) ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value.finished_at)
  )
    return null;
  const start = new Date(value.started_at);
  const end = new Date(value.finished_at);
  const seconds = (end.getTime() - start.getTime()) / 1000;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 86400 ||
    end > now ||
    typeof value.duration_seconds !== 'number' ||
    !Number.isFinite(value.duration_seconds) ||
    Math.abs(seconds - value.duration_seconds) > 0.01
  )
    return null;
  const usage = value.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  if (
    Object.entries(usage).some(
      ([key, count]) =>
        !tokenFields.has(key) ||
        !Number.isSafeInteger(count) ||
        Number(count) < 0
    )
  )
    return null;
  if (
    value.provider === 'openai-responses' &&
    !usage.input_tokens &&
    !usage.output_tokens
  )
    return null;
  return { ...value, start, end };
}

async function authoringFiles(directory) {
  const runtimeRoot = path.dirname(path.dirname(path.dirname(directory)));
  const runtimeNames = ['henrik-outreach', 'henrik-writing'];
  const directories = [{ directory, source: 'henrik-email' }];
  if (path.basename(runtimeRoot).toLowerCase() === 'henrik-email') {
    directories.push(
      ...runtimeNames.map((source) => ({
        directory: path.join(
          path.dirname(runtimeRoot),
          source,
          '.local',
          'state',
          'timekeeper_usage'
        ),
        source
      }))
    );
  }
  return (
    await Promise.all(
      directories.map(async (entry) => {
        try {
          const files = await fs.readdir(entry.directory, {
            withFileTypes: true
          });
          return files
            .filter((file) => file.isFile() && file.name.endsWith('.json'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((file) => ({ ...entry, name: file.name }));
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      })
    )
  ).flat();
}

/** Read the small allowlisted feed; never open private authoring logs. */
export async function readEmailUsageRecords({
  directory,
  windowStart,
  trackedProjects = [],
  normalRecords = [],
  mappings = [],
  sessionMappings = [],
  focusFactor = DEFAULT_CODEX_FOCUS_FACTOR,
  focusPolicy = {},
  now = new Date()
}) {
  const audit = {
    source: 'henrik-email',
    discovered: 0,
    imported: 0,
    invalid: 0,
    outsideWindow: 0,
    duplicateSessions: 0,
    estimatedSessions: 0,
    unmappedWritingSessions: 0,
    blocker: ''
  };
  const files = await authoringFiles(directory);
  const project = trackedProjects.find(
    (candidate) =>
      String(candidate?.name || '')
        .trim()
        .toLowerCase() === 'iflai'
  );
  const tracedSessions = new Map(
    normalRecords.map((record) => [record.threadId, record])
  );
  const knownSessions = new Set(tracedSessions.keys());
  const records = [];
  for (const file of files) {
    const id = file.name.slice(0, -5);
    if (!sessionIdPattern.test(id)) continue;
    audit.discovered += 1;
    let value;
    try {
      const filePath = path.join(file.directory, file.name);
      if ((await fs.stat(filePath)).size > 4096) throw new Error('oversize');
      value = validateEmailUsage(
        JSON.parse(await fs.readFile(filePath, 'utf8')),
        now
      );
    } catch {
      value = null;
    }
    if (value?.schema_version === 1 && file.source === 'henrik-outreach') {
      continue; // Historical outreach receipts were not labeled by their workflow.
    }
    if (!value || value.session_id !== id || value.source !== file.source) {
      audit.invalid += 1;
      continue;
    }
    if (value.start < windowStart) {
      audit.outsideWindow += 1;
      continue;
    }
    if (knownSessions.has(id)) {
      audit.duplicateSessions += 1;
      continue;
    }
    let assignment;
    if (value.source === 'henrik-writing') {
      const parent = tracedSessions.get(value.parent_session_id);
      assignment = parent?.timekeeperProjectId
        ? {
            projectId: parent.timekeeperProjectId,
            projectName: parent.timekeeperProjectName,
            repoName: parent.projectKey
          }
        : findTrackedProjectForSession(
            { id: value.parent_session_id || id, cwd: value.cwd },
            trackedProjects,
            mappings,
            sessionMappings
          );
      if (!assignment?.projectId) {
        audit.unmappedWritingSessions += 1;
        continue;
      }
    } else {
      if (!project?.projectId) {
        audit.blocker = 'iflai_project_not_configured';
        continue;
      }
      assignment = {
        projectId: project.projectId,
        projectName: project.name,
        repoName: 'email-helper'
      };
    }
    const activity = [value.start, value.end].map((timestamp) => ({
      timestamp,
      model: value.model,
      effort: value.reasoning_effort,
      fastMode: false
    }));
    const usageRecords = buildCodexUsageRecordsFromSessionData({
      meta: { id },
      activity,
      trackedProjects,
      sessionMappings: [
        {
          sessionId: id,
          ...assignment
        }
      ],
      now,
      focusFactor,
      focusPolicy,
      // The completed invocation is one measured active process interval.
      // Ordinary chat idle gaps and the maturity delay do not apply to it.
      idleGapMs: value.duration_seconds * 1000 + 1,
      matureMs: 0
    });
    for (const record of usageRecords) {
      records.push({
        ...record,
        ...(value.schema_version === 2
          ? {
              description: `${value.provider === 'openai-responses' ? 'API' : 'Codex'}: ${workflowLabels[value.source]}`,
              executionProvider: value.provider,
              authoringWorkflow: value.source
            }
          : {}),
        usageSource: 'henrik-email',
        timingSource: value.timing_source,
        executionOutcome: value.outcome,
        tokenUsage: value.usage
      });
    }
    knownSessions.add(id);
    audit.imported += usageRecords.length;
    if (usageRecords.length && value.timing_source === 'legacy_file_time') {
      audit.estimatedSessions += 1;
    }
  }
  return { records, audit };
}
