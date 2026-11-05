import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptsCodexActivityRecord } from '../../src/features/agents/activity.mjs';
import {
  getCodexSessionActivity,
  buildCodexUsageRecordsFromSessionGroup
} from '../../scripts/codex-usage-core.mjs';
import {
  readCodexSessionSummary,
  buildCodexSessionGroupPartitions
} from '../../scripts/codex-usage-bridge.mjs';
import {
  parseClaudeTranscript,
  buildClaudeUsagePartitionsFromSessionGroup
} from '../../scripts/claude-usage-core.mjs';
import {
  buildClaudeInboxPayload,
  buildClaudeBridgeOptions
} from '../../scripts/claude-usage-bridge.mjs';

const base = Date.parse('2026-09-23T07:00:00.000Z');
const at = (minute) => new Date(base + minute * 60000).toISOString();
const cwd = 'C:\\Users\\person\\Documents\\GitHub\\Anders\\example';
const projects = [{ name: 'Anders', projectId: 'anders' }];
const now = new Date(at(60));
const row = (minute, type, payload) => ({
  timestamp: at(minute),
  type,
  payload
});
function pausedEvents(tool = 'clock.sleep') {
  return [
    row(0, 'session_meta', { id: 'parent', session_id: 'parent', cwd }),
    row(0, 'turn_context', { model: 'gpt-6.1-sol', effort: 'max' }),
    row(1, 'response_item', {
      type: 'function_call',
      name: tool,
      call_id: 'pause',
      arguments: '{}'
    }),
    row(4, 'event_msg', { type: 'token_count' }),
    row(11, 'response_item', {
      type: 'function_call_output',
      call_id: 'pause',
      output: 'private result'
    }),
    row(12, 'event_msg', { type: 'task_complete' }),
    row(14, 'event_msg', { type: 'token_count' })
  ];
}
const build = (sessions) =>
  buildCodexUsageRecordsFromSessionGroup({
    sessions,
    trackedProjects: projects,
    now
  });

test('Codex reader and in-memory parser exclude pauses and closed turns across heartbeats', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-pause-test-')
  );
  try {
    for (const tool of [
      'clock.sleep',
      'collaboration.wait_agent',
      'functions.request_user_input'
    ]) {
      const events = pausedEvents(tool);
      const file = path.join(directory, 'session.jsonl');
      await fs.writeFile(
        file,
        events.map((event) => JSON.stringify(event)).join('\n')
      );
      const summary = await readCodexSessionSummary(file, new Date(0));
      assert.deepEqual(summary.activity, getCodexSessionActivity(events));
      assert.equal(JSON.stringify(summary).includes('private result'), false);
      const [record] = build([summary]);
      const [legacy] = build([
        {
          ...summary,
          activity: summary.activity.map((point) => ({
            ...point,
            active: true
          }))
        }
      ]);
      assert.equal(record.id, legacy.id);
      assert.equal(record.wallSeconds, 120);
      assert.equal(record.effectiveSeconds, 60);
      assert.equal(record.activityPolicyVersion, 1);
      assert.equal(legacy.wallSeconds, 840);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Codex sleep preserves independently running worker credit and legacy aggregate identity', () => {
  const parent = {
    meta: { id: 'parent', sessionId: 'parent', cwd },
    activity: getCodexSessionActivity(pausedEvents()),
    hasAssistantActivity: true
  };
  const child = {
    meta: { id: 'child', sessionId: 'parent', cwd, isSubagent: true },
    activity: [2, 7, 10].map((minute) => ({
      timestamp: new Date(at(minute)),
      model: 'gpt-6.1-sol',
      effort: 'max',
      active: true
    })),
    hasAssistantActivity: true
  };
  const [record] = build([parent, child]);
  const [legacy] = build(
    [parent, child].map((session) => ({
      ...session,
      activity: session.activity.map((point) => ({ ...point, active: true }))
    }))
  );
  assert.equal(record.id, legacy.id);
  assert.equal(record.wallSeconds, 600);
  assert.equal(record.effectiveSeconds, 144);
  assert.equal(record.delegatedSessionCount, 1);
  assert.equal(
    record.modelBreakdown.find((item) => item.role === 'subagent').wallSeconds,
    480
  );
});

test('Codex real tool polling remains credited and all-idle legacy entries are retracted', () => {
  const activity = getCodexSessionActivity(pausedEvents('functions.wait'));
  assert.equal(
    build([{ meta: { id: 'parent', cwd }, activity }])[0].wallSeconds,
    720
  );
  const idle = {
    meta: { id: 'idle', cwd },
    activity: [0, 5].map((minute) => ({
      timestamp: new Date(at(minute)),
      active: false
    })),
    hasAssistantActivity: true
  };
  const partitions = buildCodexSessionGroupPartitions({
    sessionGroups: [[idle]],
    trackedProjects: projects,
    now
  });
  assert.equal(partitions.records.length, 0);
  assert.equal(partitions.retractedExternalIds.length, 1);
});

test('old activity producers cannot add future inflated Codex records', () => {
  assert.equal(
    acceptsCodexActivityRecord({ endTime: '2026-11-06T12:00:00Z' }),
    false
  );
  assert.equal(
    acceptsCodexActivityRecord({
      endTime: '2026-11-06T12:00:00Z',
      activityPolicyVersion: 1
    }),
    true
  );
  assert.equal(
    acceptsCodexActivityRecord({ endTime: '2026-09-23T12:00:00Z' }),
    true
  );
});

test('Codex excludes shell and embedded sleeps while preserving productive commands', () => {
  /** @type {Array<[string, Record<string, string>, number]>} */
  const examples = [
    ['functions.exec_command', { cmd: 'sleep 600' }, 120],
    ['functions.exec_command', { cmd: 'npm test; sleep 5' }, 720],
    [
      'functions.exec',
      { code: 'await tools.clock__sleep({duration_ms: 600000});' },
      120
    ],
    [
      'functions.exec',
      {
        code: 'await tools.exec_command({cmd:"npm test"}); await tools.clock__sleep({duration_ms: 5});'
      },
      720
    ]
  ];
  for (const [name, input, expected] of examples) {
    const events = pausedEvents(name);
    events[2].payload.arguments = JSON.stringify(input);
    const [record] = build([
      { meta: { id: 'parent', cwd }, activity: getCodexSessionActivity(events) }
    ]);
    assert.equal(record.wallSeconds, expected, name);
  }
});

function claudeText(sessionId, extra = false, unique = false) {
  return [0, 1, 2, ...(extra ? [3, 4] : [])]
    .map((minute) =>
      JSON.stringify({
        type: minute === 0 ? 'user' : 'assistant',
        timestamp: at(minute),
        cwd,
        sessionId,
        uuid: `${unique ? sessionId : 'shared'}-${minute}`,
        message: { model: 'claude-opus-5-5', content: 'private text' }
      })
    )
    .join('\n');
}

test('Claude copied executions are credited once while genuine continuation and parallel work survive', () => {
  const seenExecutions = new Set();
  const partition = (id, extra = false, unique = false) =>
    buildClaudeUsagePartitionsFromSessionGroup({
      sessions: [parseClaudeTranscript(claudeText(id, extra, unique))],
      trackedProjects: projects,
      now,
      seenExecutions
    });
  const original = partition('original-session');
  const copied = partition('copied-session');
  const mixed = partition('mixed-session', true);
  const parallel = partition('parallel-session', false, true);
  assert.equal(original.records[0].effectiveSeconds, 60);
  assert.equal(copied.records.length, 0);
  assert.equal(copied.retractedExternalIds.length, 1);
  assert.equal(mixed.records[0].effectiveSeconds, 60);
  assert.equal(parallel.records[0].effectiveSeconds, 60);
  const [legacyMixed] = buildClaudeUsagePartitionsFromSessionGroup({
    sessions: [parseClaudeTranscript(claudeText('mixed-session', true))],
    trackedProjects: projects,
    now
  }).records;
  assert.equal(mixed.records[0].id, legacyMixed.id);
});

test('Claude ownership order survives newly discovered lower-sorting forks and old source mtimes', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-fork-test-')
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        content: Buffer.from(
          JSON.stringify({
            claude: { enabled: true },
            trackedProjects: projects
          })
        ).toString('base64')
      })
    );
  try {
    const statePath = path.join(directory, 'state.json');
    const projectsDir = path.join(directory, 'projects');
    await fs.mkdir(projectsDir);
    await fs.writeFile(
      statePath,
      JSON.stringify({ sessionOrder: ['zz-original-session'] })
    );
    const original = path.join(projectsDir, 'zz-original-session.jsonl');
    await fs.writeFile(original, claudeText('zz-original-session'));
    await fs.utimes(original, new Date(0), new Date(0));
    await fs.writeFile(
      path.join(projectsDir, 'aa-copied-session.jsonl'),
      claudeText('aa-copied-session', true)
    );
    const options = {
      ...buildClaudeBridgeOptions({}),
      projectsDir,
      statePath,
      now,
      dryRun: true
    };
    const payload = await buildClaudeInboxPayload(options);
    assert.equal(payload.records.length, 2);
    assert.equal(
      payload.records.find(
        (record) => record.sessionId === 'zz-original-session'
      ).effectiveSeconds,
      60
    );
    assert.equal(
      payload.records.find((record) => record.sessionId === 'aa-copied-session')
        .effectiveSeconds,
      60
    );
    assert.deepEqual(options.sessionOrder, [
      'zz-original-session',
      'aa-copied-session'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
