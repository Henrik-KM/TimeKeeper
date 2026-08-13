import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_INBOX_DIR = 'assets/timekeeper-codex-inbox';
export const DEFAULT_OUTPUT_FILE = 'assets/timekeeper-codex-usage-history.json';
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_HEARTBEAT_MINUTES = 60;
export const DEFAULT_MAX_SAMPLES = 5000;

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteNumber(value) {
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
    maxSamples = DEFAULT_MAX_SAMPLES
  } = {}
) {
  const nowMs = parseTimestamp(now) ?? Date.now();
  const cutoffMs = nowMs - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const normalized = (Array.isArray(existingHistory) ? existingHistory : [])
    .map(normalizeExistingSample)
    .filter((sample) => parseTimestamp(sample.observedAt) >= cutoffMs);
  const current = chooseCurrentCandidate(candidates);
  if (current) {
    const currentMs = parseTimestamp(current.observedAt);
    const last = normalized
      .slice()
      .sort(
        (left, right) =>
          parseTimestamp(left.observedAt) - parseTimestamp(right.observedAt)
      )
      .slice(-1)[0];
    const lastMs = last ? parseTimestamp(last.observedAt) : null;
    const stateChanged = !last || stateKey(last) !== stateKey(current);
    const heartbeatDue =
      lastMs === null ||
      currentMs - lastMs >= Math.max(1, heartbeatMinutes) * 60 * 1000;
    if (
      currentMs !== null &&
      currentMs >= cutoffMs &&
      (stateChanged || heartbeatDue)
    ) {
      normalized.push(current);
    }
  }
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
    return Array.isArray(parsed?.samples) ? parsed.samples : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function updateCodexUsageHistory({
  inboxDir = DEFAULT_INBOX_DIR,
  outputFile = DEFAULT_OUTPUT_FILE,
  now = new Date(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  heartbeatMinutes = DEFAULT_HEARTBEAT_MINUTES,
  maxSamples = DEFAULT_MAX_SAMPLES
} = {}) {
  const existing = await readHistoryFile(outputFile);
  const candidates = await readInboxCandidates(inboxDir);
  const samples = mergeUsageHistory(existing, candidates, {
    now,
    retentionDays,
    heartbeatMinutes,
    maxSamples
  });
  const payload = {
    version: 1,
    generatedAt: new Date(parseTimestamp(now) ?? Date.now()).toISOString(),
    retentionDays,
    heartbeatMinutes,
    source: 'timekeeper-codex-inbox-sampler',
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
    maxSamples: Number(args.maxSamples) || DEFAULT_MAX_SAMPLES
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
