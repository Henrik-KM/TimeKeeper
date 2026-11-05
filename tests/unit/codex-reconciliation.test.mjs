import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCodexCorrections,
  normalizeCodexRecordIds,
  reconcileCodexEntries
} from '../../src/features/codex/reconciliation.mjs';

function entry(overrides = {}) {
  return {
    id: 'original',
    projectId: 'work',
    source: 'codex',
    externalId: 'codex-original',
    description: 'Codex: same title',
    startTime: '2026-09-01T08:00:00.000Z',
    endTime: '2026-09-01T09:00:00.000Z',
    duration: 1800,
    elapsedSeconds: 3600,
    codexFocusPolicyVersion: 7,
    ...overrides
  };
}

test('consolidates an external ID while retaining complete recovery data', () => {
  const old = entry({ notes: 'Keep this user field', custom: { unknown: 42 } });
  const preferred = entry({
    id: 'copy',
    codexRecordUpdatedAt: '2026-09-02T08:00:00.000Z'
  });
  const original = structuredClone([old, preferred]);
  const result = reconcileCodexEntries([old, preferred]);
  assert.deepEqual(result.entries, [preferred]);
  assert.deepEqual(result.removed[0].entry, original[0]);
  assert.equal(result.removed[0].reason, 'duplicate');
  assert.deepEqual(result.retractedExternalIds, []);
  assert.deepEqual([old, preferred], original);
  assert.equal(reconcileCodexEntries(result.entries).removed.length, 0);
});

test('does not merge overlapping work from separate sessions or manual entries', () => {
  const a = entry({ codexThreadId: 'session-a' });
  const b = entry({
    id: 'other-session',
    externalId: 'codex-other',
    codexThreadId: 'session-b'
  });
  const manual = entry({ id: 'manual', source: 'manual' });
  const timer = entry({ id: 'timer', source: 'timer' });
  const result = reconcileCodexEntries([a, b, manual, timer]);
  assert.equal(result.entries.length, 4);
  assert.equal(result.removed.length, 0);
});

test('recognizes alternate IDs for the same explicit session interval', () => {
  const old = entry({ codexThreadId: 'session-a' });
  const replacement = entry({
    id: 'aggregate',
    externalId: 'codex-aggregate',
    codexThreadId: 'session-a',
    codexDelegatedSessionCount: 2
  });
  const result = reconcileCodexEntries([old, replacement]);
  assert.deepEqual(result.entries, [replacement]);
  assert.deepEqual(result.retractedExternalIds, ['codex-original']);
});

test('saved supersession survives feed expiry and a stale replay', () => {
  const aggregate = entry({
    id: 'aggregate',
    externalId: 'codex-aggregate',
    codexSupersedesExternalIds: ['codex-original', 'codex-aggregate']
  });
  const result = reconcileCodexEntries([entry(), aggregate]);
  assert.deepEqual(result.entries, [aggregate]);
  assert.deepEqual(result.retractedExternalIds, ['codex-original']);
  const replay = reconcileCodexEntries([aggregate, entry()], {
    retractedExternalIds: JSON.parse(
      JSON.stringify(result.retractedExternalIds)
    )
  });
  assert.deepEqual(replay.entries, [aggregate]);
});

test('a same-thread aggregate replaces an old midnight slice with a different ID', () => {
  const parent = entry({
    codexThreadId: 'one-parent',
    externalId: 'codex-midnight'
  });
  const aggregate = entry({
    id: 'aggregate',
    externalId: 'codex-aggregate',
    codexThreadId: 'one-parent',
    codexIsAggregate: true,
    startTime: '2026-09-01T07:00:00.000Z',
    duration: 3600
  });
  const separate = {
    ...parent,
    id: 'independent',
    externalId: 'codex-independent',
    codexThreadId: 'another-parent'
  };
  const result = reconcileCodexEntries([parent, aggregate, separate]);
  assert.deepEqual(result.entries, [aggregate, separate]);
  assert.deepEqual(result.retractedExternalIds, ['codex-midnight']);
  assert.equal(result.removed[0].reason, 'superseded');
});

test('guarded corrections retire an old alias without touching its replacement', () => {
  const old = entry({ id: 'legacy', externalId: 'codex-legacy-alias' });
  const replacement = entry({
    externalId: 'codex-aggregate',
    startTime: '2026-09-01T07:00:00.000Z',
    endTime: '2026-09-01T10:00:00.000Z',
    duration: 5400
  });
  const correction = {
    entryId: old.id,
    replacementEntryId: replacement.id,
    projectId: old.projectId,
    startTime: old.startTime,
    endTime: old.endTime,
    effectiveSeconds: old.duration,
    reason: 'superseded'
  };
  const result = reconcileCodexEntries([old, replacement], {
    corrections: [correction]
  });
  assert.deepEqual(result.entries, [replacement]);
  assert.deepEqual(result.retractedExternalIds, ['codex-legacy-alias']);
  const edited = { ...old, duration: 1234 };
  assert.equal(
    reconcileCodexEntries([edited, replacement], { corrections: [correction] })
      .removed.length,
    0
  );
  assert.equal(
    reconcileCodexEntries([old], { corrections: [correction] }).removed.length,
    0
  );
});

test('guarded duplicates do not retire an ID shared by the surviving entry', () => {
  const original = entry();
  const duplicate = entry({ id: 'duplicate' });
  const result = reconcileCodexEntries([original, duplicate], {
    corrections: [
      {
        entryId: duplicate.id,
        replacementEntryId: original.id,
        projectId: original.projectId,
        startTime: duplicate.startTime,
        endTime: duplicate.endTime,
        effectiveSeconds: duplicate.duration,
        reason: 'duplicate'
      }
    ]
  });
  assert.deepEqual(result.entries, [original]);
  assert.deepEqual(result.retractedExternalIds, []);
});

test('normalizes only Codex retractions and fully guarded correction rows', () => {
  assert.deepEqual(
    normalizeCodexRecordIds([
      ' codex-old ',
      'codex-old',
      'claude:abc',
      null,
      {}
    ]),
    ['codex-old']
  );
  assert.deepEqual(
    normalizeCodexCorrections([{ entryId: 'unguarded' }, null]),
    []
  );
});
