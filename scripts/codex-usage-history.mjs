import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DEFAULT_INBOX_DIR = 'assets/timekeeper-codex-inbox';
export const DEFAULT_OUTPUT_FILE = 'assets/timekeeper-codex-usage-history.json';
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_HEARTBEAT_MINUTES = 60;
export const DEFAULT_MAX_SAMPLES = 5000;
export const DEFAULT_BACKFILL_MAX_COMMITS = 5000;

const execFileAsync = promisify(execFile);

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  let usedPercent = finiteNumber(window.usedPercent);
  let remainingPercent = finiteNumber(window.remainingPercent);
  if (usedPercent === null && remainingPercent !== null) {
    usedPercent = 100 - remainingPercent;
  }
  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = 100 - usedPercent;
  }
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    remainingPercent: Math.min(
      100,
      Math.max(0, remainingPercent ?? 100 - usedPercent)
    ),
    windowMinutes: Math.max(0, finiteNumber(window.windowMinutes) ?? 0),
    resetsAt: parseTimestamp(window.resetsAt)
      ? new Date(parseTimestamp(window.resetsAt)).toISOString()
      : null
  };
}

export function normalizeUsageCandidate(payload, sourceFile = '') {
  if (!payload || typeof payload !== 'object') return null;
  const usageLimits = payload.usageLimits;
  if (!usageLimits || typeof usageLimits !== 'object') return null;
  const observedMs =
    parseTimestamp(usageLimits.observedAt) ??
    parseTimestamp(payload.updatedAt) ??
    parseTimestamp(payload.generatedAt);
  if (observedMs === null) return null;
  const primary = normalizeWindow(usageLimits.primary);
  const secondary = normalizeWindow(usageLimits.secondary);
  if (!primary && !secondary) return null;
  return {
    observedAt: new Date(observedMs).toISOString(),
    sourceMachineId: String(
      payload.machineId || path.basename(sourceFile, '.json')
    ),
    primary,
    secondary
  };
}

function stateKey(sample) {
  return JSON.stringify({
    primary: sample?.primary || null,
    secondary: sample?.secondary || null
  });
}

function sameWindowState(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.usedPercent !== right.usedPercent) return false;
  if (
    left.windowMinutes > 0 &&
    right.windowMinutes > 0 &&
    left.windowMinutes !== right.windowMinutes
  ) {
    return false;
  }
  if (!left.resetsAt || !right.resetsAt) {
    return left.resetsAt === right.resetsAt;
  }
  const leftResetMs = parseTimestamp(left.resetsAt);
  const rightResetMs = parseTimestamp(right.resetsAt);
  return (
    leftResetMs !== null &&
    rightResetMs !== null &&
    Math.abs(leftResetMs - rightResetMs) <= 5 * 60 * 1000
  );
}

function sameSampleState(left, right) {
  return (
    sameWindowState(left?.primary, right?.primary) &&
    sameWindowState(left?.secondary, right?.secondary)
  );
}

function sampleKey(sample) {
  return `${sample.observedAt}|${stateKey(sample)}`;
}

function normalizeExistingSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const observedMs = parseTimestamp(sample.observedAt || sample.capturedAt);
  if (observedMs === null) return null;
  const primary = normalizeWindow(sample.primary);
  const secondary = normalizeWindow(sample.secondary);
  if (!primary && !secondary) return null;
  return {
    observedAt: new Date(observedMs).toISOString(),
    sourceMachineId: String(sample.sourceMachineId || sample.machineId || ''),
    primary,
    secondary
  };
}

function chooseCurrentCandidate(candidates) {
  return candidates
    .filter(Boolean)
    .slice()
    .sort(
      (left, right) =>
        parseTimestamp(right.observedAt) - parseTimestamp(left.observedAt)
    )[0];
}

export function mergeUsageHistory(
  existingHistory,
  candidates,
  {
    now = new Date(),
    retentionDays = DEFAULT_RETENTION_DAYS,
    heartbeatMinutes = DEFAULT_HEARTBEAT_MINUTES,
    maxSamples = DEFAULT_MAX_SAMPLES,
    includeAllCandidates = false
  } = {}
) {
  const nowMs = parseTimestamp(now) ?? Date.now();
  const cutoffMs = nowMs - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const existing = (Array.isArray(existingHistory) ? existingHistory : [])
    .map(normalizeExistingSample)
    .filter((sample) => parseTimestamp(sample.observedAt) >= cutoffMs);
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeExistingSample)
    .filter((sample) => parseTimestamp(sample.observedAt) >= cutoffMs);
  const selectedCandidates = includeAllCandidates
    ? normalizedCandidates
    : [chooseCurrentCandidate(normalizedCandidates)].filter(Boolean);
  const byTimestamp = new Map();
  [...existing, ...selectedCandidates]
    .sort(
      (left, right) =>
        parseTimestamp(left.observedAt) - parseTimestamp(right.observedAt)
    )
    .forEach((sample) => {
      byTimestamp.set(sample.observedAt, sample);
    });
  const normalized = [];
  byTimestamp.forEach((sample) => {
    const sampleMs = parseTimestamp(sample.observedAt);
    const last = normalized[normalized.length - 1];
    const lastMs = last ? parseTimestamp(last.observedAt) : null;
    const stateChanged = !last || !sameSampleState(last, sample);
    const heartbeatDue =
      lastMs === null ||
      sampleMs - lastMs >= Math.max(1, heartbeatMinutes) * 60 * 1000;
    if (stateChanged || heartbeatDue) normalized.push(sample);
  });
  const deduped = new Map();
  normalized.forEach((sample) => {
    deduped.set(sampleKey(sample), sample);
  });
  const samples = [...deduped.values()]
    .sort(
      (left, right) =>
        parseTimestamp(left.observedAt) - parseTimestamp(right.observedAt)
    )
    .slice(-Math.max(2, maxSamples));
  return samples;
}

async function runGit(args, gitDirectory) {
  const result = await execFileAsync('git', args, {
    cwd: gitDirectory,
    maxBuffer: 20 * 1024 * 1024
  });
  return result.stdout;
}

export async function readHistoricalUsageCandidatesFromGit({
  gitDirectory = process.cwd(),
  since = null,
  until = new Date(),
  maxCommits = DEFAULT_BACKFILL_MAX_COMMITS
} = {}) {
  const untilMs = parseTimestamp(until) ?? Date.now();
  const sinceMs = parseTimestamp(since);
  if (sinceMs === null || sinceMs >= untilMs) return [];
  const commits = [
    ...new Set(
      (
        await runGit(
          [
            'log',
            '--format=%H',
            `--since=${new Date(sinceMs).toISOString()}`,
            `--until=${new Date(untilMs).toISOString()}`,
            '--',
            'assets/timekeeper-codex-inbox'
          ],
          gitDirectory
        )
      ).split(/\r?\n/)
    )
  ]
    .map((commit) => commit.trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxCommits));
  if (!commits.length) return [];
  const files = (
    await runGit(
      [
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
        '--',
        'assets/timekeeper-codex-inbox'
      ],
      gitDirectory
    )
  )
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file.toLowerCase().endsWith('.json'));
  const candidates = [];
  for (const commit of commits) {
    for (const file of files) {
      try {
        const text = await runGit(['show', `${commit}:${file}`], gitDirectory);
        const candidate = normalizeUsageCandidate(JSON.parse(text), file);
        if (candidate) candidates.push(candidate);
      } catch {
        // The file may not exist yet in an older commit or may be malformed.
      }
    }
  }
  return candidates;
}

export async function readInboxCandidates(inboxDir = DEFAULT_INBOX_DIR) {
  let entries = [];
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }
    const filePath = path.join(inboxDir, entry.name);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const candidate = normalizeUsageCandidate(payload, filePath);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      process.stderr.write(
        `Skipping unreadable Codex inbox file ${filePath}: ${error.message}\n`
      );
    }
  }
  return candidates;
}

async function readHistoryFile(outputFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(outputFile, 'utf8'));
    return {
      samples: Array.isArray(parsed?.samples) ? parsed.samples : [],
      backfill: parsed?.backfill || null
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { samples: [], backfill: null };
    throw error;
  }
}

export async function updateCodexUsageHistory({
  inboxDir = DEFAULT_INBOX_DIR,
  outputFile = DEFAULT_OUTPUT_FILE,
  now = new Date(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  heartbeatMinutes = DEFAULT_HEARTBEAT_MINUTES,
  maxSamples = DEFAULT_MAX_SAMPLES,
  backfillDays = 0,
  backfillMaxCommits = DEFAULT_BACKFILL_MAX_COMMITS,
  gitDirectory = process.cwd()
} = {}) {
  const existingPayload = await readHistoryFile(outputFile);
  const candidates = await readInboxCandidates(inboxDir);
  const backfillCandidates =
    Number(backfillDays) > 0
      ? await readHistoricalUsageCandidatesFromGit({
          gitDirectory,
          since: new Date(
            (parseTimestamp(now) ?? Date.now()) -
              Number(backfillDays) * 24 * 60 * 60 * 1000
          ),
          until: now,
          maxCommits: backfillMaxCommits
        })
      : [];
  const allCandidates = [...backfillCandidates, ...candidates];
  const samples = mergeUsageHistory(existingPayload.samples, allCandidates, {
    now,
    retentionDays,
    heartbeatMinutes,
    maxSamples,
    includeAllCandidates: backfillCandidates.length > 0
  });
  const backfill = backfillCandidates.length
    ? {
        source: 'git history of assets/timekeeper-codex-inbox/*.json',
        requestedDays: Number(backfillDays),
        candidateCount: backfillCandidates.length,
        recoveredFrom: samples[0]?.observedAt || null,
        recoveredThrough: samples.at(-1)?.observedAt || null
      }
    : existingPayload.backfill;
  const payload = {
    version: 1,
    generatedAt: new Date(parseTimestamp(now) ?? Date.now()).toISOString(),
    retentionDays,
    heartbeatMinutes,
    source: 'timekeeper-codex-inbox-sampler',
    ...(backfill ? { backfill } : {}),
    samples
  };
  const nextText = `${JSON.stringify(payload, null, 2)}\n`;
  let previousText = '';
  try {
    previousText = await fs.readFile(outputFile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const previousComparable = previousText
    ? JSON.stringify({
        ...(JSON.parse(previousText) || {}),
        generatedAt: null
      })
    : '';
  const nextComparable = JSON.stringify({ ...payload, generatedAt: null });
  if (previousComparable === nextComparable) {
    return { changed: false, payload };
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, nextText, 'utf8');
  return { changed: true, payload };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  argv.forEach((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) return;
    const key = match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = match[2];
  });
  return options;
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const args = parseArgs();
  updateCodexUsageHistory({
    inboxDir: args.inbox || DEFAULT_INBOX_DIR,
    outputFile: args.output || DEFAULT_OUTPUT_FILE,
    retentionDays: Number(args.retentionDays) || DEFAULT_RETENTION_DAYS,
    heartbeatMinutes:
      Number(args.heartbeatMinutes) || DEFAULT_HEARTBEAT_MINUTES,
    maxSamples: Number(args.maxSamples) || DEFAULT_MAX_SAMPLES,
    backfillDays: Number(args.backfillDays) || 0,
    backfillMaxCommits:
      Number(args.backfillMaxCommits) || DEFAULT_BACKFILL_MAX_COMMITS,
    gitDirectory: args.gitDirectory || process.cwd()
  })
    .then(({ changed, payload }) => {
      process.stdout.write(
        `${changed ? 'Updated' : 'No change to'} Codex usage history (${payload.samples.length} samples).\n`
      );
    })
    .catch((error) => {
      process.stderr.write(
        `Codex usage history update failed: ${error.message || error}\n`
      );
      process.exitCode = 1;
    });
}
