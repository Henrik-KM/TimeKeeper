import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexUsageRecordsFromSessionText,
  findTrackedProjectForCwd,
  getGitHubProjectPathInfo
} from '../../scripts/codex-usage-core.mjs';

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function session({ cwd, id = 'thread-1', timestamps = [] }) {
  return jsonl([
    {
      timestamp: timestamps[0] || '2026-06-13T08:00:00.000Z',
      type: 'session_meta',
      payload: { id, cwd }
    },
    ...timestamps.map((timestamp, index) => ({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: `prompt text that must not be exported ${index}`
      }
    }))
  ]);
}

test('maps Codex cwd by TimeKeeper project parent folder', () => {
  const cwd =
    'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\IFLAI\\VWR-AutoInv\\src';
  const pathInfo = getGitHubProjectPathInfo(cwd);
  const mapping = findTrackedProjectForCwd(cwd, [
    { name: 'IFLAI', projectId: 'iflai' },
    { name: 'Anders', projectId: 'anders' }
  ]);

  assert.deepEqual(pathInfo, {
    projectFolder: 'IFLAI',
    repoName: 'VWR-AutoInv'
  });
  assert.equal(mapping.repoName, 'VWR-AutoInv');
  assert.equal(mapping.projectName, 'IFLAI');
  assert.equal(mapping.projectId, 'iflai');
});

test('ignores GitHub parent folders that are not TimeKeeper projects', () => {
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\Polish\\Drafting',
      timestamps: ['2026-06-13T09:00:00.000Z', '2026-06-13T09:05:00.000Z']
    }),
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai' }],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.deepEqual(records, []);
});

test('keeps legacy repo mappings as a fallback when no project list exists', () => {
  const mapping = findTrackedProjectForCwd(
    'C:\\Users\\ccx55\\OneDrive\\Documents\\Code\\VWR-AutoInv',
    [],
    [{ match: 'VWR-AutoInv', projectId: 'iflai' }]
  );

  assert.equal(mapping.repoName, 'VWR-AutoInv');
  assert.equal(mapping.projectId, 'iflai');
});

test('ignores Codex activity before the configured day start', () => {
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\IFLAI\\VWR-AutoInv',
      timestamps: [
        '2026-06-12T23:50:00.000Z',
        '2026-06-13T08:00:00.000Z',
        '2026-06-13T08:10:00.000Z'
      ]
    }),
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai' }],
    threadNamesById: new Map([['thread-1', 'Plan POU vision demo']]),
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T08:40:00.000Z')
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].startTime, '2026-06-13T08:00:00.000Z');
  assert.equal(records[0].wallSeconds, 600);
  assert.equal(records[0].effectiveSeconds, 300);
  assert.equal(records[0].projectKey, 'VWR-AutoInv');
  assert.equal(records[0].timekeeperProjectName, 'IFLAI');
  assert.equal(records[0].description, 'Codex: Plan POU vision demo');
  assert.equal(JSON.stringify(records).includes('prompt text'), false);
});

test('splits active Codex spans across idle gaps', () => {
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\Anders\\particle_iden',
      timestamps: [
        '2026-06-13T09:00:00.000Z',
        '2026-06-13T09:05:00.000Z',
        '2026-06-13T09:30:00.000Z',
        '2026-06-13T09:40:00.000Z'
      ]
    }),
    trackedProjects: [{ name: 'Anders', projectId: 'anders' }],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.wallSeconds),
    [300, 600]
  );
  assert.deepEqual(
    records.map((record) => record.effectiveSeconds),
    [150, 300]
  );
});

test('does not emit records for repos directly under GitHub root', () => {
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\TimeKeeper',
      timestamps: ['2026-06-13T09:00:00.000Z', '2026-06-13T09:05:00.000Z']
    }),
    trackedProjects: [
      { name: 'IFLAI', projectId: 'iflai' },
      { name: 'Anders', projectId: 'anders' }
    ],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.deepEqual(records, []);
});
