import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaudeUsageRecordsFromSessionGroup,
  buildClaudeUsagePartitionsFromSessionGroup,
  parseClaudeTranscript
} from '../../scripts/claude-usage-core.mjs';
import {
  DEFAULT_CLAUDE_POLICY,
  getClaudeModelFactor
} from '../../src/features/claude/policy.mjs';
import {
  importClaudeInboxRecords,
  normalizeClaudeIntegration
} from '../../src/features/claude/inbox.mjs';
import {
  computeRollingSourceTotals,
  getEntrySource,
  groupTimeEntries
} from '../../src/features/time-usage/core.mjs';
import { buildCodexSourceAverages } from '../../src/features/codex/analytics.mjs';
import {
  buildClaudeBridgeOptions,
  buildClaudeInboxPayload,
  makeClaudePayloadKey
} from '../../scripts/claude-usage-bridge.mjs';

const project = { name: 'Anders', projectId: 'project-anders' };
const cwd = 'C:\\Users\\person\\Documents\\GitHub\\Anders\\example';
const sessionId = '11111111-2222-4333-8444-555555555555';
const t = (minutes) => Date.parse('2026-09-23T07:00:00.000Z') + minutes * 60000;

function makeGroup(sessions, nowMinutes = 60) {
  return buildClaudeUsageRecordsFromSessionGroup({
    sessions,
    trackedProjects: [project],
    now: new Date(t(nowMinutes))
  });
}

test('Claude parser keeps metadata and tolerates partial logs without carrying content', () => {
  const lines = [
    {
      type: 'user',
      timestamp: new Date(t(0)).toISOString(),
      sessionId,
      cwd,
      message: { content: 'private prompt' }
    },
    {
      type: 'assistant',
      timestamp: new Date(t(1)).toISOString(),
      sessionId,
      cwd,
      message: { model: 'claude-opus-5-5', content: 'secret answer' }
    },
    {
      type: 'assistant',
      timestamp: new Date(t(2)).toISOString(),
      sessionId,
      cwd,
      message: { model: '<synthetic>', content: 'secret tool result' }
    }
  ].map((line) => JSON.stringify(line));
  const parsed = parseClaudeTranscript(`${lines.join('\n')}\n{"unfinished":`, {
    parentSessionId: sessionId
  });
  assert.equal(parsed.activity.length, 3);
  assert.deepEqual(
    parsed.activity.map((point) => point.model),
    ['opus', 'opus', 'opus']
  );
  assert.equal(JSON.stringify(parsed).includes('secret'), false);
  assert.equal(JSON.stringify(parsed).includes('private prompt'), false);
});

function transcript(events) {
  return parseClaudeTranscript(
    events
      .map(({ minute, ...event }) =>
        JSON.stringify({
          ...event,
          timestamp: new Date(t(minute)).toISOString(),
          sessionId,
          cwd
        })
      )
      .join('\n'),
    { parentSessionId: sessionId }
  );
}

function conversationWithWait(tool = null) {
  return transcript([
    { type: 'user', minute: 0, message: { content: 'Start' } },
    {
      type: 'assistant',
      minute: 1,
      message: {
        id: 'response-one',
        model: 'claude-opus-5-5',
        stop_reason: tool ? 'tool_use' : 'end_turn',
        content: [{ type: 'thinking', thinking: 'private reasoning' }]
      }
    },
    {
      type: 'assistant',
      minute: 2,
      message: {
        id: 'response-one',
        model: 'claude-opus-5-5',
        stop_reason: tool ? 'tool_use' : 'end_turn',
        content: tool
          ? [{ type: 'tool_use', id: 'tool-one', ...tool }]
          : [{ type: 'text', text: 'Which option?' }]
      }
    },
    {
      type: 'user',
      minute: 12,
      message: {
        content: tool
          ? [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'Done' }]
          : 'Option A'
      }
    },
    {
      type: 'assistant',
      minute: 13,
      message: {
        id: 'response-two',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }]
      }
    }
  ]);
}

test('completed questions exclude reply waits and retain streamed response time', () => {
  const session = conversationWithWait();
  const [record] = makeGroup([session]);
  assert.equal(record.wallSeconds, 180);
  assert.equal(record.effectiveSeconds, 90);
  const legacy = {
    ...session,
    activity: session.activity.map(({ time, model }) => ({ time, model }))
  };
  assert.equal(record.id, makeGroup([legacy])[0].id);
  assert.equal(JSON.stringify(session).includes('private reasoning'), false);
});

test('question tools and passive HPC polling exclude their blocking intervals', () => {
  for (const tool of [
    { name: 'AskUserQuestion', input: { questions: [] } },
    { name: 'mcp__questions__request_user_input', input: {} },
    { name: 'ExitPlanMode', input: {} },
    { name: 'TaskOutput', input: { block: true } },
    {
      name: 'Bash',
      input: {
        command:
          'for i in $(seq 1 19); do timeout 30 tail -f /dev/null; done; ssh cluster "sacct -j 123"'
      }
    },
    { name: 'Bash', input: { command: 'sleep 600' } },
    { name: 'Bash', input: { command: 'Start-Sleep -Seconds 600' } },
    {
      name: 'Bash',
      input: {
        command:
          'timeout 600 tail -f /dev/null; python3 -c "import json; print(json.load(open(\'status.json\')))"'
      }
    }
  ]) {
    const [record] = makeGroup([conversationWithWait(tool)]);
    assert.equal(record.wallSeconds, 180, tool.name);
    assert.equal(record.effectiveSeconds, 90, tool.name);
  }
});

test('real tool execution remains credited even with a trailing wait', () => {
  for (const command of ['npm test; sleep 5', 'python train.py; sleep 5']) {
    const [record] = makeGroup([
      conversationWithWait({ name: 'Bash', input: { command } })
    ]);
    assert.equal(record.wallSeconds, 780);
  }
});

test('active subagents remain credited while the parent awaits a reply', () => {
  const parent = conversationWithWait();
  const child = {
    sessionId,
    cwd,
    isSubagent: true,
    agentId: 'working-child',
    activity: [
      { time: t(4), model: 'sonnet' },
      { time: t(9), model: 'sonnet' }
    ]
  };
  const [record] = makeGroup([parent, child]);
  assert.equal(record.wallSeconds, 480);
  assert.equal(record.effectiveSeconds, 132);
  assert.equal(record.delegatedSessionCount, 1);
});

test('entirely passive spans retract their original stable record ID', () => {
  const session = transcript([
    {
      type: 'assistant',
      minute: 0,
      message: {
        model: 'claude-opus-5-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }]
      }
    },
    { type: 'user', minute: 10, message: { content: 'Answer' } }
  ]);
  const legacy = {
    ...session,
    activity: session.activity.map(({ time, model }) => ({ time, model }))
  };
  const result = buildClaudeUsagePartitionsFromSessionGroup({
    sessions: [session],
    trackedProjects: [project],
    now: new Date(t(60))
  });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.retractedExternalIds, [makeGroup([legacy])[0].id]);
});

test('historical corrections preserve entry identity and reject stale feeds', () => {
  const [record] = makeGroup([conversationWithWait()]);
  const legacy = {
    ...record,
    wallSeconds: 780,
    effectiveSeconds: 390,
    focusPolicyVersion: 1
  };
  const input = {
    activeProjectIds: new Set([project.projectId]),
    windowStart: new Date(t(-60)),
    now: new Date(t(90)),
    createId: () => 'keep-entry-id'
  };
  const old = importClaudeInboxRecords({
    ...input,
    payloads: [{ source: 'timekeeper-claude-bridge', records: [legacy] }]
  });
  old.entries[0].notes = 'Keep this user field';
  const repairPayload = {
    source: 'timekeeper-claude-bridge',
    updatedAt: new Date(t(80)).toISOString(),
    records: [{ ...record, repairOnly: true }]
  };
  const repair = importClaudeInboxRecords({
    ...input,
    entries: old.entries,
    windowStart: new Date(t(30)),
    payloads: [repairPayload]
  });
  assert.equal(repair.updated, 1);
  assert.equal(repair.entries[0].id, 'keep-entry-id');
  assert.equal(repair.entries[0].notes, 'Keep this user field');
  assert.equal(repair.entries[0].duration, 90);
  assert.equal(
    importClaudeInboxRecords({ ...input, payloads: [repairPayload] }).imported,
    0
  );
  assert.equal(
    importClaudeInboxRecords({
      ...input,
      minimumPolicyVersion: 2,
      payloads: [{ source: 'timekeeper-claude-bridge', records: [legacy] }]
    }).imported,
    0
  );
  for (const payloads of [
    [repairPayload, { source: 'timekeeper-claude-bridge', records: [legacy] }],
    [{ source: 'timekeeper-claude-bridge', records: [legacy] }, repairPayload],
    [
      {
        source: 'timekeeper-claude-bridge',
        updatedAt: new Date(t(70)).toISOString(),
        records: [{ ...record, effectiveSeconds: 300 }]
      }
    ]
  ]) {
    const repeated = importClaudeInboxRecords({
      ...input,
      entries: repair.entries,
      payloads
    });
    assert.equal(repeated.entries.length, 1);
    assert.equal(repeated.entries[0].duration, 90);
  }
});

test('retractions persist and only remove matching Claude imports', () => {
  const [record] = makeGroup([conversationWithWait()]);
  const entries = [
    { id: 'old-import', source: 'claude', externalId: record.id },
    { id: 'manual', source: 'manual', externalId: record.id }
  ];
  const input = {
    activeProjectIds: new Set([project.projectId]),
    windowStart: new Date(t(-60)),
    now: new Date(t(90)),
    createId: () => 'new'
  };
  const result = importClaudeInboxRecords({
    ...input,
    entries,
    payloads: [
      { source: 'timekeeper-claude-bridge', records: [record] },
      {
        source: 'timekeeper-claude-bridge',
        focusPolicyVersion: 2,
        records: [],
        retractedExternalIds: [record.id]
      }
    ]
  });
  assert.equal(result.reconciled, 1);
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ['manual']
  );
  const config = normalizeClaudeIntegration({
    retractedRecordIds: [...result.retractedExternalIds, 'invalid']
  });
  const repeated = importClaudeInboxRecords({
    ...input,
    entries: result.entries,
    retractedExternalIds: config.retractedRecordIds,
    payloads: [{ source: 'timekeeper-claude-bridge', records: [record] }]
  });
  assert.equal(repeated.imported, 0);
  assert.deepEqual(repeated.retractedExternalIds, [record.id]);
});

test('history repair is explicit and retractions change the bridge publish key', () => {
  assert.equal(buildClaudeBridgeOptions({}).repairHistory, false);
  assert.equal(
    buildClaudeBridgeOptions({ lookbackDays: 'all' }).repairHistory,
    true
  );
  assert.notEqual(
    makeClaudePayloadKey({ records: [] }),
    makeClaudePayloadKey({
      records: [],
      retractedExternalIds: ['claude:11111111111111111111111111111111']
    })
  );
});

test('moving the import window does not mint a second ID for an overnight span', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-claude-test-')
  );
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('Unexpected fixture location');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: Buffer.from(
            JSON.stringify({
              trackedProjects: [project],
              claude: { enabled: true }
            })
          ).toString('base64')
        }),
        { status: 200 }
      );
    const times = [
      new Date(2026, 9, 7, 23, 55),
      new Date(2026, 9, 8, 0, 2),
      new Date(2026, 9, 8, 0, 5),
      new Date(2026, 9, 8, 0, 10)
    ];
    await fs.writeFile(
      path.join(directory, `${sessionId}.jsonl`),
      times
        .map((time, index) =>
          JSON.stringify({
            timestamp: time.toISOString(),
            sessionId,
            cwd,
            type: index % 2 ? 'assistant' : 'user',
            message:
              index % 2
                ? {
                    model: 'claude-opus-5-5',
                    stop_reason: index === 3 ? 'end_turn' : 'tool_use',
                    content: 'Response'
                  }
                : { content: 'Input' }
          })
        )
        .join('\n')
    );
    const options = buildClaudeBridgeOptions({
      projectsDir: directory,
      now: new Date(2026, 10, 5, 12).toISOString(),
      dryRun: true
    });
    const before = await buildClaudeInboxPayload(options);
    const after = await buildClaudeInboxPayload({
      ...options,
      now: new Date(2026, 10, 6, 12)
    });
    assert.equal(before.records.length, 1);
    assert.equal(after.records.length, 0);
    const repair = await buildClaudeInboxPayload({
      ...options,
      repairHistory: true
    });
    assert.equal(repair.records[0].id, before.records[0].id);
    assert.equal(repair.records[0].repairOnly, true);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Claude model factors are family-specific and effort-independent', () => {
  assert.equal(getClaudeModelFactor('claude-fable-1'), 0.75);
  assert.equal(getClaudeModelFactor('claude-opus-5-5'), 0.5);
  assert.equal(getClaudeModelFactor('claude-sonnet-4'), 0.4);
  assert.equal(getClaudeModelFactor('claude-haiku-4'), 0.3);
  assert.equal(getClaudeModelFactor('future-model'), 0.4);
  assert.equal(DEFAULT_CLAUDE_POLICY.delegationCredit, 0.35);
});

test('subagent overlap counts wall time once and credits delegated work at 35%', () => {
  const parent = {
    sessionId,
    cwd,
    isSubagent: false,
    activity: [
      { time: t(0), model: 'opus' },
      { time: t(10), model: 'opus' }
    ]
  };
  const child = {
    sessionId,
    cwd,
    agentId: 'agent-one',
    isSubagent: true,
    activity: [
      { time: t(5), model: 'sonnet' },
      { time: t(15), model: 'sonnet' }
    ]
  };
  const [record] = makeGroup([parent, child]);
  assert.equal(record.wallSeconds, 900);
  assert.equal(record.effectiveSeconds, 384);
  assert.equal(record.delegatedSessionCount, 1);
  assert.equal(record.timekeeperProjectId, project.projectId);
  assert.equal(record.repoName, 'example');
  assert.equal(JSON.stringify(record).includes('C:\\Users'), false);
});

test('idle gaps split spans and the latest span waits 17 minutes', () => {
  const parent = {
    sessionId,
    cwd,
    isSubagent: false,
    activity: [
      { time: t(0), model: 'opus' },
      { time: t(5), model: 'opus' },
      { time: t(30), model: 'opus' },
      { time: t(35), model: 'opus' }
    ]
  };
  const early = makeGroup([parent], 45);
  assert.equal(early.length, 1);
  assert.equal(early[0].wallSeconds, 300);
  const mature = makeGroup([parent], 53);
  assert.equal(mature.length, 2);
  assert.notEqual(mature[0].id, mature[1].id);
});

test('untracked projects never produce Claude records', () => {
  const sessions = [
    {
      sessionId,
      cwd,
      isSubagent: false,
      activity: [
        { time: t(0), model: 'opus' },
        { time: t(5), model: 'opus' }
      ]
    }
  ];
  assert.deepEqual(
    buildClaudeUsageRecordsFromSessionGroup({
      sessions,
      trackedProjects: [],
      now: new Date(t(60))
    }),
    []
  );
});

test('Claude inbox imports once, updates changed records, and rejects missing projects', () => {
  const [record] = makeGroup([
    {
      sessionId,
      cwd,
      isSubagent: false,
      activity: [
        { time: t(0), model: 'opus' },
        { time: t(10), model: 'opus' }
      ]
    }
  ]);
  const input = {
    entries: [],
    payloads: [{ source: 'timekeeper-claude-bridge', records: [record] }],
    activeProjectIds: new Set([project.projectId]),
    windowStart: new Date(t(-60)),
    now: new Date(t(60)),
    createId: () => 'entry-one'
  };
  const first = importClaudeInboxRecords(input);
  assert.equal(first.imported, 1);
  assert.equal(first.entries[0].source, 'claude');
  assert.equal(first.entries[0].elapsedSeconds, 600);
  const second = importClaudeInboxRecords({ ...input, entries: first.entries });
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.skipped, 0);
  const changed = { ...record, effectiveSeconds: record.effectiveSeconds + 1 };
  const third = importClaudeInboxRecords({
    ...input,
    entries: second.entries,
    payloads: [{ source: 'timekeeper-claude-bridge', records: [changed] }]
  });
  assert.equal(third.updated, 1);
  assert.equal(third.unchanged, 0);
  assert.equal(third.entries.length, 1);
  assert.equal(third.entries[0].duration, record.effectiveSeconds + 1);
  const archived = importClaudeInboxRecords({
    ...input,
    activeProjectIds: new Set()
  });
  assert.equal(archived.imported, 0);
  assert.equal(archived.skipped, 1);
  assert.equal(archived.unchanged, 0);
  const privatePayload = importClaudeInboxRecords({
    ...input,
    payloads: [
      {
        source: 'timekeeper-claude-bridge',
        records: [
          {
            ...record,
            repoName: 'C:\\Users\\private\\project',
            description: 'private prompt',
            modelBreakdown: record.modelBreakdown.map((row) => ({
              ...row,
              toolOutput: 'private tool output'
            }))
          }
        ]
      }
    ]
  });
  assert.equal(privatePayload.entries[0].description, 'Claude work');
  assert.equal(
    JSON.stringify(privatePayload.entries).includes('private'),
    false
  );
});

test('older profiles keep Claude off and source totals sum to completed rolling time', () => {
  assert.equal(normalizeClaudeIntegration().enabled, false);
  const start = new Date(t(-60));
  const endExclusive = new Date(t(60));
  const entries = [
    { projectId: 'p', startTime: new Date(t(0)).toISOString(), duration: 3600 },
    {
      projectId: 'p',
      source: 'manual',
      startTime: new Date(t(1)).toISOString(),
      duration: 600
    },
    {
      projectId: 'p',
      source: 'codex',
      startTime: new Date(t(2)).toISOString(),
      duration: 1200
    },
    {
      projectId: 'p',
      source: 'claude',
      startTime: new Date(t(3)).toISOString(),
      duration: 900
    },
    {
      projectId: 'p',
      source: 'claude',
      isRunning: true,
      startTime: new Date(t(4)).toISOString(),
      duration: 1000
    }
  ];
  const totals = computeRollingSourceTotals(entries, {
    start,
    endExclusive,
    projectIds: new Set(['p'])
  });
  assert.deepEqual(totals, {
    you: 4200,
    codex: 1200,
    claude: 900,
    total: 6300
  });
  assert.equal(totals.you + totals.codex + totals.claude, totals.total);
  assert.equal(getEntrySource(entries[3]), 'claude');
  assert.equal(
    groupTimeEntries(entries).some((group) => group.source === 'claude'),
    true
  );
});

test('Codex source averages exclude Claude time', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const entries = [
    { source: 'timer', startTime: '2026-09-23T07:00:00.000Z', duration: 3600 },
    { source: 'codex', startTime: '2026-09-23T08:00:00.000Z', duration: 1800 },
    { source: 'claude', startTime: '2026-09-23T09:00:00.000Z', duration: 2400 }
  ];
  const result = buildCodexSourceAverages(entries, now);
  assert.equal(result.week.meEffectiveSeconds, 3600);
  assert.equal(result.week.codexEffectiveSeconds, 1800);
});
