import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeUsageRecordsFromSessionGroup,
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
  const changed = { ...record, effectiveSeconds: record.effectiveSeconds + 1 };
  const third = importClaudeInboxRecords({
    ...input,
    entries: second.entries,
    payloads: [{ source: 'timekeeper-claude-bridge', records: [changed] }]
  });
  assert.equal(third.updated, 1);
  assert.equal(third.entries.length, 1);
  assert.equal(third.entries[0].duration, record.effectiveSeconds + 1);
  const archived = importClaudeInboxRecords({
    ...input,
    activeProjectIds: new Set()
  });
  assert.equal(archived.imported, 0);
  assert.equal(archived.skipped, 1);
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
