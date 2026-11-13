import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePagesSite } from '../../scripts/prepare-pages.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

async function withFixture(run) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(
    path.join(temporaryRoot, 'timekeeper-pages-')
  );
  try {
    const source = path.join(directory, 'source');
    const output = path.join(directory, 'site');
    await mkdir(source);
    for (const file of [
      'index.html',
      'codex-analysis.html',
      'style.css',
      'service-worker.js',
      'manifest.webmanifest',
      'CNAME'
    ]) {
      await writeFile(path.join(source, file), file, 'utf8');
    }
    await mkdir(path.join(source, 'src', 'shared'), { recursive: true });
    await writeFile(
      path.join(source, 'src', 'shared', 'ui.mjs'),
      'public module'
    );
    await mkdir(path.join(source, 'assets'));
    await writeFile(
      path.join(source, 'assets', 'strava.json'),
      JSON.stringify({
        updated_utc: '2026-11-13T19:46:28Z',
        activities: [{ id: 145 }]
      })
    );
    await run({ source, output });
  } finally {
    assert.ok(directory.startsWith(temporaryRoot + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
}

test('Pages artifacts contain the fresh feed and runtime files, excluding private and development files', async () => {
  await withFixture(async ({ source, output }) => {
    for (const directory of [
      '_private',
      '.timekeeper-private',
      'scripts',
      'tests'
    ]) {
      await mkdir(path.join(source, directory));
      await writeFile(
        path.join(source, directory, 'not-public.txt'),
        'test-only sentinel'
      );
    }
    await preparePagesSite({ sourceDir: source, outputDir: output });
    assert.deepEqual((await readdir(output)).sort(), [
      'CNAME',
      'assets',
      'codex-analysis.html',
      'index.html',
      'manifest.webmanifest',
      'service-worker.js',
      'src',
      'style.css'
    ]);
    assert.equal(
      await readFile(path.join(output, 'src', 'shared', 'ui.mjs'), 'utf8'),
      'public module'
    );
    const feed = JSON.parse(
      await readFile(path.join(output, 'assets', 'strava.json'), 'utf8')
    );
    assert.equal(feed.activities[0].id, 145);
    assert.equal(feed.updated_utc, '2026-11-13T19:46:28Z');
  });
});

test('Pages staging refuses an old artifact or a directory inside its runtime source', async () => {
  await withFixture(async ({ source, output }) => {
    await mkdir(output);
    await writeFile(path.join(output, 'keep.txt'), 'existing output');
    await assert.rejects(
      preparePagesSite({ sourceDir: source, outputDir: output }),
      { code: 'EEXIST' }
    );
    assert.equal(
      await readFile(path.join(output, 'keep.txt'), 'utf8'),
      'existing output'
    );
    await assert.rejects(
      preparePagesSite({
        sourceDir: source,
        outputDir: path.join(source, 'assets', 'site')
      }),
      /separate from the public source/
    );
  });
});

test('a completed Strava refresh publishes current main through the public-only artifact', async () => {
  const workflows = new URL('../../.github/workflows/', import.meta.url);
  const pages = yaml.load(
    await readFile(new URL('pages.yml', workflows), 'utf8')
  );
  const strava = yaml.load(
    await readFile(new URL('strava.yml', workflows), 'utf8')
  );
  assert.ok(pages.on.workflow_run.workflows.includes(strava.name));
  assert.deepEqual(pages.on.workflow_run.types, ['completed']);
  assert.deepEqual(pages.on.workflow_run.branches, ['main']);
  const steps = pages.jobs.deploy.steps;
  const checkout = steps.find((step) =>
    step.uses?.startsWith('actions/checkout@')
  );
  assert.equal(checkout.with.ref, 'main');
  assert.equal(checkout.with['persist-credentials'], false);
  const prepareIndex = steps.findIndex(
    (step) => step.run === 'node scripts/prepare-pages.mjs'
  );
  const uploadIndex = steps.findIndex((step) =>
    step.uses?.startsWith('actions/upload-pages-artifact@')
  );
  assert.ok(prepareIndex >= 0 && prepareIndex < uploadIndex);
  assert.equal(steps[uploadIndex].with.path, '.pages-site');
  assert.equal(pages.concurrency['cancel-in-progress'], false);
});
