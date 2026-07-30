import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONTEXT_REPOSITORY =
  'Henrik-KM/timekeeper-private-context';
export const DEFAULT_CONTEXT_BRANCH = 'main';
export const DEFAULT_CONTEXT_PATH = 'codex-context.json';

/**
 * @typedef {{
 *   error?: Error,
 *   status: number | null,
 *   stdout: string,
 *   stderr: string
 * }} CommandResult
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options: Record<string, unknown>
 * ) => CommandResult} CommandRunner
 */

function normalizeRepository(value) {
  const repository = String(value || '')
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('Context repository must use owner/repo format.');
  }
  return repository;
}

function normalizePath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error('Context path must be a repository-relative file path.');
  }
  return normalized;
}

export function decodeGitHubContextContent(value) {
  const text = Buffer.from(
    String(value || '').replace(/\s+/g, ''),
    'base64'
  ).toString('utf8');
  const context = JSON.parse(text);
  if (
    context?.schema !== 'timekeeper-codex-development-context/v1' ||
    !Array.isArray(context?.projects) ||
    !Array.isArray(context?.entries)
  ) {
    throw new Error('GitHub file is not a TimeKeeper Codex context snapshot.');
  }
  return context;
}

export function getContextSummary(context) {
  return {
    generatedAt: String(context?.generatedAt || ''),
    projects: Number(context?.coverage?.totalProjects) || 0,
    entries: Number(context?.coverage?.totalEntries) || 0,
    effectiveHours: Number(context?.usage?.windows?.all?.effectiveHours) || 0
  };
}

export function getContextApiPath({
  repository = DEFAULT_CONTEXT_REPOSITORY,
  branch = DEFAULT_CONTEXT_BRANCH,
  pathValue = DEFAULT_CONTEXT_PATH
} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedPath = normalizePath(pathValue)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `repos/${normalizedRepository}/contents/${normalizedPath}?ref=${encodeURIComponent(String(branch || DEFAULT_CONTEXT_BRANCH))}`;
}

export function fetchPrivateContext(
  options = {},
  runCommand = /** @type {CommandRunner} */ (/** @type {unknown} */ (spawnSync))
) {
  const apiPath = getContextApiPath(options);
  const result = runCommand(
    process.platform === 'win32' ? 'gh.exe' : 'gh',
    ['api', apiPath, '--jq', '.content'],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || 'GitHub context fetch failed.').trim()
    );
  }
  return decodeGitHubContextContent(result.stdout);
}

export async function pullPrivateContext({
  repository = process.env.TIMEKEEPER_CODEX_CONTEXT_REPOSITORY ||
    DEFAULT_CONTEXT_REPOSITORY,
  branch = process.env.TIMEKEEPER_CODEX_CONTEXT_BRANCH ||
    DEFAULT_CONTEXT_BRANCH,
  pathValue = process.env.TIMEKEEPER_CODEX_CONTEXT_PATH || DEFAULT_CONTEXT_PATH,
  outputPath = process.env.TIMEKEEPER_CODEX_CONTEXT_OUTPUT ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '.timekeeper-private',
      'codex-context.json'
    ),
  runCommand = /** @type {CommandRunner} */ (/** @type {unknown} */ (spawnSync))
} = {}) {
  const context = fetchPrivateContext(
    { repository, branch, pathValue },
    runCommand
  );
  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(
    resolvedOutput,
    `${JSON.stringify(context, null, 2)}\n`,
    'utf8'
  );
  return {
    outputPath: resolvedOutput,
    summary: getContextSummary(context)
  };
}

async function main() {
  const result = await pullPrivateContext();
  const summary = result.summary;
  process.stdout.write(
    `Pulled private TimeKeeper context: ${summary.projects} projects, ${summary.entries} entries, ${summary.effectiveHours} effective hours; generated ${summary.generatedAt || 'unknown'}.\n`
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `Private TimeKeeper context pull failed: ${error.message || error}\n`
    );
    process.exitCode = 1;
  });
}
