import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexUsageRecordsFromSessionText,
  findCodexMappingForCwd
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

test('maps Codex cwd by repo name', () => {
  const mapping = findCodexMappingForCwd(
    'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\IFLAI\\VWR-AutoInv',
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
    mappings: [{ match: 'VWR-AutoInv', projectId: 'iflai' }],
    threadNamesById: new Map([['thread-1', 'Plan POU vision demo']]),
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T08:40:00.000Z')
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].startTime, '2026-06-13T08:00:00.000Z');
  assert.equal(records[0].wallSeconds, 600);
  assert.equal(records[0].effectiveSeconds, 300);
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
    mappings: [{ match: 'particle_iden', projectId: 'anders' }],
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

test('does not emit records for projects mapped to None', () => {
  const records = buildCodexUsageRecordsFromSessionText({
    text: session({
      cwd: 'C:\\Users\\ccx55\\OneDrive\\Documents\\GitHub\\TimeKeeper',
      timestamps: ['2026-06-13T09:00:00.000Z', '2026-06-13T09:05:00.000Z']
    }),
    mappings: [{ match: 'TimeKeeper', projectId: null }],
    dayStart: new Date('2026-06-13T00:00:00.000Z'),
    now: new Date('2026-06-13T10:00:00.000Z')
  });

  assert.deepEqual(records, []);
});
