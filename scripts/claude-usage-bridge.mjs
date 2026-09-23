import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOptions as buildCodexBridgeOptions,
  fetchCodexConfig,
  parseArgs,
  putGitHubJsonFile,
  readJsonFile,
  writeJsonFile
} from './codex-usage-bridge.mjs';
import {
  buildClaudeUsageRecordsFromSessionGroup,
  parseClaudeTranscript
} from './claude-usage-core.mjs';
import { getLocalLookbackStart } from './codex-usage-core.mjs';
import { normalizeClaudePolicy } from '../src/features/claude/policy.mjs';

const CLAUDE_LOOKBACK_DAYS = 30;
const DEFAULT_INBOX_PATH = 'assets/timekeeper-claude-inbox';

function defaultProjectsDir() {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

function defaultStatePath() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'TimeKeeper')
    : path.join(os.homedir(), '.timekeeper');
  return path.join(base, 'claude-usage-bridge-state.json');
}

export function buildClaudeBridgeOptions(args = parseArgs()) {
  return {
    ...buildCodexBridgeOptions(args),
    projectsDir:
      args.projectsDir ||
      process.env.TIMEKEEPER_CLAUDE_PROJECTS_DIR ||
      defaultProjectsDir(),
    statePath:
      args.statePath ||
      process.env.TIMEKEEPER_CLAUDE_STATE_PATH ||
      defaultStatePath(),
    inboxPath: DEFAULT_INBOX_PATH,
    now: args.now ? new Date(args.now) : new Date()
  };
}

async function listClaudeTranscriptFiles(root, cutoff) {
  const found = [];
  const walk = async (directory) => {
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      children.map(async (child) => {
        const filePath = path.join(directory, child.name);
        if (child.isDirectory()) {
          await walk(filePath);
        } else if (child.isFile() && child.name.endsWith('.jsonl')) {
          const stat = await fs.stat(filePath);
          if (stat.mtime >= cutoff) found.push(filePath);
        }
      })
    );
  };
  await walk(root);
  return found;
}

function transcriptIdentity(filePath) {
  const filename = path.basename(filePath, '.jsonl');
  if (path.basename(path.dirname(filePath)).toLowerCase() === 'subagents') {
    return {
      parentSessionId: path.basename(path.dirname(path.dirname(filePath))),
      agentId: filename.replace(/^agent-/, '')
    };
  }
  return { parentSessionId: filename, agentId: '' };
}

export async function buildClaudeInboxPayload(
  options = buildClaudeBridgeOptions()
) {
  const config = await fetchCodexConfig(options);
  if (!config) return { skipped: true, reason: 'published config unavailable' };
  if (!options.dryRun && config.claude?.enabled !== true) {
    return { skipped: true, reason: 'Claude integration is off' };
  }
  const now =
    options.now instanceof Date && !Number.isNaN(options.now.getTime())
      ? options.now
      : new Date();
  const rangeStart = getLocalLookbackStart(now, CLAUDE_LOOKBACK_DAYS);
  const files = await listClaudeTranscriptFiles(
    options.projectsDir,
    rangeStart
  );
  const sessions = await Promise.all(
    files.map(async (filePath) => {
      const identity = transcriptIdentity(filePath);
      let text;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (['ENOENT', 'EBUSY', 'EACCES'].includes(error.code)) return null;
        throw error;
      }
      return parseClaudeTranscript(text, {
        ...identity,
        windowStart: rangeStart
      });
    })
  );
  const groups = new Map();
  sessions.forEach((session) => {
    if (!session?.sessionId || !session.activity.length) return;
    const group = groups.get(session.sessionId) || [];
    group.push(session);
    groups.set(session.sessionId, group);
  });
  const policy = normalizeClaudePolicy(config.claude?.focusPolicy);
  const records = [...groups.values()]
    .flatMap((group) =>
      buildClaudeUsageRecordsFromSessionGroup({
        sessions: group,
        trackedProjects: config.trackedProjects || [],
        mappings: config.mappings || [],
        now,
        policy
      })
    )
    .filter((record) => new Date(record.startTime) >= rangeStart)
    .sort((left, right) => left.startTime.localeCompare(right.startTime));
  return {
    version: 1,
    source: 'timekeeper-claude-bridge',
    machineId: options.machineId,
    updatedAt: now.toISOString(),
    rangeStart: rangeStart.toISOString(),
    lookbackDays: CLAUDE_LOOKBACK_DAYS,
    records
  };
}

export function makeClaudePayloadKey(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload.records || []))
    .digest('hex');
}

export async function runClaudeUsageBridge(args = parseArgs()) {
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/claude-usage-bridge.mjs [--dry-run] [--force] [--projects-dir=path]\n'
    );
    return { skipped: true, reason: 'help' };
  }
  const options = buildClaudeBridgeOptions(args);
  const payload = await buildClaudeInboxPayload(options);
  if (payload.skipped) {
    process.stdout.write(`Claude bridge skipped: ${payload.reason}\n`);
    return payload;
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  const state = await readJsonFile(options.statePath, {});
  const key = makeClaudePayloadKey(payload);
  if (!options.force && state.lastPayloadKey === key) {
    process.stdout.write(
      `Claude bridge unchanged: ${payload.records.length} records\n`
    );
    return payload;
  }
  const inboxFile = `${options.inboxPath}/${options.machineId}.json`;
  await putGitHubJsonFile({
    options,
    pathValue: inboxFile,
    payload,
    message: 'Update TimeKeeper Claude inbox [skip ci]'
  });
  await writeJsonFile(options.statePath, {
    lastPayloadKey: key,
    lastPublishedAt: new Date().toISOString(),
    lastRecordCount: payload.records.length
  });
  process.stdout.write(
    `Claude bridge published ${payload.records.length} records\n`
  );
  return payload;
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  runClaudeUsageBridge().catch((error) => {
    process.stderr.write(`Claude bridge failed: ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
