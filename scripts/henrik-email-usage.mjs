import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildCodexUsageRecordsFromSessionData,
  DEFAULT_CODEX_FOCUS_FACTOR
} from './codex-usage-core.mjs';

export const EMAIL_USAGE_BACKFILL_DAYS = 90;
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
const tokenFields = new Set([
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens'
]);

export function validateEmailUsage(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !fields.has(key))) return null;
  if (
    value.schema_version !== 1 ||
    value.source !== 'henrik-email' ||
    value.project !== 'IFLAI' ||
    value.repository !== 'email-helper' ||
    value.model !== 'gpt-6.1-sol' ||
    value.reasoning_effort !== 'max' ||
    !sessionIdPattern.test(value.session_id) ||
    !['measured', 'legacy_file_time'].includes(value.timing_source) ||
    !['completed', 'failed', 'timeout', 'interrupted'].includes(value.outcome)
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
  return { ...value, start, end };
}

/** Read the small allowlisted feed; never open private authoring logs. */
export async function readEmailUsageRecords({
  directory,
  windowStart,
  trackedProjects = [],
  normalRecords = [],
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
    blocker: ''
  };
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], audit };
    throw error;
  }
  const project = trackedProjects.find(
    (candidate) =>
      String(candidate?.name || '')
        .trim()
        .toLowerCase() === 'iflai'
  );
  if (!project?.projectId) audit.blocker = 'iflai_project_not_configured';
  const knownSessions = new Set(normalRecords.map((record) => record.threadId));
  const records = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const id = file.name.slice(0, -5);
    if (!sessionIdPattern.test(id)) continue;
    audit.discovered += 1;
    let value;
    try {
      const filePath = path.join(directory, file.name);
      if ((await fs.stat(filePath)).size > 4096) throw new Error('oversize');
      value = validateEmailUsage(
        JSON.parse(await fs.readFile(filePath, 'utf8')),
        now
      );
    } catch {
      value = null;
    }
    if (!value || value.session_id !== id) {
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
    if (!project?.projectId) continue;
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
          projectId: project.projectId,
          projectName: project.name,
          repoName: 'email-helper'
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
