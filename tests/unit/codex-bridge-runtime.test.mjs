import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareCodexBridgeRuntime } from '../../scripts/codex-bridge-runtime.mjs';

const execFileAsync = promisify(execFile);
const entrypoint = 'scripts/bridge.mjs';
const dependency = 'src/activity.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-runtime-test-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, 'repository');
  const runtimeRoot = path.join(directory, 'runtime');
  await fs.mkdir(repositoryRoot);
  const git = async (args) =>
    (
      await execFileAsync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true
      })
    ).stdout;
  await git(['init', '-b', 'main']);
  await git(['config', 'core.autocrlf', 'false']);
  await fs.mkdir(path.join(repositoryRoot, 'scripts'));
  await fs.mkdir(path.join(repositoryRoot, 'src'));
  await fs.writeFile(
    path.join(repositoryRoot, 'scripts/codex-bridge-runtime.json'),
    JSON.stringify({
      version: 1,
      entrypoint,
      files: [entrypoint, dependency]
    })
  );
  await fs.writeFile(
    path.join(repositoryRoot, entrypoint),
    "export const version = 'old';\n"
  );
  await fs.writeFile(
    path.join(repositoryRoot, dependency),
    'export const activityPolicyVersion = 0;\n'
  );
  const commit = async (message) => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=TimeKeeper tests',
      '-c',
      'user.email=tests@example.invalid',
      'commit',
      '-m',
      message
    ]);
    return (await git(['rev-parse', 'HEAD'])).trim();
  };
  const oldRevision = await commit('Old collector');
  await fs.writeFile(
    path.join(repositoryRoot, entrypoint),
    "export const version = 'current';\n"
  );
  await fs.writeFile(
    path.join(repositoryRoot, dependency),
    'export const activityPolicyVersion = 1;\n'
  );
  const revision = await commit('Current collector');
  await git(['update-ref', 'refs/remotes/origin/main', revision]);
  await git(['checkout', '-b', 'development', oldRevision]);
  let fetches = 0;
  const localGit = async (args) => {
    if (args[0] === 'fetch') {
      fetches += 1;
      return '';
    }
    return git(args);
  };
  return {
    repositoryRoot,
    runtimeRoot,
    revision,
    git,
    localGit,
    fetches: () => fetches
  };
}

test('scheduled bridge uses published main while the development checkout stays on its old branch', async (t) => {
  const setup = await fixture(t);
  const now = Date.parse('2026-11-11T12:00:00Z');
  const runtime = await prepareCodexBridgeRuntime({
    ...setup,
    now,
    git: setup.localGit
  });
  assert.equal(runtime.sourceRevision, setup.revision);
  assert.equal(
    await fs.readFile(runtime.entrypoint, 'utf8'),
    "export const version = 'current';\n"
  );
  assert.equal(
    await fs.readFile(path.join(setup.repositoryRoot, entrypoint), 'utf8'),
    "export const version = 'old';\n"
  );
  assert.equal(
    (await setup.git(['branch', '--show-current'])).trim(),
    'development'
  );
  assert.equal(setup.fetches(), 1);

  const cached = await prepareCodexBridgeRuntime({
    ...setup,
    now: now + 60000,
    git: async () => {
      throw new Error('Cache should avoid Git access.');
    }
  });
  assert.equal(cached.entrypoint, runtime.entrypoint);
  const refreshed = await prepareCodexBridgeRuntime({
    ...setup,
    now: now + 120000,
    refresh: true,
    git: setup.localGit
  });
  assert.equal(refreshed.runtimeKey, runtime.runtimeKey);
  assert.equal(setup.fetches(), 2);
});

test('offline update checks retain the complete cached runtime and missing dependencies can be rebuilt', async (t) => {
  const setup = await fixture(t);
  const now = Date.parse('2026-11-11T12:00:00Z');
  const runtime = await prepareCodexBridgeRuntime({
    ...setup,
    now,
    git: setup.localGit
  });
  const offline = await prepareCodexBridgeRuntime({
    ...setup,
    now: now + 7 * 3600000,
    git: async () => {
      throw new Error('Offline');
    }
  });
  assert.equal(offline.entrypoint, runtime.entrypoint);
  assert.match(offline.warning, /unavailable/i);
  assert.equal(
    await fs.readFile(offline.entrypoint, 'utf8'),
    "export const version = 'current';\n"
  );

  const dependencyPath = path.join(
    setup.runtimeRoot,
    runtime.runtimeKey,
    dependency
  );
  await fs.unlink(dependencyPath);
  const repaired = await prepareCodexBridgeRuntime({
    ...setup,
    now: now + 60000,
    git: setup.localGit
  });
  assert.equal(repaired.runtimeKey, runtime.runtimeKey);
  assert.equal(
    await fs.readFile(dependencyPath, 'utf8'),
    'export const activityPolicyVersion = 1;\n'
  );
});

test('runtime manifests cannot export files outside the managed runtime', async (t) => {
  const setup = await fixture(t);
  const invalidManifest = JSON.stringify({
    version: 1,
    entrypoint,
    files: [entrypoint, '../escape.mjs']
  });
  await assert.rejects(
    prepareCodexBridgeRuntime({
      ...setup,
      git: async (args) => {
        if (
          args[0] === 'show' &&
          args[1].endsWith(':scripts/codex-bridge-runtime.json')
        )
          return invalidManifest;
        return setup.localGit(args);
      }
    }),
    /Invalid Codex bridge runtime manifest/
  );
  await assert.rejects(fs.access(setup.runtimeRoot), { code: 'ENOENT' });
});
