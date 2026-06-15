import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildCodexUsageRecordsFromSessionText,
  getDefaultMachineId,
  getLocalDayStart,
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
    const error = Object.assign(
      new Error(payload?.message || `GitHub returned ${response.status}`),
      { status: response.status }
    );
    throw error;
  }
  return payload;
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
    content: Buffer.from(
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    ).toString('base64'),
    branch: options.branch
  };
  if (sha) body.sha = sha;
  await githubJson(apiUrl.replace(/\?.*$/, ''), {
    token: options.token,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
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
  const dayStart = getLocalDayStart(now);
  const files = await listSessionFilesChangedSince(
    options.sessionsDir,
    dayStart
  );
  const threadNamesById = await loadThreadNames(options.sessionIndexPath);
  const records = [];
  await Promise.all(
    files.map(async (filePath) => {
      const text = await fs.readFile(filePath, 'utf8');
      records.push(
        ...buildCodexUsageRecordsFromSessionText({
          text,
          trackedProjects: config.trackedProjects || config.projects || [],
          mappings: config.mappings || [],
          threadNamesById,
          dayStart,
          now,
          sourceFile: filePath
        })
      );
    })
  );
  const uniqueRecords = Array.from(
    new Map(records.map((record) => [record.id, record])).values()
  ).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  return {
    version: 1,
    source: 'timekeeper-codex-bridge',
    machineId: options.machineId,
    updatedAt: now.toISOString(),
    dayStart: dayStart.toISOString(),
    records: uniqueRecords
  };
}

export async function runCodexUsageBridge(rawArgs = parseArgs()) {
  const options = buildOptions(rawArgs);
  const payload = await buildCodexInboxPayload(options);
  if (payload.skipped) {
    process.stdout.write(`Codex bridge skipped: ${payload.reason}\n`);
    return payload;
  }
  const state = await readJsonFile(options.statePath, {});
  const payloadKey = JSON.stringify(payload.records.map((record) => record.id));
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
