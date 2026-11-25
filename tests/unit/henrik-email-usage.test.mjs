import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readEmailUsageRecords,
  validateEmailUsage
} from '../../scripts/henrik-email-usage.mjs';

const id = '11111111-2222-7333-8444-555555555555';
const now = new Date('2026-10-12T10:20:01Z');
function metadata(overrides = {}) {
  return {
    schema_version: 1,
    source: 'henrik-email',
    session_id: id,
    project: 'IFLAI',
    repository: 'email-helper',
    model: 'gpt-6.1-sol',
    reasoning_effort: 'max',
    started_at: '2026-10-12T10:00:00Z',
    finished_at: '2026-10-12T10:20:00Z',
    duration_seconds: 1200,
    timing_source: 'measured',
    outcome: 'completed',
    usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 },
    ...overrides
  };
}

async function fixture(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-email-test-')
  );
  try {
    await fs.writeFile(
      path.join(directory, `${id}.json`),
      JSON.stringify(metadata())
    );
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function options(directory, overrides = {}) {
  return {
    directory,
    now,
    windowStart: new Date('2026-10-04T00:00:00Z'),
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai-project' }],
    ...overrides
  };
}

test('finished long email work uses the normal Sol weighting without chat idle truncation', async () => {
  await fixture(async (directory) => {
    const { records, audit } = await readEmailUsageRecords(options(directory));
    assert.equal(records.length, 1);
    assert.equal(records[0].threadId, id);
    assert.equal(records[0].timekeeperProjectId, 'iflai-project');
    assert.equal(records[0].timekeeperProjectName, 'IFLAI');
    assert.equal(records[0].projectKey, 'email-helper');
    assert.equal(records[0].description, 'Codex: email-helper');
    assert.equal(records[0].wallSeconds, 1200);
    assert.equal(records[0].effectiveSeconds, 600);
    assert.equal(records[0].modelBreakdown[0].model, 'gpt-6.1-sol');
    assert.equal(records[0].modelBreakdown[0].effort, 'max');
    assert.equal(records[0].tokenUsage.output_tokens, 100);
    assert.equal(audit.imported, 1);
  });
});

test('repeat imports have stable identities and normal session records prevent double credit', async () => {
  await fixture(async (directory) => {
    const first = await readEmailUsageRecords(options(directory));
    const second = await readEmailUsageRecords(options(directory));
    assert.deepEqual(second.records, first.records);
    const duplicate = await readEmailUsageRecords(
      options(directory, { normalRecords: first.records })
    );
    assert.equal(duplicate.records.length, 0);
    assert.equal(duplicate.audit.duplicateSessions, 1);
  });
});

test('email accounting obeys configured repository and model focus policy', async () => {
  await fixture(async (directory) => {
    const { records } = await readEmailUsageRecords(
      options(directory, {
        focusPolicy: {
          version: 7,
          modelOverrides: { 'gpt-6.1-sol': 0.6 },
          repositoryMultipliers: { 'email-helper': 0.5 }
        }
      })
    );
    assert.equal(records[0].effectiveSeconds, 360);
    assert.equal(records[0].focusFactor, 0.3);
  });
});

test('private fields, fake identity, invalid timing and nonnumeric token values fail closed', () => {
  for (const change of [
    { subject: 'PRIVATE_SENTINEL' },
    { source: 'other' },
    { session_id: '../escape' },
    { project: 'Anders' },
    { repository: 'other' },
    { duration_seconds: 100 },
    { finished_at: '2026-10-12T10:30:00Z' },
    { started_at: '2026-10-12T10:00:00' },
    { usage: { auth_token: 'SECRET_SENTINEL' } },
    { usage: { input_tokens: -1 } },
    { usage: { input_tokens: '100' } }
  ])
    assert.equal(validateEmailUsage(metadata(change), now), null);
});

test('invalid feed records are counted without leaking source fields', async () => {
  await fixture(async (directory) => {
    await fs.writeFile(
      path.join(directory, `${id}.json`),
      JSON.stringify(metadata({ body: 'PRIVATE_SENTINEL' }))
    );
    const result = await readEmailUsageRecords(options(directory));
    assert.equal(result.records.length, 0);
    assert.equal(result.audit.invalid, 1);
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  });
});

test('legacy timing is labeled and retained runs outside the requested window are excluded', async () => {
  await fixture(async (directory) => {
    await fs.writeFile(
      path.join(directory, `${id}.json`),
      JSON.stringify(metadata({ timing_source: 'legacy_file_time' }))
    );
    const imported = await readEmailUsageRecords(options(directory));
    assert.equal(imported.records[0].timingSource, 'legacy_file_time');
    assert.equal(imported.audit.estimatedSessions, 1);
    const stale = await readEmailUsageRecords(
      options(directory, { windowStart: now })
    );
    assert.equal(stale.records.length, 0);
    assert.equal(stale.audit.outsideWindow, 1);
  });
});

test('missing IFLAI mapping is an explicit blocker and an absent feed is harmless', async () => {
  await fixture(async (directory) => {
    const missing = await readEmailUsageRecords(
      options(directory, { trackedProjects: [] })
    );
    assert.equal(missing.records.length, 0);
    assert.equal(missing.audit.blocker, 'iflai_project_not_configured');
    const absent = await readEmailUsageRecords(
      options(path.join(directory, 'absent'))
    );
    assert.equal(absent.records.length, 0);
    assert.equal(absent.audit.blocker, '');
  });
});

test('API email, outreach, and writing credit the correct project once without publishing private paths', async () => {
  await fixture(async (directory) => {
    const root = (name) =>
      path.join(directory, name, '.local', 'state', 'timekeeper_usage');
    const otherId = '33333333-2222-7333-8444-555555555555';
    const writingId = '44444444-2222-7333-8444-555555555555';
    const parentId = '55555555-2222-7333-8444-555555555555';
    const mail = metadata({
      schema_version: 2,
      provider: 'openai-responses',
      model: 'gpt-6.2-sol'
    });
    const outreach = {
      ...mail,
      source: 'henrik-outreach',
      session_id: otherId
    };
    const writing = {
      ...mail,
      source: 'henrik-writing',
      session_id: writingId,
      parent_session_id: parentId,
      project: undefined,
      repository: undefined,
      cwd: 'C:\\Users\\Private\\Documents\\GitHub\\PhD\\Research'
    };
    for (const record of [mail, outreach, writing]) {
      await fs.mkdir(root(record.source), { recursive: true });
      await fs.writeFile(
        path.join(root(record.source), `${record.session_id}.json`),
        JSON.stringify(record)
      );
    }
    const parent = {
      threadId: parentId,
      timekeeperProjectId: 'research-project',
      timekeeperProjectName: 'PhD',
      projectKey: 'Research'
    };
    const settings = options(root('henrik-email'), {
      normalRecords: [parent],
      focusPolicy: { modelOverrides: { 'gpt-6.2-sol': 0.5 } }
    });
    const { records, audit } = await readEmailUsageRecords(settings);
    assert.deepEqual(
      records.map((record) => [record.description, record.timekeeperProjectId]),
      [
        ['API: email drafting', 'iflai-project'],
        ['API: outreach', 'iflai-project'],
        ['API: writing', 'research-project']
      ]
    );
    assert.equal(audit.imported, 3);
    assert.equal(JSON.stringify(records).includes('\\\\Private\\\\'), false);
    assert.ok(
      records.every(
        (record) =>
          record.effectiveSeconds === 600 &&
          record.tokenUsage.output_tokens === 100
      )
    );
    const repeat = await readEmailUsageRecords({
      ...settings,
      normalRecords: [parent, ...records]
    });
    assert.equal(repeat.audit.duplicateSessions, 3);
    assert.deepEqual(repeat.records, []);
  });
});
