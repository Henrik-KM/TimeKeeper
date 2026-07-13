import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  makeCodexPayloadKey,
  readCodexSessionSummary
} from '../../scripts/codex-usage-bridge.mjs';
import {
  buildCodexUsageRecordsFromSessionData,
  buildCodexUsageRecordsFromSessionGroup,
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
  assert.equal(records[0].effectiveSeconds, 120);
  assert.equal(records[0].focusFactor, 0.4);
});

test('resolves model and effort focus factors with a safe unknown fallback', () => {
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-5.6-luna', effort: 'light' }).factor,
    0.2
  );
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-5.6-sol', effort: 'high' }).factor,
    0.5
  );
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-5.6-sol', effort: 'ultra' }).factor,
    0.6
  );
  assert.equal(
    resolveCodexFocusFactor({ model: 'gpt-future', effort: 'ultra' }).factor,
    0.4
  );
});

test('keeps the lowered Codex model scale evenly spaced', () => {
  const expected = {
    luna: { low: 0.2, medium: 0.25, high: 0.3, xhigh: 0.35, ultra: 0.4 },
    terra: { low: 0.3, medium: 0.35, high: 0.4, xhigh: 0.45, ultra: 0.5 },
    sol: { low: 0.4, medium: 0.45, high: 0.5, xhigh: 0.55, ultra: 0.6 }
  };

  Object.entries(expected).forEach(([model, efforts]) => {
    Object.entries(efforts).forEach(([effort, factor]) => {
      assert.equal(
        resolveCodexFocusFactor({
          model: `gpt-5.6-${model}`,
          effort
        }).factor,
        factor,
        `${model} ${effort}`
      );
    });
  });
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

test('streamed session parsing keeps the first subagent identity', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-codex-')
  );
  const filePath = path.join(directory, 'subagent.jsonl');
  const text = jsonl([
    {
      timestamp: '2026-06-13T09:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'subagent-thread',
        session_id: 'parent-thread',
        cwd: 'C:\\Users\\ccx55\\Documents\\GitHub\\Anders\\Research',
        thread_source: 'subagent',
        source: { subagent: {} }
      }
    },
    {
      timestamp: '2026-06-13T09:00:00.001Z',
      type: 'session_meta',
      payload: {
        id: 'parent-thread',
        session_id: 'parent-thread',
        cwd: 'C:\\Users\\ccx55\\Documents\\GitHub\\Anders\\Research',
        thread_source: 'user'
      }
    },
    {
      timestamp: '2026-06-13T09:00:00.002Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' }
    },
    {
      timestamp: '2026-06-13T09:10:00.000Z',
      type: 'response_item',
      payload: { type: 'message' }
    }
  ]);

  try {
    await fs.writeFile(filePath, text, 'utf8');
    const summary = await readCodexSessionSummary(
      filePath,
      new Date('2026-06-13T00:00:00.000Z')
    );

    assert.equal(summary.meta.id, 'subagent-thread');
    assert.equal(summary.meta.sessionId, 'parent-thread');
    assert.equal(summary.meta.threadSource, 'subagent');
    assert.equal(summary.meta.isSubagent, true);
    assert.equal(summary.activity.at(-1).model, 'gpt-5.6-sol');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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
  assert.equal(records[0].effectiveSeconds, 480);
  assert.equal(records[0].focusFactor, 0.4);
  assert.equal(records[0].focusPolicyVersion, 3);
  assert.deepEqual(records[0].modelBreakdown, [
    {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      factor: 0.6,
      wallSeconds: 600,
      effectiveSeconds: 360
    },
    {
      model: 'gpt-5.6-luna',
      effort: 'low',
      factor: 0.2,
      wallSeconds: 600,
      effectiveSeconds: 120
    }
  ]);
});

test('consolidates delegated sessions with uncapped discounted subagent credit', () => {
  const point = (timestamp) => ({
    timestamp: new Date(timestamp),
    model: 'gpt-5.6-sol',
    effort: 'ultra'
  });
  const activity = [
    point('2026-06-13T09:00:00.000Z'),
    point('2026-06-13T09:10:00.000Z')
  ];
  const parent = {
    meta: {
      id: 'parent-thread',
      sessionId: 'parent-thread',
      cwd: 'C:\\Users\\ccx55\\Documents\\GitHub\\Anders\\Research',
      isSubagent: false
    },
    activity
  };
  const subagents = Array.from({ length: 4 }, (_, index) => ({
    meta: {
      id: `subagent-${index + 1}`,
      sessionId: 'parent-thread',
      cwd: parent.meta.cwd,
      isSubagent: true
    },
    activity
  }));

  const records = buildCodexUsageRecordsFromSessionGroup({
    sessions: [parent, ...subagents],
    trackedProjects: [{ name: 'Anders', projectId: 'anders' }],
    threadNamesById: new Map([
      ['parent-thread', 'Execute research project end to end']
    ]),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].wallSeconds, 600);
  assert.equal(records[0].effectiveSeconds, 864);
  assert.equal(records[0].focusFactor, 1.44);
  assert.equal(records[0].delegationCredit, 0.35);
  assert.equal(records[0].delegatedSessionCount, 4);
  assert.equal(records[0].supersedesExternalIds.length, 1);
  assert.equal(
    records[0].description,
    'Codex: Execute research project end to end'
  );
  assert.deepEqual(records[0].modelBreakdown, [
    {
      role: 'parent',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      factor: 0.6,
      creditMultiplier: 1,
      creditedFactor: 0.6,
      wallSeconds: 600,
      effectiveSeconds: 360
    },
    {
      role: 'subagent',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      factor: 0.6,
      creditMultiplier: 0.35,
      creditedFactor: 0.21,
      wallSeconds: 2400,
      effectiveSeconds: 504
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
  assert.equal(records[0].effectiveSeconds, 240);
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
    [120, 240]
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
