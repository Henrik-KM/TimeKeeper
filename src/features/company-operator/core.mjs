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
  'record_decision',
  'set_priority',
  'snooze',
  'work_next'
]);

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
    sources: {
      status: cleanText(sources.status, 80),
      attentionCount: toCount(
        sources.attention_count ?? sources.attentionCount
      ),
      items: normalizeArray(sources.items, normalizeSource, 12)
    }
  };
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
  } else {
    payload.params = {
      note: cleanText(paramsSource.note, 500),
      until: cleanText(paramsSource.until, 80)
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
  return {
    status: cleanText(source.status, 80),
    project: cleanText(source.project, 100) || 'Company',
    title: cleanText(source.title, 220),
    nextAction: cleanText(source.next_action || source.nextAction, 500),
    why: cleanText(source.why, 500),
    doneWhen: cleanText(source.done_when || source.doneWhen, 500),
    confidence: cleanText(source.confidence, 40) || 'unknown',
    userDirection: cleanText(source.user_direction || source.userDirection, 500)
  };
}

function normalizePriority(value) {
  const source = asRecord(value);
  const issueId = cleanText(source.issue_id || source.issueId, 160);
  if (!issueId) return null;
  return {
    issueId,
    evidenceFingerprint: cleanText(
      source.evidence_fingerprint || source.evidenceFingerprint,
      128
    ),
    project: cleanText(source.project, 100) || 'Company',
    title: cleanText(source.title, 220),
    businessLane: cleanText(source.business_lane || source.businessLane, 80),
    businessImpact: cleanText(
      source.business_impact || source.businessImpact,
      300
    ),
    priorityScore: toCount(source.priority_score ?? source.priorityScore),
    confidence: cleanText(source.confidence, 40) || 'unknown',
    currentState: cleanText(source.current_state || source.currentState, 120),
    nextAction: cleanText(source.next_action || source.nextAction, 500),
    doneWhen: cleanText(source.done_when || source.doneWhen, 500),
    userDirection: cleanText(
      source.user_direction || source.userDirection,
      500
    ),
    steered: source.steered === true
  };
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
    decisionRequested: cleanText(
      source.decision_requested || source.decisionRequested,
      500
    ),
    doneWhen: cleanText(source.done_when || source.doneWhen, 500),
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
    summary: cleanText(source.summary, 500),
    status: cleanText(source.status, 60),
    finishedAt: cleanText(source.finished_at || source.finishedAt, 80),
    estimatedMinutesSaved: toCount(
      source.estimated_minutes_saved ?? source.estimatedMinutesSaved
    )
  };
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
