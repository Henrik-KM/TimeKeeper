import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CODEX_FOCUS_POLICY } from '../../src/features/codex/policy.mjs';
import {
  migrateCodexEntries,
  revalueCodexEntry
} from '../../src/features/codex/revaluation.mjs';

const POLICY = {
  ...DEFAULT_CODEX_FOCUS_POLICY,
  repositoryMultipliers: { research: 0.5 }
};

function historicalEntry(overrides = {}) {
  return {
    id: 'entry-id',
    projectId: 'project-id',
    source: 'codex',
    externalId: 'codex-historical',
    description: 'Codex: historical work',
    startTime: '2026-06-01T08:00:00.000Z',
    endTime: '2026-06-01T09:00:00.000Z',
    elapsedSeconds: 3600,
    duration: 2160,
    focusFactor: 0.6,
    manualFactor: 0.6,
    codexFocusPolicyVersion: 5,
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-sol',
        effort: 'ultra',
        fastMode: false,
        wallSeconds: 3600,
        factor: 0.6,
        creditedFactor: 0.6,
        effectiveSeconds: 2160
      }
    ],
    ...overrides
  };
}

test('revalues existing v5 model rows under policy v7', () => {
  const sol = historicalEntry();
  const luna = historicalEntry({
    id: 'luna-entry',
    externalId: 'codex-luna-historical',
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-luna',
        effort: 'low',
        factor: 0.2,
        wallSeconds: 3600,
        effectiveSeconds: 720
      }
    ],
    duration: 720,
    focusFactor: 0.2,
    manualFactor: 0.2
  });

  const result = migrateCodexEntries([sol, luna], POLICY);

  assert.equal(result.report.updated, 2);
  assert.equal(result.report.unable, 0);
  assert.equal(result.entries[0].id, 'entry-id');
  assert.equal(result.entries[0].externalId, 'codex-historical');
  assert.equal(result.entries[0].duration, 1800);
  assert.equal(result.entries[0].focusFactor, 0.5);
  assert.equal(result.entries[0].manualFactor, 0.5);
  assert.equal(result.entries[0].codexFocusPolicyVersion, 7);
  assert.equal(result.entries[0].codexModelBreakdown[0].effort, 'ultra');
  assert.equal(result.entries[0].codexModelBreakdown[0].baseFactor, 0.5);
  assert.equal(result.entries[0].codexModelBreakdown[0].factor, 0.5);
  assert.equal(result.entries[0].codexModelBreakdown[0].creditMultiplier, 1);
  assert.equal(result.entries[0].codexModelBreakdown[0].creditedFactor, 0.5);
  assert.equal(result.entries[0].codexModelBreakdown[0].effectiveSeconds, 1800);
  assert.equal(result.entries[1].duration, 1080);
  assert.equal(result.entries[1].focusFactor, 0.3);
  assert.equal(result.entries[1].codexModelBreakdown[0].effort, 'low');
  assert.equal(result.entries[1].codexModelBreakdown[0].factor, 0.3);
  assert.equal(result.entries[1].codexModelBreakdown[0].effectiveSeconds, 1080);
});

test('revalues historical Astra rows to the 0.75 base factor', () => {
  const entry = historicalEntry({
    id: 'astra-entry',
    externalId: 'codex-astra-historical',
    duration: 1440,
    focusFactor: 0.4,
    manualFactor: 0.4,
    codexModelBreakdown: [
      {
        model: 'gpt-6-astra',
        effort: 'ultra',
        fastMode: false,
        wallSeconds: 3600,
        factor: 0.4,
        effectiveSeconds: 1440
      }
    ]
  });

  const migrated = migrateCodexEntries([entry], POLICY).entries[0];
  assert.equal(migrated.id, 'astra-entry');
  assert.equal(migrated.externalId, 'codex-astra-historical');
  assert.equal(migrated.duration, 2700);
  assert.equal(migrated.focusFactor, 0.75);
  assert.equal(migrated.manualFactor, 0.75);
  assert.equal(migrated.codexFocusPolicyVersion, 7);
  assert.equal(migrated.codexModelBreakdown[0].baseFactor, 0.75);
  assert.equal(migrated.codexModelBreakdown[0].factor, 0.75);
  assert.equal(migrated.codexModelBreakdown[0].effectiveSeconds, 2700);
});

test('keeps reasoning labels while ignoring them for credited time', () => {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const entries = efforts.map((effort) =>
    historicalEntry({
      id: `entry-${effort}`,
      externalId: `codex-${effort}`,
      codexModelBreakdown: [
        {
          model: 'gpt-5.6-sol',
          effort,
          wallSeconds: 3600,
          effectiveSeconds: 1,
          factor: 0.01
        }
      ]
    })
  );
  const result = migrateCodexEntries(entries, POLICY);

  assert.deepEqual(
    result.entries.map((entry) => entry.codexModelBreakdown[0].effort),
    efforts
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.codexModelBreakdown[0].factor),
    efforts.map(() => 0.5)
  );
});

test('applies Fast, Research, and delegation modifiers once', () => {
  const fastResearch = historicalEntry({
    id: 'fast-research',
    externalId: 'codex-fast-research',
    codexRepoName: 'Research',
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-sol',
        effort: 'max',
        fastMode: true,
        wallSeconds: 600,
        factor: 0.3,
        repositoryMultiplier: 0.5,
        effectiveSeconds: 180
      }
    ],
    elapsedSeconds: 600,
    duration: 180,
    focusFactor: 0.3,
    manualFactor: 0.3
  });
  const result = migrateCodexEntries([fastResearch], POLICY).entries[0];
  const row = result.codexModelBreakdown[0];
  assert.equal(row.baseFactor, 0.6);
  assert.equal(row.factor, 0.3);
  assert.equal(row.repositoryMultiplier, 0.5);
  assert.equal(row.creditMultiplier, 1);
  assert.equal(row.creditedFactor, 0.3);
  assert.equal(row.effectiveSeconds, 180);
  assert.equal(result.duration, 180);

  const delegated = historicalEntry({
    id: 'delegated',
    externalId: 'codex-delegated',
    codexModelBreakdown: [
      {
        role: 'subagent',
        model: 'gpt-5.6-sol',
        effort: 'low',
        wallSeconds: 600,
        factor: 0.6,
        creditedFactor: 0.21,
        effectiveSeconds: 126
      }
    ],
    duration: 126,
    focusFactor: 0.21,
    manualFactor: 0.21
  });
  const delegatedResult = migrateCodexEntries([delegated], POLICY).entries[0];
  assert.equal(delegatedResult.codexModelBreakdown[0].factor, 0.5);
  assert.equal(delegatedResult.codexModelBreakdown[0].creditMultiplier, 0.35);
  assert.equal(delegatedResult.codexModelBreakdown[0].creditedFactor, 0.175);
  assert.equal(delegatedResult.codexModelBreakdown[0].effectiveSeconds, 105);
});

test('normalizes legacy rows and uses the explicit unknown fallback', () => {
  const legacy = historicalEntry({
    id: 'legacy',
    externalId: 'codex-legacy',
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-luna',
        effort: 'low',
        wallSeconds: 600,
        effectiveSeconds: 120
      }
    ],
    elapsedSeconds: 600,
    duration: 120,
    focusFactor: 0.2,
    manualFactor: 0.2
  });
  const unknown = {
    id: 'unknown',
    source: 'codex',
    externalId: 'codex-unknown',
    startTime: '2026-06-01T08:00:00.000Z',
    endTime: '2026-06-01T08:10:00.000Z',
    elapsedSeconds: 600,
    duration: 120,
    focusFactor: 0.2,
    codexFocusPolicyVersion: 5
  };

  const result = migrateCodexEntries([legacy, unknown], POLICY);
  const legacyRow = result.entries[0].codexModelBreakdown[0];
  const unknownRow = result.entries[1].codexModelBreakdown[0];
  assert.equal(legacyRow.role, 'parent');
  assert.equal(legacyRow.fastMode, false);
  assert.equal(legacyRow.creditMultiplier, 1);
  assert.equal(legacyRow.factor, 0.3);
  assert.equal(legacyRow.effectiveSeconds, 180);
  assert.equal(unknownRow.model, 'unknown');
  assert.equal(unknownRow.factor, 0.4);
  assert.equal(unknownRow.effectiveSeconds, 240);
  assert.equal(result.entries[1].duration, 240);
});

test('recovers missing elapsed time from timestamps without changing them', () => {
  const entry = historicalEntry({
    id: 'missing-elapsed',
    externalId: 'codex-missing-elapsed',
    elapsedSeconds: undefined,
    startTime: '2026-05-01T08:00:00.000Z',
    endTime: '2026-05-01T08:07:00.000Z',
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-terra',
        effort: 'medium',
        wallSeconds: 420,
        effectiveSeconds: 1
      }
    ]
  });
  const result = migrateCodexEntries([entry], POLICY).entries[0];
  assert.equal(result.elapsedSeconds, 420);
  assert.equal(result.duration, 168);
  assert.equal(result.focusFactor, 0.4);
  assert.equal(result.startTime, entry.startTime);
  assert.equal(result.endTime, entry.endTime);
  assert.equal(result.id, entry.id);
  assert.equal(result.externalId, entry.externalId);
});

test('does not apply the Research multiplier twice', () => {
  const entry = historicalEntry({
    id: 'research',
    externalId: 'codex-research',
    codexRepoName: 'Research',
    duration: 1080,
    focusFactor: 0.3,
    manualFactor: 0.3,
    codexModelBreakdown: [
      {
        model: 'gpt-5.6-sol',
        effort: 'ultra',
        fastMode: false,
        baseFactor: 0.6,
        factor: 0.3,
        repositoryMultiplier: 0.5,
        creditedFactor: 0.3,
        wallSeconds: 3600,
        effectiveSeconds: 1080
      }
    ]
  });
  const migrated = migrateCodexEntries([entry], POLICY).entries[0];
  assert.equal(migrated.codexModelBreakdown[0].baseFactor, 0.5);
  assert.equal(migrated.codexModelBreakdown[0].factor, 0.25);
  assert.equal(migrated.codexModelBreakdown[0].creditedFactor, 0.25);
  assert.equal(migrated.codexModelBreakdown[0].effectiveSeconds, 900);
  assert.equal(migrated.duration, 900);
  assert.equal(migrated.focusFactor, 0.25);
});

test('is idempotent and leaves manual entries unchanged', () => {
  const manual = {
    id: 'manual',
    source: 'manual',
    description: 'Normal work',
    duration: 3600,
    focusFactor: 1,
    arbitrary: { keep: true }
  };
  const codex = historicalEntry();
  const first = migrateCodexEntries([manual, codex], POLICY);
  const second = migrateCodexEntries(first.entries, POLICY);

  assert.equal(first.report.updated, 1);
  assert.equal(second.report.updated, 0);
  assert.equal(second.report.unable, 0);
  assert.deepEqual(second.entries, first.entries);
  assert.deepEqual(first.entries[0], manual);
  assert.equal(first.entries[1].id, codex.id);
  assert.equal(first.entries[1].externalId, codex.externalId);
});

test('reports entries that cannot be revalued without changing them', () => {
  const entry = historicalEntry({
    codexModelBreakdown: [
      { model: 'gpt-5.6-sol', effort: 'high' },
      { model: 'gpt-5.6-luna', effort: 'low' }
    ]
  });
  const result = migrateCodexEntries([entry], POLICY);
  assert.equal(result.report.updated, 0);
  assert.equal(result.report.unable, 1);
  assert.deepEqual(result.entries[0], entry);
  assert.equal(revalueCodexEntry(entry, POLICY).status, 'unable');
});
