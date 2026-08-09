export const COMPANY_OPERATOR_SCHEMA_VERSION = 1;

export const DEFAULT_COMPANY_OPERATOR_SETTINGS = Object.freeze({
  repository: 'Henrik-KM/timekeeper-private-context',
  branch: 'main',
  statePath: 'company-operator/state.json',
  commandsPath: 'company-operator/commands',
  receiptsPath: 'company-operator/receipts'
});

const ALLOWED_ACTIONS = new Set([
  'add_direction',
  'mark_handled',
  'rate_result',
  'record_decision',
  'set_priority',
  'snooze',
  'work_next'
]);
const RESULT_DESTINATION_TYPES = new Set([
  'closed_state',
  'github_change',
  'internal_brief',
  'local_commit',
  'onedrive_document',
  'outlook_draft',
  'private_file',
  'sharepoint_document',
  'updated_file',
  'website'
]);
const LEGACY_PREVIEW_KINDS = new Set([
  'decision_brief',
  'executive_brief',
  'internal_brief',
  'meeting_brief'
]);
const INTERNAL_CITATION_PATTERN =
  /\b(?:commitment|decision|doc|email|outlook|project|slack|zoom):[A-Za-z0-9_-]{12,}/;

export function normalizeCompanyOperatorSettings(value = {}) {
  const source = asRecord(value);
  return {
    repository:
      normalizeRepository(source.repository) ||
      DEFAULT_COMPANY_OPERATOR_SETTINGS.repository,
    branch:
      cleanText(source.branch, 120) || DEFAULT_COMPANY_OPERATOR_SETTINGS.branch,
    statePath: normalizePath(
      source.statePath,
      DEFAULT_COMPANY_OPERATOR_SETTINGS.statePath
    ),
    commandsPath: normalizePath(
      source.commandsPath,
      DEFAULT_COMPANY_OPERATOR_SETTINGS.commandsPath
    ),
    receiptsPath: normalizePath(
      source.receiptsPath,
      DEFAULT_COMPANY_OPERATOR_SETTINGS.receiptsPath
    )
  };
}

export function normalizeCompanyOperatorSnapshot(value = {}) {
  const source = asRecord(value);
  if (
    Number(source.schema_version ?? source.schemaVersion) !==
    COMPANY_OPERATOR_SCHEMA_VERSION
  ) {
    return null;
  }
  const priorities = normalizeArray(source.priorities, normalizePriority, 8);
  const workProducts = asRecord(source.work_products || source.workProducts);
  const decisions = asRecord(source.decisions);
  const handled = asRecord(source.handled);
  const dispatches = asRecord(source.dispatches);
  const sources = asRecord(source.sources);
  return {
    schemaVersion: COMPANY_OPERATOR_SCHEMA_VERSION,
    generatedAt: cleanText(source.generated_at || source.generatedAt, 80),
    status: cleanText(source.status, 80) || 'unknown',
    stateVersion: cleanText(source.state_version || source.stateVersion, 128),
    today: normalizeToday(source.today),
    priorities,
    workProducts: {
      status: cleanText(workProducts.status, 80),
      title: cleanText(workProducts.title, 180),
      summary: cleanText(workProducts.summary, 600),
      assets: normalizeArray(workProducts.assets, normalizeAsset, 5)
    },
    decisions: {
      pendingCount: toCount(decisions.pending_count ?? decisions.pendingCount),
      deferredCount: toCount(
        decisions.deferred_count ?? decisions.deferredCount
      ),
      pending: normalizeArray(decisions.pending, normalizeDecision, 12)
    },
    handled: {
      todayVerifiedActions: toCount(
        handled.today_verified_actions ?? handled.todayVerifiedActions
      ),
      todayEstimatedMinutesSaved: toCount(
        handled.today_estimated_minutes_saved ??
          handled.todayEstimatedMinutesSaved
      ),
      receipts: normalizeArray(handled.receipts, normalizeReceipt, 10)
    },
    dispatches: {
      inProgressCount: toCount(
        dispatches.in_progress_count ?? dispatches.inProgressCount
      ),
      inProgress: normalizeArray(
        dispatches.in_progress || dispatches.inProgress,
        normalizeDispatch,
        8
      ),
      recent: normalizeArray(dispatches.recent, normalizeDispatch, 8)
    },
    sources: {
      status: cleanText(sources.status, 80),
      attentionCount: toCount(
        sources.attention_count ?? sources.attentionCount
      ),
      items: normalizeArray(sources.items, normalizeSource, 12)
    }
  };
}

export function cleanLegacyResponsibilityCopy(value, limit = 500) {
  let text = cleanText(value, limit);
  if (!text) return '';
  const startsUppercase = /^[A-Z]/.test(text);
  const assignment =
    /^Assign (?:one|an) accountable [^.]{1,160}? owner now\.\s*That owner should\s+(.+)$/i.exec(
      text
    );
  if (assignment) {
    const action = assignment[1].trim();
    return action ? `${action.charAt(0).toUpperCase()}${action.slice(1)}` : '';
  }
  if (text.toLowerCase() === 'assign an owner.') {
    return 'Confirm the remaining human-only step.';
  }
  const vagueDelivery =
    /^Turn (.+) into a verified delivery decision: result, open technical question, commercial implication, and target date\.$/i.exec(
      text
    );
  if (vagueDelivery) {
    return `Review the latest cited customer record for ${vagueDelivery[1].trim()}. Record what happened, what the customer asked for, and what IFLAI must produce next, then prepare that deliverable.`;
  }
  if (
    /^.+ has a decision-ready result summary, resolved technical next step, and target date\.$/i.test(
      text
    )
  ) {
    return 'The latest customer outcome, remaining technical questions, and specific next deliverable are recorded.';
  }
  const replacements = [
    [
      'a verified owner, next action, and target date',
      'a verified next action and target date'
    ],
    [
      'the next action, owner, and date are verified',
      'the next action and date are verified'
    ],
    [
      'result, open technical question, commercial implication, owner, and date',
      'result, open technical question, commercial implication, and target date'
    ],
    [
      'named business outcome, owner, and date',
      'named business outcome and target date'
    ],
    [
      'resolved technical next step, accountable owner, and target date',
      'resolved technical next step and target date'
    ],
    [
      'requirements, deadline, owner, and complete internal',
      'requirements, deadline, and complete internal'
    ],
    [
      'named business objective, owner, evidence standard, and target date',
      'named business objective, evidence standard, and target date'
    ],
    ['the evidence, owner, and date', 'the evidence and target date'],
    [
      'an owner decision is still required',
      "Henrik's responsibility decision is still required"
    ],
    [
      'the resulting next action has a verified owner and date',
      'the resulting next action and target date are verified'
    ],
    [
      'Who owns the resulting action and what is the next real date?',
      'What is the resulting action and its next real date?'
    ],
    [
      'Who owns the next action and by when?',
      'What is the next action and target date?'
    ],
    [
      'together with the evidence, owner, and next date',
      'together with the evidence and next date'
    ],
    ['one owned next step', 'one verified next step']
  ];
  replacements.forEach(([oldText, newText]) => {
    text = text.replace(new RegExp(escapeRegExp(oldText), 'gi'), newText);
  });
  if (startsUppercase && text) {
    text = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }
  return text;
}

export function buildCompanyOperatorCommand({
  commandId,
  action,
  snapshot,
  target = {},
  params = {},
  now = new Date()
}) {
  const normalizedAction = cleanText(action, 80);
  const normalizedId = cleanText(commandId, 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(normalizedId)) {
    throw new Error('A valid command ID is required.');
  }
  if (!ALLOWED_ACTIONS.has(normalizedAction)) {
    throw new Error('That Company action is not available.');
  }
  const issuedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error('A valid command time is required.');
  }
  const targetSource = asRecord(target);
  const paramsSource = asRecord(params);
  const payload = {
    schema_version: COMPANY_OPERATOR_SCHEMA_VERSION,
    command_id: normalizedId,
    source: 'timekeeper_mobile',
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(
      issuedAt.getTime() + 48 * 60 * 60 * 1000
    ).toISOString(),
    action: normalizedAction,
    state_version: cleanText(snapshot?.stateVersion, 128),
    target: {
      issue_id: cleanText(targetSource.issueId, 160),
      evidence_fingerprint: cleanText(targetSource.evidenceFingerprint, 128)
    },
    params: {}
  };
  if (normalizedAction === 'record_decision') {
    payload.params = {
      approval_id: cleanText(paramsSource.approvalId, 180),
      decision_fingerprint: cleanText(paramsSource.decisionFingerprint, 128),
      decision: cleanText(paramsSource.decision, 40),
      note: cleanText(paramsSource.note, 500),
      defer_until: cleanText(paramsSource.deferUntil, 80)
    };
  } else if (normalizedAction === 'rate_result') {
    payload.params = {
      dispatch_id: cleanText(paramsSource.dispatchId, 180),
      rating: cleanText(paramsSource.rating, 40),
      note: cleanText(paramsSource.note, 500)
    };
  } else {
    payload.params = {
      note: cleanText(paramsSource.note, 800),
      until: cleanText(paramsSource.until, 80),
      dispatch_id: cleanText(paramsSource.dispatchId, 180),
      option_id: cleanText(paramsSource.optionId, 48),
      answers: normalizeAnswerValues(paramsSource.answers)
    };
  }
  return payload;
}

export function companySnapshotFreshness(snapshot, now = new Date()) {
  const timestamp = new Date(snapshot?.generatedAt || '');
  if (Number.isNaN(timestamp.getTime())) {
    return {
      status: 'unknown',
      ageMinutes: null,
      label: 'Update time unknown'
    };
  }
  const ageMinutes = Math.max(
    0,
    Math.round((now.getTime() - timestamp.getTime()) / 60000)
  );
  if (ageMinutes <= 15) {
    return { status: 'fresh', ageMinutes, label: 'Updated just now' };
  }
  if (ageMinutes <= 120) {
    return {
      status: 'aging',
      ageMinutes,
      label: `Updated ${ageMinutes} minutes ago`
    };
  }
  const hours = Math.max(2, Math.round(ageMinutes / 60));
  return { status: 'stale', ageMinutes, label: `Updated ${hours} hours ago` };
}

function normalizeToday(value) {
  const source = asRecord(value);
  const title = cleanText(source.title, 220);
  const nextAction = cleanText(source.next_action || source.nextAction, 500);
  if (isUnsupportedLegacyPriority(title, nextAction)) {
    return {
      status: 'waiting_for_supported_priority',
      project: 'Company',
      title: '',
      nextAction: '',
      why: '',
      doneWhen: '',
      confidence: 'unknown',
      userDirection: ''
    };
  }
  return {
    status: cleanText(source.status, 80),
    project: cleanText(source.project, 100) || 'Company',
    title,
    nextAction: cleanLegacyResponsibilityCopy(nextAction, 500),
    why: cleanText(source.why, 500),
    doneWhen: cleanLegacyResponsibilityCopy(
      source.done_when || source.doneWhen,
      500
    ),
    confidence: cleanText(source.confidence, 40) || 'unknown',
    userDirection: cleanText(source.user_direction || source.userDirection, 500)
  };
}

function normalizePriority(value) {
  const source = asRecord(value);
  const issueId = cleanText(source.issue_id || source.issueId, 160);
  if (!issueId) return null;
  const title = cleanText(source.title, 220);
  const nextAction = cleanText(source.next_action || source.nextAction, 500);
  if (isUnsupportedLegacyPriority(title, nextAction)) return null;
  return {
    issueId,
    evidenceFingerprint: cleanText(
      source.evidence_fingerprint || source.evidenceFingerprint,
      128
    ),
    project: cleanText(source.project, 100) || 'Company',
    title,
    businessLane: cleanText(source.business_lane || source.businessLane, 80),
    businessImpact: cleanText(
      source.business_impact || source.businessImpact,
      300
    ),
    priorityScore: toCount(source.priority_score ?? source.priorityScore),
    confidence: cleanText(source.confidence, 40) || 'unknown',
    currentState: cleanText(source.current_state || source.currentState, 120),
    nextAction: cleanLegacyResponsibilityCopy(nextAction, 500),
    doneWhen: cleanLegacyResponsibilityCopy(
      source.done_when || source.doneWhen,
      500
    ),
    userDirection: cleanText(
      source.user_direction || source.userDirection,
      500
    ),
    steered: source.steered === true
  };
}

function isUnsupportedLegacyPriority(title, nextAction) {
  const normalizedTitle = cleanText(title, 220)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (
    normalizedTitle.startsWith('meeting assets for ') &&
    normalizedTitle.endsWith(' are ready')
  ) {
    return true;
  }
  const words = normalizedTitle.split(/\s+/).filter(Boolean);
  const genericMeeting =
    words.length >= 2 &&
    words.length <= 7 &&
    ['call', 'discussion', 'meeting'].includes(words.at(-1));
  return (
    genericMeeting &&
    /^Turn .+ into a verified delivery decision: result, open technical question, commercial implication, and target date\.$/i.test(
      cleanText(nextAction, 500)
    )
  );
}

function normalizeAsset(value) {
  const source = asRecord(value);
  const assetId = cleanText(source.asset_id || source.assetId, 180);
  if (!assetId) return null;
  return {
    assetId,
    title: cleanText(source.title, 220),
    format: cleanText(source.format, 100),
    purpose: cleanText(source.purpose, 500),
    content: boundedMultiline(source.content, 8000)
  };
}

function normalizeDecision(value) {
  const source = asRecord(value);
  const approvalId = cleanText(source.approval_id || source.approvalId, 180);
  if (!approvalId) return null;
  return {
    approvalId,
    decisionFingerprint: cleanText(
      source.decision_fingerprint || source.decisionFingerprint,
      128
    ),
    title: cleanText(source.title, 220),
    why: cleanText(source.why, 500),
    decisionRequested: cleanLegacyResponsibilityCopy(
      source.decision_requested || source.decisionRequested,
      500
    ),
    doneWhen: cleanLegacyResponsibilityCopy(
      source.done_when || source.doneWhen,
      500
    ),
    severity: cleanText(source.severity, 40),
    choices: Array.isArray(source.choices)
      ? source.choices.map((choice) => cleanText(choice, 120)).filter(Boolean)
      : []
  };
}

function normalizeReceipt(value) {
  const source = asRecord(value);
  return {
    receiptId: cleanText(source.receipt_id || source.receiptId, 180),
    label: cleanText(source.label, 180),
    summary: cleanLegacyResponsibilityCopy(source.summary, 500),
    status: cleanText(source.status, 60),
    finishedAt: cleanText(source.finished_at || source.finishedAt, 80),
    estimatedMinutesSaved: toCount(
      source.estimated_minutes_saved ?? source.estimatedMinutesSaved
    ),
    model: cleanText(source.model, 100),
    reasoningEffort: cleanText(
      source.reasoning_effort || source.reasoningEffort,
      30
    ),
    modelRoutingTier: cleanText(
      source.model_routing_tier || source.modelRoutingTier,
      40
    ),
    executionRepo: cleanText(
      source.execution_repo || source.executionRepo,
      120
    ),
    executionBranch: cleanText(
      source.execution_branch || source.executionBranch,
      180
    ),
    executionBranchPendingCommitCount: toCount(
      source.execution_branch_pending_commit_count ??
        source.executionBranchPendingCommitCount
    ),
    isolatedExecution:
      source.isolated_execution === true || source.isolatedExecution === true,
    sessionId: cleanText(source.session_id || source.sessionId, 140)
  };
}

function normalizeDispatch(value) {
  const source = asRecord(value);
  const commandId = cleanText(source.command_id || source.commandId, 120);
  const dispatchId = cleanText(source.dispatch_id || source.dispatchId, 160);
  if (!commandId && !dispatchId) return null;
  const project = cleanText(source.project, 100) || 'Company';
  const legacyDestinations = normalizeArray(
    source.deliverables,
    normalizeLegacyDeliverable,
    2
  );
  const normalizedResult = normalizeDispatchResult(
    source.result,
    source,
    legacyDestinations
  );
  const unusable = isUnusableLegacyDispatch(source, normalizedResult);
  const unusableSummary = `The ${project} run did not produce a usable deliverable because the readable source facts were missing.`;
  return {
    dispatchId,
    commandId,
    issueId: cleanText(source.issue_id || source.issueId, 160),
    evidenceFingerprint: cleanText(
      source.evidence_fingerprint || source.evidenceFingerprint,
      128
    ),
    project,
    status: unusable ? 'failed' : cleanText(source.status, 60) || 'unknown',
    reason: cleanText(source.reason, 240),
    summary: unusable
      ? unusableSummary
      : cleanLegacyResponsibilityCopy(source.summary, 500),
    outcomeStatus: unusable
      ? 'failed'
      : cleanText(source.outcome_status || source.outcomeStatus, 60),
    requiresDecision:
      !unusable &&
      (source.requires_decision === true || source.requiresDecision === true),
    recommendedNextAction: unusable
      ? ''
      : cleanLegacyResponsibilityCopy(
          source.recommended_next_action || source.recommendedNextAction,
          500
        ),
    model: cleanText(source.model, 100),
    reasoningEffort: cleanText(
      source.reasoning_effort || source.reasoningEffort,
      30
    ),
    modelRoutingTier: cleanText(
      source.model_routing_tier || source.modelRoutingTier,
      40
    ),
    executionRepo: cleanText(
      source.execution_repo || source.executionRepo,
      120
    ),
    executionBranch: cleanText(
      source.execution_branch || source.executionBranch,
      180
    ),
    executionBranchPendingCommitCount: toCount(
      source.execution_branch_pending_commit_count ??
        source.executionBranchPendingCommitCount
    ),
    isolatedExecution:
      source.isolated_execution === true || source.isolatedExecution === true,
    sessionId: cleanText(source.session_id || source.sessionId, 140),
    startedAt: cleanText(source.started_at || source.startedAt, 80),
    finishedAt: cleanText(source.finished_at || source.finishedAt, 80),
    durationSeconds: toCount(source.duration_seconds ?? source.durationSeconds),
    artifactCount: toCount(source.artifact_count ?? source.artifactCount),
    result: unusable
      ? {
          status: 'failed',
          headline: unusableSummary,
          message: unusableSummary,
          completedWork: [],
          nextAction: '',
          destinations: [],
          userRequest: { instruction: '', reason: '', choices: [] },
          verification: { proofKind: '', reference: '', summary: '' }
        }
      : normalizedResult,
    estimatedMinutesSaved: toCount(
      source.estimated_minutes_saved ?? source.estimatedMinutesSaved
    ),
    timeTrackingStatus: cleanText(
      source.time_tracking_status || source.timeTrackingStatus,
      80
    )
  };
}

function isUnusableLegacyDispatch(dispatch, result) {
  const outcomeStatus = normalizedKey(
    dispatch.outcome_status || dispatch.outcomeStatus || result.status
  );
  if (outcomeStatus !== 'completed') return false;
  const summary = cleanText(dispatch.summary || result.headline, 1000);
  const nextAction = cleanText(
    dispatch.recommended_next_action ||
      dispatch.recommendedNextAction ||
      result.nextAction,
    1000
  );
  const combined = [summary, nextAction, ...result.completedWork]
    .join(' ')
    .toLowerCase();
  return (
    INTERNAL_CITATION_PATTERN.test(nextAction) ||
    combined.includes('no readable payload') ||
    combined.includes('evidence-bound') ||
    combined.includes('packet-grounded') ||
    combined.includes('separated unknown')
  );
}

function normalizeDispatchResult(value, dispatch, legacyDestinations) {
  const source = asRecord(value);
  const userRequest = asRecord(source.user_request || source.userRequest);
  const verification = asRecord(source.verification);
  const destinations = normalizeArray(
    source.destinations,
    normalizeResultDestination,
    4
  );
  return {
    status:
      cleanText(source.status, 60) ||
      cleanText(dispatch.outcome_status || dispatch.outcomeStatus, 60) ||
      cleanText(dispatch.status, 60) ||
      'unknown',
    headline:
      cleanLegacyResponsibilityCopy(source.headline, 500) ||
      cleanLegacyResponsibilityCopy(dispatch.summary, 500),
    message:
      cleanLegacyResponsibilityCopy(source.message, 320) ||
      cleanLegacyResponsibilityCopy(dispatch.message, 320) ||
      cleanLegacyResponsibilityCopy(dispatch.summary, 320),
    completedWork: Array.isArray(source.completed_work || source.completedWork)
      ? (source.completed_work || source.completedWork)
          .map((item) => cleanLegacyResponsibilityCopy(item, 300))
          .filter(Boolean)
          .slice(0, 6)
      : [],
    nextAction:
      cleanLegacyResponsibilityCopy(
        source.next_action || source.nextAction,
        500
      ) ||
      cleanLegacyResponsibilityCopy(
        dispatch.recommended_next_action || dispatch.recommendedNextAction,
        500
      ),
    destinations: destinations.length ? destinations : legacyDestinations,
    userRequest: {
      instruction: cleanLegacyResponsibilityCopy(userRequest.instruction, 240),
      reason: cleanLegacyResponsibilityCopy(userRequest.reason, 180),
      choices: Array.isArray(userRequest.choices)
        ? userRequest.choices
            .map(normalizeUserRequestChoice)
            .filter(Boolean)
            .slice(0, 3)
        : []
    },
    verification: {
      proofKind: cleanText(
        verification.proof_kind || verification.proofKind,
        40
      ),
      reference: cleanText(verification.reference, 80),
      summary: cleanText(verification.summary, 240)
    }
  };
}

function normalizeUserRequestChoice(value) {
  if (typeof value === 'string') {
    const label = cleanLegacyResponsibilityCopy(value, 48);
    return label
      ? {
          id: normalizedKey(label).slice(0, 48),
          label,
          kind: 'decision',
          fields: []
        }
      : null;
  }
  const source = asRecord(value);
  const label = cleanLegacyResponsibilityCopy(source.label, 48);
  const id = cleanText(source.id, 48) || normalizedKey(label).slice(0, 48);
  const kind = normalizedKey(source.kind);
  if (!id || !label || !['decision', 'details'].includes(kind)) return null;
  return {
    id,
    label,
    kind,
    fields: normalizeArray(source.fields, normalizeUserRequestField, 5)
  };
}

function normalizeUserRequestField(value) {
  const source = asRecord(value);
  const label = cleanLegacyResponsibilityCopy(source.label, 80);
  const id = cleanText(source.id, 48) || normalizedKey(label).slice(0, 48);
  const type = normalizedKey(source.type);
  if (!id || !label || !['text', 'textarea', 'date', 'select'].includes(type)) {
    return null;
  }
  const options = Array.isArray(source.options)
    ? source.options
        .map((item) => cleanText(item, 80))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  if (type === 'select' && !options.length) return null;
  return {
    id,
    label,
    type,
    required: source.required === true,
    placeholder: cleanText(source.placeholder, 160),
    options
  };
}

function normalizeAnswerValues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = asRecord(item);
      const fieldId = cleanText(source.fieldId || source.field_id, 48);
      const answer = cleanText(source.value, 400);
      return fieldId && answer ? { field_id: fieldId, value: answer } : null;
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeLegacyDeliverable(value) {
  const source = asRecord(value);
  const kind = normalizedKey(source.kind);
  if (!LEGACY_PREVIEW_KINDS.has(kind)) return null;
  const content = boundedMultiline(source.content, 40000);
  const sha256 = cleanText(source.sha256, 64).toLowerCase();
  if (source.verified !== true || !content || !/^[0-9a-f]{64}$/.test(sha256)) {
    return null;
  }
  return {
    type: 'internal_brief',
    mode: 'preview',
    label: cleanText(source.label, 180) || 'Codex result',
    kind,
    location: 'Available here in the app',
    actionLabel: 'View full output',
    previewContent: content,
    downloadContent: '',
    filename: '',
    mimeType: '',
    url: '',
    bytes: toCount(source.bytes),
    sha256,
    verified: true
  };
}

function normalizeResultDestination(value) {
  const source = asRecord(value);
  const type = normalizedKey(source.type);
  const mode = normalizedKey(source.mode);
  if (source.verified !== true || !RESULT_DESTINATION_TYPES.has(type)) {
    return null;
  }
  const base = {
    type,
    mode,
    label: cleanText(source.label, 180) || 'Codex result',
    kind: normalizedKey(source.kind) || 'result',
    location: cleanText(source.location, 180),
    statusText: cleanText(source.status_text || source.statusText, 240),
    bytes: toCount(source.bytes),
    sha256: cleanText(source.sha256, 64).toLowerCase(),
    verified: true
  };
  if (mode === 'preview' && type === 'internal_brief') {
    const previewContent = boundedMultiline(
      source.preview_content || source.previewContent,
      40000
    );
    if (!previewContent || !/^[0-9a-f]{64}$/.test(base.sha256)) return null;
    return {
      ...base,
      location: 'Available here in the app',
      actionLabel:
        cleanText(source.action_label || source.actionLabel, 80) ||
        'View full output',
      previewContent,
      downloadContent: '',
      filename: '',
      mimeType: '',
      url: ''
    };
  }
  if (mode === 'download' && type === 'private_file') {
    const downloadContent = boundedMultiline(
      source.download_content || source.downloadContent,
      40000
    );
    const filename = cleanFilename(source.filename);
    if (!downloadContent || !filename || !/^[0-9a-f]{64}$/.test(base.sha256)) {
      return null;
    }
    return {
      ...base,
      actionLabel: 'Download file',
      previewContent: '',
      downloadContent,
      filename,
      mimeType: normalizeTextMimeType(source.mime_type || source.mimeType),
      url: ''
    };
  }
  if (mode === 'open') {
    const url = normalizeDestinationUrl(type, source.url);
    if (!url) return null;
    return {
      ...base,
      actionLabel: destinationActionLabel(type),
      previewContent: '',
      downloadContent: '',
      filename: '',
      mimeType: '',
      url
    };
  }
  if (mode === 'none' && type === 'private_file') {
    return {
      ...base,
      actionLabel: '',
      previewContent: '',
      downloadContent: '',
      filename: '',
      mimeType: '',
      url: ''
    };
  }
  if (
    mode === 'none' &&
    ['closed_state', 'local_commit', 'updated_file'].includes(type)
  ) {
    const reference = cleanText(source.reference, 240);
    if (!reference) return null;
    return {
      ...base,
      reference,
      actionLabel: '',
      previewContent: '',
      downloadContent: '',
      filename: '',
      mimeType: '',
      url: ''
    };
  }
  return null;
}

function normalizeDestinationUrl(type, value) {
  const raw = cleanText(value, 1000);
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = url.hostname.toLowerCase();
  if (isLocalHostname(host)) return '';
  const allowed = {
    github_change: host === 'github.com' || host.endsWith('.github.com'),
    onedrive_document: host === '1drv.ms' || host === 'onedrive.live.com',
    outlook_draft:
      host === 'outlook.office.com' || host === 'outlook.office365.com',
    sharepoint_document: host.endsWith('.sharepoint.com'),
    website: true
  };
  return allowed[type] ? url.href : '';
}

function destinationActionLabel(type) {
  return {
    github_change: 'View changes',
    onedrive_document: 'Open document',
    outlook_draft: 'Open draft',
    sharepoint_document: 'Open document',
    website: 'Open page'
  }[type];
}

function isLocalHostname(host) {
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('127.') || host.startsWith('10.')) {
    return true;
  }
  if (host.startsWith('192.168.') || host.startsWith('169.254.')) return true;
  const match = /^172\.(\d{1,3})\./.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function cleanFilename(value) {
  const filename = [...String(value || '')]
    .map((character) =>
      character.charCodeAt(0) <= 31 || '\\/:*?"<>|'.includes(character)
        ? '-'
        : character
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return filename && filename !== '.' && filename !== '..' ? filename : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTextMimeType(value) {
  const mime = cleanText(value, 100).toLowerCase();
  return /^(text\/(?:plain|markdown|csv))(?:;charset=utf-8)?$/.test(mime)
    ? mime
    : 'text/plain;charset=utf-8';
}

function normalizedKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeSource(value) {
  const source = asRecord(value);
  return {
    name: cleanText(source.name, 80),
    status: cleanText(source.status, 80),
    statusText: cleanText(source.status_text || source.statusText, 160),
    updatedAt: cleanText(source.updated_at || source.updatedAt, 80)
  };
}

function normalizeArray(value, normalizer, limit) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizer).filter(Boolean).slice(0, limit);
}

function normalizeRepository(value) {
  const repository = cleanText(value, 180).replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    ? repository
    : '';
}

function normalizePath(value, fallback) {
  const path = cleanText(value || fallback, 240)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return path || fallback;
}

function boundedMultiline(value, limit) {
  return String(value || '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, limit);
}

function cleanText(value, limit) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

/** @returns {Record<string, any>} */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}
