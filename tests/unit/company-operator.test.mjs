import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompanyOperatorCommand,
  cleanLegacyResponsibilityCopy,
  companySnapshotFreshness,
  normalizeCompanyOperatorSettings,
  normalizeCompanyOperatorSnapshot
} from '../../src/features/company-operator/core.mjs';

test('repairs vague legacy responsibility copy without changing named people', () => {
  const legacy =
    'Assign one accountable Bioventurehub owner now. That owner should verify the external deadline and reconcile the invitation before any response.';

  assert.equal(
    cleanLegacyResponsibilityCopy(legacy),
    'Verify the external deadline and reconcile the invitation before any response.'
  );
  assert.equal(
    cleanLegacyResponsibilityCopy(
      'Mette owns the clinical review and will finish it on Friday.'
    ),
    'Mette owns the clinical review and will finish it on Friday.'
  );
});

test('drops empty legacy meeting cases and repairs substantive legacy priority copy', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    today: {
      project: 'AstraZeneca',
      title: 'AZ/IFLAI meeting',
      next_action:
        'Turn AZ/IFLAI meeting into a verified delivery decision: result, open technical question, commercial implication, and target date.'
    },
    priorities: [
      {
        issue_id: 'priority:az-empty',
        project: 'AstraZeneca',
        title: 'AZ/IFLAI meeting',
        next_action:
          'Turn AZ/IFLAI meeting into a verified delivery decision: result, open technical question, commercial implication, and target date.'
      },
      {
        issue_id: 'priority:zoom-provider',
        project: 'Zoom',
        title: 'Meeting assets for Discussion on publication are ready!',
        next_action: 'Review the meeting assets.'
      },
      {
        issue_id: 'priority:magik',
        project: 'MAGIK',
        title: 'Promising PoC results',
        next_action:
          'Turn Promising PoC results into a verified delivery decision: result, open technical question, commercial implication, and target date.',
        done_when:
          'MAGIK has a decision-ready result summary, resolved technical next step, and target date.'
      }
    ]
  });

  assert.equal(snapshot.today.title, '');
  assert.deepEqual(
    snapshot.priorities.map((item) => item.title),
    ['Promising PoC results']
  );
  assert.match(snapshot.priorities[0].nextAction, /Record what happened/);
  assert.equal(
    snapshot.priorities[0].doneWhen,
    'The latest customer outcome, remaining technical questions, and specific next deliverable are recorded.'
  );
});

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
    email_drafting: {
      status: 'improving',
      needs_user: false,
      summary:
        '2 drafts are ready in Outlook. 3 older drafts are being refreshed.',
      ready_in_outlook: 2,
      being_refreshed: 3,
      waiting_for_safe_context: 1,
      unsafe_or_duplicate: 1,
      verification_failures: 0,
      verification_auto_recovered: 1,
      tracked_sent_count: 8,
      usable_rate: 0.75,
      target_usable_rate: 0.75,
      target_status: 'collecting_baseline',
      authoring_success_rate: 0.9,
      median_authoring_seconds: 42.5,
      draft_types: { replies: 1, followups: 1, first_contacts: 2 },
      outlook_url: 'https://outlook.office.com/mail/drafts'
    },
    opportunities: {
      available: true,
      status: 'ready',
      summary: '1 verified first-contact draft is ready in Outlook.',
      generated_at: '2026-08-03T11:45:00.000Z',
      source_count: 6,
      relationship_count: 2,
      counts: {
        found: 4,
        qualified: 1,
        ready_for_draft: 0,
        drafted: 1,
        contact_missing: 1
      },
      cards: [
        {
          opportunity_id: 'opportunity:imaging-partner',
          evidence_fingerprint: 'opportunity-evidence-1',
          company: 'Imaging Partner',
          contact_label: 'Partnerships team',
          lane: 'net_new',
          motion: 'oem_or_distribution',
          status: 'drafted',
          status_label: 'Draft ready in Outlook',
          why_now: [
            'The company has launched a new imaging platform.',
            'It publishes an OEM partnership route.'
          ],
          action_taken: 'Prepared and verified a first-contact draft.',
          score: 91,
          confidence: 'high',
          source_freshness: 'Today',
          outlook_url: 'https://outlook.office.com/mail/drafts/id-1'
        }
      ],
      useful_rate: 0.67,
      sample_size: 6,
      outlook_url: 'https://outlook.office.com/mail/drafts'
    },
    dispatches: {
      in_progress_count: 1,
      in_progress: [
        {
          command_id: 'mobile-company-001',
          issue_id: 'priority:avantor',
          project: 'Avantor',
          status: 'processing'
        }
      ],
      recent: [
        {
          dispatch_id: 'dispatch:mobile-company-000',
          command_id: 'mobile-company-000',
          issue_id: 'priority:older',
          project: 'Albany',
          status: 'verified',
          outcome_status: 'needs_decision',
          requires_decision: true,
          recommended_next_action: 'Choose whether to proceed.',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'max',
          model_routing_tier: 'frontier',
          execution_repo: 'email-helper',
          execution_branch: 'codex/company-operator',
          execution_branch_pending_commit_count: 2,
          duration_seconds: 125,
          result: {
            status: 'needs_decision',
            headline: 'Prepared the supported decision brief.',
            completed_work: ['Reviewed the evidence.', 'Prepared the brief.'],
            next_action: 'Choose whether to proceed.',
            destinations: [
              {
                type: 'internal_brief',
                mode: 'preview',
                label: 'Decision brief',
                location: 'Private Company brief',
                preview_content: '# Decision brief\n\n- Assign an owner.',
                bytes: 41,
                sha256: 'a'.repeat(64),
                verified: true
              },
              {
                type: 'github_change',
                mode: 'open',
                label: 'Implementation',
                url: 'https://github.com/Henrik-KM/TimeKeeper/commit/abc',
                verified: true
              },
              {
                type: 'private_file',
                mode: 'download',
                label: 'Supporting notes',
                download_content: 'Private supporting notes',
                filename: 'supporting-notes.md',
                mime_type: 'text/markdown;charset=utf-8',
                sha256: 'b'.repeat(64),
                verified: true
              },
              {
                type: 'outlook_draft',
                mode: 'open',
                label: 'Fake draft',
                url: 'https://example.com/not-outlook',
                verified: true
              }
            ]
          },
          time_tracking_status: 'session_persisted'
        }
      ]
    },
    sources: { status: 'ready', attention_count: 0, items: [] }
  });

  assert.equal(snapshot.today.project, 'Avantor');
  assert.equal(
    snapshot.dispatches.recent[0].executionBranch,
    'codex/company-operator'
  );
  assert.equal(
    snapshot.dispatches.recent[0].executionBranchPendingCommitCount,
    2
  );
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
  assert.equal(snapshot.emailDrafting.readyInOutlook, 2);
  assert.equal(snapshot.emailDrafting.beingRefreshed, 3);
  assert.equal(snapshot.emailDrafting.waitingForSafeContext, 1);
  assert.equal(snapshot.emailDrafting.usableRate, 0.75);
  assert.deepEqual(snapshot.emailDrafting.draftTypes, {
    replies: 1,
    followups: 1,
    firstContacts: 2
  });
  assert.equal(
    snapshot.emailDrafting.outlookUrl,
    'https://outlook.office.com/mail/drafts'
  );
  assert.equal(snapshot.dispatches.inProgressCount, 1);
  assert.equal(snapshot.opportunities.cards.length, 1);
  assert.equal(
    snapshot.opportunities.cards[0].opportunityId,
    'opportunity:imaging-partner'
  );
  assert.deepEqual(snapshot.opportunities.cards[0].whyNow, [
    'The company has launched a new imaging platform.',
    'It publishes an OEM partnership route.'
  ]);
  assert.equal(snapshot.dispatches.inProgress[0].issueId, 'priority:avantor');
  assert.equal(snapshot.dispatches.recent[0].model, 'gpt-5.6-sol');
  assert.equal(snapshot.dispatches.recent[0].durationSeconds, 125);
  assert.equal(snapshot.dispatches.recent[0].modelRoutingTier, 'frontier');
  assert.equal(snapshot.dispatches.recent[0].requiresDecision, true);
  assert.equal(snapshot.dispatches.recent[0].result.status, 'needs_decision');
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[0].previewContent,
    '# Decision brief\n\n- Assign an owner.'
  );
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[0].actionLabel,
    'View full output'
  );
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[0].location,
    'Available here in the app'
  );
  assert.deepEqual(
    snapshot.dispatches.recent[0].result.destinations.map((item) => item.type),
    ['internal_brief', 'github_change', 'private_file']
  );
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[1].actionLabel,
    'View changes'
  );
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[2].downloadContent,
    'Private supporting notes'
  );
  assert.equal(
    snapshot.dispatches.recent[0].recommendedNextAction,
    'Choose whether to proceed.'
  );
  assert.equal(
    snapshot.decisions.pending[0].decisionFingerprint,
    'decision-evidence-1'
  );
  assert.equal(snapshot.priorities[0].title, '<img src=x onerror=alert(1)>');
});

test('normalizes persistent missions, questions, progress, and verified outputs', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    missions: {
      status: 'ready',
      active_count: 2,
      waiting_count: 1,
      completed_today_count: 1,
      budget: {
        automatic_steps_today: 3,
        automatic_minutes_today: 24,
        steps_remaining: 3,
        minutes_remaining: 66
      },
      primary: {
        mission_id: 'mission:avantor',
        issue_id: 'priority:avantor',
        evidence_fingerprint: 'evidence-1',
        project: 'Avantor',
        objective: 'Finish the camera delivery package.',
        done_when: 'The tested package is available in a local commit.',
        status: 'active',
        step_count: 2,
        latest_update: 'Implemented the validated configuration.',
        current_step: {
          title: 'Run the final validation',
          status: 'running'
        }
      },
      active: [
        {
          mission_id: 'mission:avantor',
          issue_id: 'priority:avantor',
          evidence_fingerprint: 'evidence-1',
          project: 'Avantor',
          objective: 'Finish the camera delivery package.',
          status: 'active'
        },
        {
          mission_id: 'mission:albany',
          issue_id: 'priority:albany',
          evidence_fingerprint: 'evidence-2',
          project: 'Albany',
          objective: 'Confirm the delivery route.',
          status: 'waiting_for_decision',
          user_request: {
            dispatch_id: 'dispatch:albany',
            instruction: 'Choose direct delivery or partner delivery.',
            choices: [
              {
                id: 'direct',
                label: 'Direct',
                kind: 'decision',
                fields: []
              }
            ]
          }
        }
      ],
      completed_today: [
        {
          mission_id: 'mission:done',
          issue_id: 'priority:done',
          evidence_fingerprint: 'evidence-3',
          project: 'Aventix',
          objective: 'Repair the data export.',
          status: 'completed',
          destinations: [
            {
              type: 'local_commit',
              mode: 'none',
              label: 'Aventix local commit',
              reference: 'abc123',
              location: 'Aventix',
              verified: true
            }
          ]
        }
      ]
    }
  });

  assert.equal(snapshot.missions.activeCount, 2);
  assert.equal(snapshot.missions.primary.currentStep.status, 'running');
  assert.equal(snapshot.missions.primary.stepCount, 2);
  assert.equal(
    snapshot.missions.active[1].userRequest.dispatchId,
    'dispatch:albany'
  );
  assert.equal(
    snapshot.missions.active[1].userRequest.choices[0].label,
    'Direct'
  );
  assert.equal(
    snapshot.missions.completedToday[0].destinations[0].type,
    'local_commit'
  );
  assert.equal(snapshot.missions.budget.stepsRemaining, 3);
});

test('normalizes concise action-first company results', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    dispatches: {
      recent: [
        {
          dispatch_id: 'dispatch:done',
          command_id: 'mobile-done',
          issue_id: 'priority:aventix',
          evidence_fingerprint: 'evidence-aventix-1',
          project: 'Aventix',
          status: 'verified',
          outcome_status: 'done',
          result: {
            status: 'done',
            headline: 'Fixed the validation bug',
            message: 'The fix is tested and committed locally.',
            completed_work: ['Updated validation.'],
            destinations: [
              {
                type: 'local_commit',
                mode: 'none',
                label: 'Aventix local commit',
                location: 'Aventix',
                reference: 'abcdef123456',
                status_text: 'Committed locally and not pushed.',
                verified: true
              }
            ],
            user_request: { instruction: '', reason: '', choices: [] },
            verification: {
              proof_kind: 'local_commit',
              reference: 'abcdef123456',
              summary: 'Focused tests passed.'
            }
          }
        },
        {
          dispatch_id: 'dispatch:question',
          command_id: 'mobile-question',
          issue_id: 'priority:magik',
          evidence_fingerprint: 'evidence-magik-1',
          project: 'MAGIK',
          status: 'verified',
          outcome_status: 'needs_you',
          requires_decision: true,
          result: {
            status: 'needs_you',
            headline: 'Choose the pilot deadline',
            message: 'The implementation depends on the customer deadline.',
            destinations: [],
            user_request: {
              instruction: 'Which deadline should I use?',
              reason: 'No deadline is in the available sources.',
              choices: [
                {
                  id: 'provide_deadline',
                  label: 'Provide deadline',
                  kind: 'details',
                  fields: [
                    {
                      id: 'pilot_deadline',
                      label: 'Pilot deadline',
                      type: 'date',
                      required: true,
                      placeholder: '',
                      options: []
                    }
                  ]
                }
              ]
            }
          }
        }
      ]
    }
  });

  const [done, question] = snapshot.dispatches.recent;
  assert.equal(done.evidenceFingerprint, 'evidence-aventix-1');
  assert.equal(done.result.message, 'The fix is tested and committed locally.');
  assert.equal(done.result.destinations[0].type, 'local_commit');
  assert.equal(done.result.destinations[0].reference, 'abcdef123456');
  assert.equal(done.result.destinations[0].previewContent, '');
  assert.equal(
    question.result.userRequest.instruction,
    'Which deadline should I use?'
  );
  assert.deepEqual(question.result.userRequest.choices, [
    {
      id: 'provide_deadline',
      label: 'Provide deadline',
      kind: 'details',
      fields: [
        {
          id: 'pilot_deadline',
          label: 'Pilot deadline',
          type: 'date',
          required: true,
          placeholder: '',
          options: []
        }
      ]
    }
  ]);
});

test('legacy dispatches preview only explicitly classified briefs', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    dispatches: {
      recent: [
        {
          dispatch_id: 'dispatch:legacy-result',
          status: 'verified',
          deliverables: [
            {
              label: 'Decision brief',
              kind: 'decision_brief',
              content: 'Preview this brief.',
              sha256: 'a'.repeat(64),
              verified: true
            },
            {
              label: 'Generic output',
              kind: 'markdown',
              content: 'Do not preview every Markdown file.',
              sha256: 'b'.repeat(64),
              verified: true
            }
          ]
        }
      ]
    }
  });

  assert.equal(snapshot.dispatches.recent[0].result.destinations.length, 1);
  assert.equal(
    snapshot.dispatches.recent[0].result.destinations[0].type,
    'internal_brief'
  );
});

test('does not present a thin evidence wrapper as completed work', () => {
  const snapshot = normalizeCompanyOperatorSnapshot({
    schema_version: 1,
    dispatches: {
      recent: [
        {
          dispatch_id: 'dispatch:unusable-aventix-result',
          project: 'Aventix',
          status: 'verified',
          outcome_status: 'completed',
          summary: 'Completed an evidence-bound Aventix decision brief.',
          recommended_next_action:
            'Provide a summary for commitment:282fd75ae731ee2876495959:3198242ea5e1.',
          result: {
            status: 'completed',
            headline: 'Completed an evidence-bound Aventix decision brief.',
            completed_work: [
              'Separated unknown technical and commercial details.'
            ],
            next_action:
              'Provide a summary for commitment:282fd75ae731ee2876495959:3198242ea5e1.',
            destinations: [
              {
                type: 'internal_brief',
                mode: 'preview',
                label: 'Aventix brief',
                preview_content: 'No usable deliverable was prepared.',
                sha256: 'a'.repeat(64),
                verified: true
              }
            ]
          }
        }
      ]
    }
  });

  const dispatch = snapshot.dispatches.recent[0];
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.result.status, 'failed');
  assert.match(
    dispatch.result.headline,
    /did not produce a usable deliverable/
  );
  assert.deepEqual(dispatch.result.completedWork, []);
  assert.deepEqual(dispatch.result.destinations, []);
  assert.equal(dispatch.result.nextAction, '');
  assert.doesNotMatch(JSON.stringify(dispatch), /282fd75/);
});

test('builds an expiring allowlisted command without source content', () => {
  const command = buildCompanyOperatorCommand({
    commandId: 'mobile-command-001',
    action: 'work_next',
    snapshot: { stateVersion: 'state-1' },
    target: {
      issueId: 'priority:avantor',
      evidenceFingerprint: 'evidence-1',
      missionId: 'mission:avantor'
    },
    params: { note: 'Focus on the pricing assumptions.' },
    now: new Date('2026-08-03T12:00:00.000Z')
  });

  assert.equal(command.source, 'timekeeper_mobile');
  assert.equal(command.action, 'work_next');
  assert.equal(command.target.issue_id, 'priority:avantor');
  assert.equal(command.target.mission_id, 'mission:avantor');
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

  const answer = buildCompanyOperatorCommand({
    commandId: 'mobile-answer-001',
    action: 'add_direction',
    snapshot: { stateVersion: 'state-1' },
    target: {
      issueId: 'priority:magik',
      evidenceFingerprint: 'evidence-magik-1'
    },
    params: {
      dispatchId: 'dispatch:magik-question',
      optionId: 'both_facts',
      answers: [
        { fieldId: 'measured_result', value: 'Tracking passed at 30 fps.' },
        {
          fieldId: 'customer_response',
          value: 'AstraZeneca asked for the next test.'
        }
      ]
    },
    now: new Date('2026-08-03T12:00:00.000Z')
  });
  assert.equal(answer.params.dispatch_id, 'dispatch:magik-question');
  assert.equal(answer.params.option_id, 'both_facts');
  assert.deepEqual(answer.params.answers, [
    { field_id: 'measured_result', value: 'Tracking passed at 30 fps.' },
    {
      field_id: 'customer_response',
      value: 'AstraZeneca asked for the next test.'
    }
  ]);

  const feedback = buildCompanyOperatorCommand({
    commandId: 'mobile-feedback-001',
    action: 'rate_result',
    snapshot: { stateVersion: 'state-1' },
    params: {
      dispatchId: 'dispatch:done',
      rating: 'wrong_priority',
      note: 'Focus on customer delivery.'
    },
    now: new Date('2026-08-03T12:00:00.000Z')
  });
  assert.equal(feedback.params.rating, 'wrong_priority');
  assert.equal(feedback.params.dispatch_id, 'dispatch:done');

  const opportunityFeedback = buildCompanyOperatorCommand({
    commandId: 'mobile-opportunity-feedback-001',
    action: 'rate_opportunity',
    snapshot: { stateVersion: 'state-1' },
    target: {
      opportunityId: 'opportunity:imaging-partner',
      evidenceFingerprint: 'opportunity-evidence-1'
    },
    params: { rating: 'useful', note: '' },
    now: new Date('2026-08-03T12:00:00.000Z')
  });
  assert.equal(
    opportunityFeedback.target.opportunity_id,
    'opportunity:imaging-partner'
  );
  assert.equal(
    opportunityFeedback.target.evidence_fingerprint,
    'opportunity-evidence-1'
  );
  assert.equal(opportunityFeedback.params.rating, 'useful');
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
