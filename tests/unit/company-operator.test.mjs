import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompanyOperatorCommand,
  companySnapshotFreshness,
  normalizeCompanyOperatorSettings,
  normalizeCompanyOperatorSnapshot
} from '../../src/features/company-operator/core.mjs';

test('normalizes a bounded mobile Company snapshot', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    generated_at: '2026-08-03T12:00:00.000Z',
    status: 'ready',
    state_version: 'state-1',
    today: {
      project: 'Avantor',
      title: 'IFLAI - AI cameras for PoU',
      next_action: 'Prepare the tiered commercial response.',
      done_when: 'Every tier and approval is explicit.'
    },
    priorities: [
      {
        issue_id: 'priority:avantor',
        evidence_fingerprint: 'evidence-1',
        project: 'Avantor',
        title: '<img src=x onerror=alert(1)>',
        priority_score: 88,
        next_action: 'Prepare pricing and total cost.'
      }
    ],
    work_products: {
      assets: [
        {
          asset_id: 'priority:avantor',
          title: 'Avantor workbook',
          format: 'commercial_response_workbook',
          content: '100 cameras\n500 cameras'
        }
      ]
    },
    decisions: {
      pending_count: 1,
      pending: [
        {
          approval_id: 'approval:pricing',
          decision_fingerprint: 'decision-evidence-1',
          title: 'Choose the pricing direction'
        }
      ]
    },
    handled: { today_verified_actions: 3, receipts: [] },
    sources: { status: 'ready', attention_count: 0, items: [] }
  });

  assert.equal(snapshot.today.project, 'Avantor');
  assert.equal(snapshot.priorities[0].issueId, 'priority:avantor');
  assert.equal(
    snapshot.workProducts.assets[0].format,
    'commercial_response_workbook'
  );
  assert.equal(
    snapshot.workProducts.assets[0].content,
    '100 cameras\n500 cameras'
  );
  assert.equal(snapshot.handled.todayVerifiedActions, 3);
  assert.equal(
    snapshot.decisions.pending[0].decisionFingerprint,
    'decision-evidence-1'
  );
  assert.equal(snapshot.priorities[0].title, '<img src=x onerror=alert(1)>');
});

test('builds an expiring allowlisted command without source content', () => {
  const command = buildCompanyOperatorCommand({
    commandId: 'mobile-command-001',
    action: 'work_next',
    snapshot: { stateVersion: 'state-1' },
    target: {
      issueId: 'priority:avantor',
      evidenceFingerprint: 'evidence-1'
    },
    params: { note: 'Focus on the pricing assumptions.' },
    now: new Date('2026-08-03T12:00:00.000Z')
  });

  assert.equal(command.source, 'timekeeper_mobile');
  assert.equal(command.action, 'work_next');
  assert.equal(command.target.issue_id, 'priority:avantor');
  assert.equal(command.params.note, 'Focus on the pricing assumptions.');
  assert.equal(command.expires_at, '2026-08-05T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(command), /email.body|slack.message/i);
  assert.throws(
    () =>
      buildCompanyOperatorCommand({
        commandId: 'mobile-command-002',
        action: 'run_arbitrary_code',
        snapshot: {}
      }),
    /not available/
  );

  const decision = buildCompanyOperatorCommand({
    commandId: 'mobile-decision-001',
    action: 'record_decision',
    snapshot: { stateVersion: 'state-1' },
    params: {
      approvalId: 'approval:pricing',
      decisionFingerprint: 'decision-evidence-1',
      decision: 'approve'
    },
    now: new Date('2026-08-03T12:00:00.000Z')
  });
  assert.equal(decision.params.decision_fingerprint, 'decision-evidence-1');
});

test('uses the dedicated private repository defaults and reports stale state', () => {
  const settings = normalizeCompanyOperatorSettings({});
  const freshness = companySnapshotFreshness(
    { generatedAt: '2026-08-03T08:00:00.000Z' },
    new Date('2026-08-03T12:00:00.000Z')
  );

  assert.equal(settings.repository, 'Henrik-KM/timekeeper-private-context');
  assert.equal(settings.statePath, 'company-operator/state.json');
  assert.equal(
    normalizeCompanyOperatorSettings({
      statePath: '../company-operator/./state.json'
    }).statePath,
    'company-operator/state.json'
  );
  assert.equal(freshness.status, 'stale');
  assert.equal(freshness.label, 'Updated 4 hours ago');
});
