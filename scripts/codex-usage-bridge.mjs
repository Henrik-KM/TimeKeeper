import { createReadStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildCodexUsageRecordsFromSessionGroup,
  DEFAULT_CODEX_LOOKBACK_DAYS,
  getDefaultMachineId,
  getLocalDayStart,
  getLocalLookbackStart,
  parseTimestamp,
  sanitizeMachineId
} from './codex-usage-core.mjs';

const defaultRepository = 'Henrik-KM/TimeKeeper';
const defaultBranch = 'main';
const defaultConfigPath = 'assets/timekeeper-codex-config.json';
const defaultInboxPath = 'assets/timekeeper-codex-inbox';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  argv.forEach((arg) => {
    if (arg === '--dry-run') {
      options.dryRun = true;
      return;
    }
    if (arg === '--force') {
      options.force = true;
      return;
    }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) {
      options[match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase())] =
        match[2];
    }
  });
  return options;
}

function normalizeGitHubPath(value, fallback) {
  const normalized = String(value || fallback || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  return normalized || fallback;
}

function getDefaultSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function getDefaultSessionIndexPath() {
  return path.join(os.homedir(), '.codex', 'session_index.jsonl');
}

function getDefaultStatePath() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'TimeKeeper')
    : path.join(os.homedir(), '.timekeeper');
  return path.join(base, 'codex-usage-bridge-state.json');
}

function buildOptions(args = parseArgs()) {
  const machineId = sanitizeMachineId(
    args.machineId ||
      process.env.TIMEKEEPER_CODEX_MACHINE_ID ||
      getDefaultMachineId()
  );
  return {
    repository:
      args.repository ||
      process.env.TIMEKEEPER_CODEX_REPOSITORY ||
      defaultRepository,
    branch: args.branch || process.env.TIMEKEEPER_CODEX_BRANCH || defaultBranch,
    configPath: normalizeGitHubPath(
      args.configPath || process.env.TIMEKEEPER_CODEX_CONFIG_PATH,
      defaultConfigPath
    ),
    inboxPath: normalizeGitHubPath(
      args.inboxPath || process.env.TIMEKEEPER_CODEX_INBOX_PATH,
      defaultInboxPath
    ),
    token: args.token || process.env.TIMEKEEPER_CODEX_TOKEN || '',
    sessionsDir:
      args.sessionsDir ||
      process.env.TIMEKEEPER_CODEX_SESSIONS_DIR ||
      getDefaultSessionsDir(),
    sessionIndexPath:
      args.sessionIndexPath ||
      process.env.TIMEKEEPER_CODEX_SESSION_INDEX ||
      getDefaultSessionIndexPath(),
    statePath:
      args.statePath ||
      process.env.TIMEKEEPER_CODEX_STATE_PATH ||
      getDefaultStatePath(),
    codexExecutable:
      args.codexExecutable || process.env.TIMEKEEPER_CODEX_EXECUTABLE || '',
    machineId,
    dryRun: !!args.dryRun,
    force: !!args.force
  };
}

function getGitHubApiUrl(repository, filePath, branch) {
  const apiPath = normalizeGitHubPath(filePath, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://api.github.com/repos/${repository}/contents/${apiPath}?ref=${encodeURIComponent(branch)}`;
}

/**
 * @param {string} url
 * @param {RequestInit & { token?: string }} options
 */
async function githubJson(url, { token = '', ...options } = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(payload?.errors)
      ? payload.errors
          .map((item) =>
            String(
              item?.message ||
                [item?.resource, item?.field, item?.code]
                  .filter(Boolean)
                  .join(' ')
            ).trim()
          )
          .filter(Boolean)
      : [];
    const message = [
      payload?.message || `GitHub returned ${response.status}`,
      ...details
    ].join(' ');
    const error = Object.assign(new Error(message), {
      status: response.status,
      payload
    });
    throw error;
  }
  return payload;
}

function isGitHubShaMismatchError(error) {
  return (
    error &&
    (error.status === 409 ||
      (error.status === 422 &&
        /sha|does not match|not match/i.test(error.message || '')))
  );
}

function decodeGitHubContent(payload) {
  return Buffer.from(
    String(payload?.content || '').replace(/\s+/g, ''),
    'base64'
  ).toString('utf8');
}

async function fetchCodexConfig(options) {
  const url = getGitHubApiUrl(
    options.repository,
    options.configPath,
    options.branch
  );
  try {
    const payload = await githubJson(url, { token: options.token });
    return JSON.parse(decodeGitHubContent(payload));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      error.status === 404
    ) {
      return null;
    }
    throw error;
  }
}

async function loadThreadNames(indexPath) {
  const names = new Map();
  try {
    const text = await fs.readFile(indexPath, 'utf8');
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed);
        if (entry?.id && entry?.thread_name) {
          names.set(String(entry.id), String(entry.thread_name));
        }
      } catch {
        // Ignore malformed index lines.
      }
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return names;
}

async function listSessionFilesChangedSince(root, cutoff) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
        const stat = await fs.stat(fullPath);
        if (stat.mtime.getTime() >= cutoff.getTime()) {
          files.push(fullPath);
        }
      })
    );
  }
  await walk(root);
  return files.sort();
}

function getJsonLineTimestamp(line) {
  const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
  return parseTimestamp(match?.[1]);
}

function sanitizeRateLimitWindow(value) {
  const source = value && typeof value === 'object' ? value : {};
  const usedPercent = Number(source.used_percent);
  const windowMinutes = Number(source.window_minutes);
  const resetsAtSeconds = Number(source.resets_at);
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(windowMinutes) ||
    windowMinutes <= 0
  ) {
    return null;
  }
  const resetsAt =
    Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0
      ? new Date(resetsAtSeconds * 1000)
      : null;
  return {
    usedPercent: Number(Math.min(100, Math.max(0, usedPercent)).toFixed(1)),
    remainingPercent: Number(
      Math.min(100, Math.max(0, 100 - usedPercent)).toFixed(1)
    ),
    windowMinutes: Math.round(windowMinutes),
    resetsAt:
      resetsAt && !Number.isNaN(resetsAt.getTime())
        ? resetsAt.toISOString()
        : null
  };
}

function sanitizeCodexUsageLimits(value, observedAt) {
  const source = value && typeof value === 'object' ? value : {};
  const limitId = String(source.limit_id || '')
    .trim()
    .toLowerCase();
  if (limitId && limitId !== 'codex') return null;
  const primary = sanitizeRateLimitWindow(source.primary);
  const secondary = sanitizeRateLimitWindow(source.secondary);
  const observed = parseTimestamp(observedAt);
  if (!primary || !observed) return null;
  return {
    observedAt: observed.toISOString(),
    primary,
    secondary
  };
}

function sanitizeAppServerRateLimitWindow(value) {
  const source = value && typeof value === 'object' ? value : {};
  return sanitizeRateLimitWindow({
    used_percent: source.usedPercent,
    window_minutes: source.windowDurationMins,
    resets_at: source.resetsAt
  });
}

export function sanitizeAppServerUsageLimits(value, observedAt = new Date()) {
  const source = value && typeof value === 'object' ? value : {};
  const canonical =
    source.rateLimitsByLimitId?.codex || source.rateLimits || null;
  if (
    !canonical ||
    String(canonical.limitId || 'codex')
      .trim()
      .toLowerCase() !== 'codex'
  ) {
    return null;
  }
  const primary = sanitizeAppServerRateLimitWindow(canonical.primary);
  const secondary = sanitizeAppServerRateLimitWindow(canonical.secondary);
  const observed = parseTimestamp(observedAt);
  if (!primary || !observed) return null;
  return {
    observedAt: observed.toISOString(),
    primary,
    secondary
  };
}

function getCodexExecutableCandidates(explicitPath = '') {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return Array.from(
    new Set(
      [
        explicitPath,
        path.join(
          os.homedir(),
          '.codex',
          'plugins',
          '.plugin-appserver',
          executableName
        ),
        path.join(os.homedir(), '.codex', '.sandbox-bin', executableName),
        'codex'
      ].filter(Boolean)
    )
  );
}

function queryCodexAppServer(executable, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });
    const lineReader = readline.createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lineReader.close();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(
      () => finish(new Error('Codex app-server query timed out')),
      timeoutMs
    );
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited with code ${code}`));
      }
    });
    lineReader.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (message.error) {
            finish(
              new Error(message.error.message || 'Codex initialize failed')
            );
            return;
          }
          child.stdin.write(
            `${JSON.stringify({ method: 'initialized', params: {} })}\n`
          );
          child.stdin.write(
            `${JSON.stringify({
              method: 'account/rateLimits/read',
              id: 2
            })}\n`
          );
        } else if (message.id === 2) {
          if (message.error) {
            finish(
              new Error(
                message.error.message || 'Codex rate-limit query failed'
              )
            );
            return;
          }
          finish(
            null,
            sanitizeAppServerUsageLimits(message.result, new Date())
          );
        }
      } catch {
        // Ignore non-JSON diagnostic output from the executable.
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'timekeeper_codex_bridge',
            title: 'TimeKeeper Codex bridge',
            version: '1.0.0'
          }
        }
      })}\n`
    );
  });
}

export async function readLiveCodexUsageLimits({
  codexExecutable = '',
  timeoutMs = 10_000
} = {}) {
  for (const executable of getCodexExecutableCandidates(codexExecutable)) {
    try {
      const usageLimits = await queryCodexAppServer(executable, timeoutMs);
      if (usageLimits) return usageLimits;
    } catch {
      // Try another installed Codex executable, then fall back to session logs.
    }
  }
  return null;
}

export async function readCodexSessionSummary(filePath, windowStart) {
  const minTime = windowStart instanceof Date ? windowStart.getTime() : null;
  const meta = {
    id: '',
    sessionId: '',
    cwd: '',
    timestamp: null,
    threadSource: '',
    isSubagent: false
  };
  const timestamps = [];
  const activity = [];
  let activeModel = '';
  let activeEffort = '';
  let firstTimestamp = null;
  let lastTimestampMs = null;
  let hasSessionMeta = false;
  let usageLimits = null;
  const lineReader = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const line of lineReader) {
    if (!line) continue;
    const timestamp = getJsonLineTimestamp(line);
    if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
    if (/"type"\s*:\s*"(session_meta|turn_context|event_msg)"/.test(line)) {
      try {
        const event = JSON.parse(line);
        const payload = event?.payload || {};
        if (event?.type === 'session_meta' && !hasSessionMeta) {
          meta.id = String(payload.id || '').trim();
          meta.sessionId = String(
            payload.session_id || payload.id || ''
          ).trim();
          meta.cwd = String(payload.cwd || '').trim();
          meta.timestamp =
            parseTimestamp(payload.timestamp) || timestamp || null;
          meta.threadSource = String(payload.thread_source || '').trim();
          const source = payload.source;
          meta.isSubagent =
            meta.threadSource === 'subagent' ||
            (source &&
              typeof source === 'object' &&
              Object.prototype.hasOwnProperty.call(source, 'subagent'));
          hasSessionMeta = true;
        } else if (event?.type === 'turn_context') {
          activeModel = String(payload.model || activeModel || '').trim();
          activeEffort = String(
            payload.effort || payload.reasoning_effort || activeEffort || ''
          ).trim();
        } else if (
          event?.type === 'event_msg' &&
          payload.type === 'token_count' &&
          payload.rate_limits
        ) {
          const candidate = sanitizeCodexUsageLimits(
            payload.rate_limits,
            timestamp
          );
          if (
            candidate &&
            (!usageLimits ||
              Date.parse(candidate.observedAt) >
                Date.parse(usageLimits.observedAt))
          ) {
            usageLimits = candidate;
          }
        }
      } catch {
        // Ignore malformed or partially-written metadata lines.
      }
    }
    if (timestamp && (minTime === null || timestamp.getTime() >= minTime)) {
      const timestampMs = timestamp.getTime();
      if (timestampMs !== lastTimestampMs) {
        timestamps.push(timestamp);
        activity.push({
          timestamp,
          model: activeModel,
          effort: activeEffort
        });
        lastTimestampMs = timestampMs;
      } else if (activity.length) {
        activity[activity.length - 1] = {
          timestamp,
          model: activeModel,
          effort: activeEffort
        };
      }
    }
  }
  if (!meta.timestamp) meta.timestamp = firstTimestamp;
  return { meta, timestamps, activity, usageLimits, sourceFile: filePath };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function putGitHubJsonFile({ options, pathValue, payload, message }) {
  if (!options.token) {
    throw new Error(
      'Set TIMEKEEPER_CODEX_TOKEN to a GitHub token with Contents read/write access.'
    );
  }
  const apiUrl = getGitHubApiUrl(options.repository, pathValue, options.branch);
  const putUrl = apiUrl.replace(/\?.*$/, '');
  const content = Buffer.from(
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  ).toString('base64');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let sha = null;
    try {
      const existing = await githubJson(apiUrl, { token: options.token });
      sha = existing?.sha || null;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'status' in error &&
          error.status === 404
        )
      ) {
        throw error;
      }
    }
    const body = {
      message,
      content,
      branch: options.branch
    };
    if (sha) body.sha = sha;
    try {
      await githubJson(putUrl, {
        token: options.token,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return apiUrl;
    } catch (error) {
      if (attempt === 0 && isGitHubShaMismatchError(error)) continue;
      throw error;
    }
  }
  return apiUrl;
}

export async function buildCodexInboxPayload(options = buildOptions()) {
  const config = await fetchCodexConfig(options);
  if (!config || config.enabled === false) {
    return {
      skipped: true,
      reason: config ? 'disabled' : 'missing-config',
      records: []
    };
  }
  const now = new Date();
  const liveUsageLimitsPromise = readLiveCodexUsageLimits({
    codexExecutable: options.codexExecutable
  });
  const dayStart = getLocalDayStart(now);
  const rangeStart = getLocalLookbackStart(now);
  const files = await listSessionFilesChangedSince(
    options.sessionsDir,
    rangeStart
  );
  const threadNamesById = await loadThreadNames(options.sessionIndexPath);
  const summaries = await Promise.all(
    files.map((filePath) => readCodexSessionSummary(filePath, rangeStart))
  );
  const sessionGroups = new Map();
  summaries.forEach((summary) => {
    const groupId = String(
      summary.meta.sessionId || summary.meta.id || summary.sourceFile
    ).trim();
    const group = sessionGroups.get(groupId) || [];
    group.push(summary);
    sessionGroups.set(groupId, group);
  });
  const records = Array.from(sessionGroups.values()).flatMap((sessions) =>
    buildCodexUsageRecordsFromSessionGroup({
      sessions,
      trackedProjects: config.trackedProjects || config.projects || [],
      mappings: config.mappings || [],
      threadNamesById,
      now,
      focusFactor: config.focusFactor,
      focusPolicy: config.focusPolicy
    })
  );
  const uniqueRecords = Array.from(
    new Map(records.map((record) => [record.id, record])).values()
  ).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const sessionUsageLimits =
    summaries
      .map((summary) => summary.usageLimits)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ||
    null;
  const usageLimits = (await liveUsageLimitsPromise) || sessionUsageLimits;
  return {
    version: 2,
    source: 'timekeeper-codex-bridge',
    machineId: options.machineId,
    updatedAt: now.toISOString(),
    dayStart: dayStart.toISOString(),
    rangeStart: rangeStart.toISOString(),
    lookbackDays: DEFAULT_CODEX_LOOKBACK_DAYS,
    usageLimits,
    records: uniqueRecords
  };
}

export function makeCodexPayloadKey(payload = {}) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        rangeStart: payload.rangeStart,
        usageLimits: payload.usageLimits || null,
        records: Array.isArray(payload.records) ? payload.records : []
      })
    )
    .digest('hex');
}

export async function runCodexUsageBridge(rawArgs = parseArgs()) {
  const options = buildOptions(rawArgs);
  const payload = await buildCodexInboxPayload(options);
  if (payload.skipped) {
    process.stdout.write(`Codex bridge skipped: ${payload.reason}\n`);
    return payload;
  }
  const state = await readJsonFile(options.statePath, {});
  const payloadKey = makeCodexPayloadKey(payload);
  if (!options.force && state.lastPayloadKey === payloadKey) {
    process.stdout.write(
      `Codex bridge unchanged: ${payload.records.length} records for ${options.machineId}\n`
    );
    return payload;
  }
  const inboxFile = `${options.inboxPath.replace(/\/+$/g, '')}/${options.machineId}.json`;
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  const apiUrl = await putGitHubJsonFile({
    options,
    pathValue: inboxFile,
    payload,
    message: 'Update TimeKeeper Codex inbox [skip ci]'
  });
  await writeJsonFile(options.statePath, {
    lastPayloadKey: payloadKey,
    lastPublishedAt: new Date().toISOString(),
    lastRecordCount: payload.records.length,
    machineId: options.machineId,
    apiUrl
  });
  process.stdout.write(
    `Codex bridge published ${payload.records.length} records to ${inboxFile}\n`
  );
  return payload;
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runCodexUsageBridge().catch((error) => {
    process.stderr.write(`Codex bridge failed: ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
