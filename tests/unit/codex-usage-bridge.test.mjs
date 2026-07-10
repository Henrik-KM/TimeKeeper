import assert from 'node:assert/strict';
import test from 'node:test';

import { makeCodexPayloadKey } from '../../scripts/codex-usage-bridge.mjs';
import {
  buildCodexUsageRecordsFromSessionData,
  buildCodexUsageRecordsFromSessionText,
  findTrackedProjectForCwd,
  getGitHubProjectPathInfo,
  getLocalLookbackStart,
  resolveCodexFocusFactor
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

test('starts the seven-day lookback at local midnight six days ago', () => {
  const rangeStart = getLocalLookbackStart(new Date(2026, 5, 13, 12, 30));

  assert.equal(rangeStart.getFullYear(), 2026);
  assert.equal(rangeStart.getMonth(), 5);
  assert.equal(rangeStart.getDate(), 7);
  assert.equal(rangeStart.getHours(), 0);
  assert.equal(rangeStart.getMinutes(), 0);
});

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

test('maps Codex cwd when it is the tracked GitHub project folder', () => {
  const cwd = 'C:\\Users\\ccx55\\Documents\\GitHub\\IFLAI';
  const pathInfo = getGitHubProjectPathInfo(cwd);
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd,
      timestamps: ['2026-06-13T09:00:00.000Z', '2026-06-13T09:05:00.000Z']
    }),
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai' }],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.deepEqual(pathInfo, {
    projectFolder: 'IFLAI',
    repoName: 'IFLAI'
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].projectKey, 'IFLAI');
  assert.equal(records[0].timekeeperProjectName, 'IFLAI');
  assert.equal(records[0].timekeeperProjectId, 'iflai');
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

test('builds Codex records from streamed session summary data', () => {
  const records = buildCodexUsageRecordsFromSessionData({
    meta: {
      id: 'thread-streamed',
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\Anders\\particle_iden'
    },
    timestamps: [
      new Date('2026-06-13T09:00:00.000Z'),
      new Date('2026-06-13T09:05:00.000Z')
    ],
    trackedProjects: [{ name: 'Anders', projectId: 'anders' }],
    now: new Date('2026-06-13T09:30:00.000Z')
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].projectKey, 'particle_iden');
  assert.equal(records[0].timekeeperProjectId, 'anders');
  assert.equal(records[0].wallSeconds, 300);
  assert.equal(records[0].effectiveSeconds, 150);
  assert.equal(records[0].focusFactor, 0.5);
});

test('resolves model and effort focus factors with a safe unknown fallback', () => {
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-5.6-luna', effort: 'light' }).factor,
    0.3
  );
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-5.6-sol', effort: 'ultra' }).factor,
    0.75
  );
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-future', effort: 'ultra' }).factor,
    0.5
  );
});

test('Codex payload fingerprint changes when model weighting changes', () => {
  const payload = {
    rangeStart: '2026-06-07T00:00:00.000Z',
    records: [
      {
        id: 'codex-record',
        focusFactor: 0.5,
        effectiveSeconds: 300
      }
    ]
  };
  const changedPayload = {
    ...payload,
    records: [
      {
        ...payload.records[0],
        focusFactor: 0.75,
        effectiveSeconds: 450
      }
    ]
  };

  assert.equal(makeCodexPayloadKey(payload), makeCodexPayloadKey(payload));
  assert.notEqual(
    makeCodexPayloadKey(payload),
    makeCodexPayloadKey(changedPayload)
  );
});

test('weights one Codex span across model changes without splitting it', () => {
  const text = jsonl([
    {
      timestamp: '2026-06-13T09:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'thread-model-switch',
        cwd: 'C:\\Users\\ccx55\\Documents\\GitHub\\IFLAI\\email-helper'
      }
    },
    {
      timestamp: '2026-06-13T09:00:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' }
    },
    {
      timestamp: '2026-06-13T09:10:00.000Z',
      type: 'response_item',
      payload: { type: 'message' }
    },
    {
      timestamp: '2026-06-13T09:10:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', effort: 'low' }
    },
    {
      timestamp: '2026-06-13T09:20:00.000Z',
      type: 'response_item',
      payload: { type: 'message' }
    }
  ]);

  const records = buildCodexUsageRecordsFromSessionText({
    text,
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai' }],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].wallSeconds, 1200);
  assert.equal(records[0].effectiveSeconds, 630);
  assert.equal(records[0].focusFactor, 0.525);
  assert.equal(records[0].focusPolicyVersion, 1);
  assert.deepEqual(records[0].modelBreakdown, [
    {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      factor: 0.75,
      wallSeconds: 600,
      effectiveSeconds: 450
    },
    {
      model: 'gpt-5.6-luna',
      effort: 'low',
      factor: 0.3,
      wallSeconds: 600,
      effectiveSeconds: 180
    }
  ]);
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
