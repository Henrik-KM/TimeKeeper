import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const manifestPath = 'scripts/codex-bridge-runtime.json';
const refreshIntervalMs = 6 * 60 * 60 * 1000;

async function runGit(args, repositoryRoot) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true
  });
  return stdout;
}

function isRuntimeFile(file) {
  return (
    typeof file === 'string' &&
    /^(scripts|src)\/[A-Za-z0-9_./-]+\.mjs$/.test(file) &&
    file.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function validCachedRuntime(runtimeRoot, state) {
  if (
    !state ||
    !/^[a-f0-9]{64}$/.test(state.runtimeKey || '') ||
    !isRuntimeFile(state.entrypoint) ||
    !Array.isArray(state.files) ||
    !state.files.includes(state.entrypoint) ||
    !state.files.every(isRuntimeFile)
  )
    return null;
  const directory = path.join(runtimeRoot, state.runtimeKey);
  try {
    await Promise.all(
      state.files.map((file) => fs.access(path.join(directory, file)))
    );
  } catch {
    return null;
  }
  return { ...state, entrypoint: path.join(directory, state.entrypoint) };
}

/** Read a pinned main revision without changing the development checkout. */
export async function prepareCodexBridgeRuntime({
  repositoryRoot,
  runtimeRoot,
  now = Date.now(),
  refresh = false,
  git = runGit
}) {
  const statePath = path.join(runtimeRoot, 'state.json');
  const state = await readJson(statePath);
  const cached = await validCachedRuntime(runtimeRoot, state);
  const ageMs = now - Date.parse(state?.checkedAt || '');
  if (cached && !refresh && ageMs >= 0 && ageMs < refreshIntervalMs) {
    return { ...cached, warning: '' };
  }

  let warning = '';
  try {
    await git(['fetch', '--quiet', 'origin', 'main'], repositoryRoot);
  } catch {
    warning =
      'Source update unavailable; using the last available main revision.';
    if (cached) return { ...cached, warning };
  }
  const revision = (
    await git(['rev-parse', 'refs/remotes/origin/main'], repositoryRoot)
  ).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('Invalid bridge source revision.');
  const manifest = JSON.parse(
    await git(['show', `${revision}:${manifestPath}`], repositoryRoot)
  );
  const files = Array.isArray(manifest.files)
    ? [...new Set(manifest.files)]
    : [];
  if (
    manifest.version !== 1 ||
    !files.length ||
    files.length > 32 ||
    !files.every(isRuntimeFile) ||
    !isRuntimeFile(manifest.entrypoint) ||
    !files.includes(manifest.entrypoint)
  )
    throw new Error('Invalid Codex bridge runtime manifest.');

  const sources = await Promise.all(
    files.map(async (file) => ({
      file,
      content: await git(['show', `${revision}:${file}`], repositoryRoot)
    }))
  );
  const runtimeKey = crypto
    .createHash('sha256')
    .update(JSON.stringify({ manifest, sources }))
    .digest('hex');
  const directory = path.join(runtimeRoot, runtimeKey);
  const nextState = {
    runtimeKey,
    sourceRevision: revision,
    entrypoint: manifest.entrypoint,
    files,
    checkedAt: new Date(now).toISOString()
  };
  if (!(await validCachedRuntime(runtimeRoot, nextState))) {
    await fs.mkdir(runtimeRoot, { recursive: true });
    const staging = await fs.mkdtemp(path.join(runtimeRoot, 'staging-'));
    try {
      for (const source of sources) {
        const target = path.join(staging, source.file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, source.content, 'utf8');
      }
      await fs.rename(staging, directory);
    } catch (error) {
      if (!(await validCachedRuntime(runtimeRoot, nextState))) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        await fs.cp(staging, directory, { recursive: true });
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  const temporaryState = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryState,
    JSON.stringify(nextState, null, 2),
    'utf8'
  );
  await fs.rename(temporaryState, statePath);
  return {
    ...nextState,
    entrypoint: path.join(directory, manifest.entrypoint),
    warning
  };
}

async function main() {
  const args = process.argv.slice(2);
  const repositoryRoot = path.resolve(
    args
      .find((arg) => arg.startsWith('--repo-root='))
      ?.slice('--repo-root='.length) ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  );
  const runtimeRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
    'TimeKeeper',
    'codex-bridge-runtime'
  );
  const runtime = await prepareCodexBridgeRuntime({
    repositoryRoot,
    runtimeRoot,
    refresh: args.includes('--refresh-runtime')
  });
  if (runtime.warning) process.stderr.write(`${runtime.warning}\n`);
  process.stdout.write(
    `Codex bridge source: main ${runtime.sourceRevision.slice(0, 9)}\n`
  );
  const child = spawn(
    process.execPath,
    [
      runtime.entrypoint,
      ...args.filter(
        (arg) => !arg.startsWith('--repo-root=') && arg !== '--refresh-runtime'
      )
    ],
    { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true }
  );
  child.on('error', (error) => {
    process.stderr.write(`Codex bridge could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`Codex bridge runtime failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
