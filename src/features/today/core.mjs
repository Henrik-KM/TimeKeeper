const ATTENTION_KIND_ORDER = new Map([
  ['timer', 0],
  ['company', 1],
  ['workout', 2],
  ['finance', 3],
  ['sync', 4],
  ['codex', 5]
]);

const ATTENTION_SEVERITY = {
  critical: 300,
  high: 200,
  normal: 100,
  low: 0
};

export function buildCompanyTodayCard(
  snapshot,
  { freshness = 'unknown' } = {}
) {
  if (!snapshot) {
    return {
      label: 'Company',
      value: 'Connect Company',
      detail: 'Open Company to connect',
      tone: 'muted',
      state: 'disconnected',
      deepLink: '#company'
    };
  }
  const summary = normalizeCompanySummary(snapshot.companySummary);
  const state = summary.state || fallbackCompanyState(snapshot);
  const fallback = fallbackCompanyCopy(snapshot, state);
  const headline =
    summary.headline ||
    fallback.headline ||
    snapshot.missions?.primary?.headline ||
    snapshot.missions?.primary?.project ||
    snapshot.today?.title ||
    'Nothing needs you';
  const headlineParts = splitProjectHeadline(headline);
  const value = headlineParts?.project || headline;
  const detail =
    headlineParts?.action ||
    summary.detail ||
    fallback.detail ||
    snapshot.missions?.primary?.userAction ||
    snapshot.missions?.primary?.latestUpdate ||
    snapshot.missions?.primary?.objective ||
    'No supported company action is waiting.';
  const stale = freshness === 'stale' || freshness === 'unknown';
  return {
    label: companyStateLabel(state),
    value: cleanText(value, 90),
    detail: cleanText(stale ? `${detail} · Update is stale` : detail, 150),
    tone: stale ? 'muted' : companyStateTone(state),
    state,
    deepLink: summary.deepLink || '#company',
    missionId: summary.missionId,
    counts: summary.counts,
    attentionTitle: cleanText(headline, 120),
    attentionDetail: cleanText(summary.detail || detail, 180)
  };
}

function fallbackCompanyCopy(snapshot, state) {
  const active = Array.isArray(snapshot.missions?.active)
    ? snapshot.missions.active
    : [];
  if (state === 'needs_you') {
    const mission = active.find(
      (item) => item?.status === 'waiting_for_decision'
    );
    const decision = Array.isArray(snapshot.decisions?.pending)
      ? snapshot.decisions.pending[0]
      : null;
    return {
      headline:
        mission?.userAction ||
        mission?.userRequest?.instruction ||
        decision?.decisionRequested ||
        decision?.title ||
        mission?.headline ||
        mission?.objective,
      detail:
        mission?.waitingReason ||
        mission?.userRequest?.reason ||
        decision?.why ||
        decision?.doneWhen
    };
  }
  if (state === 'ready') {
    const mission = snapshot.missions?.completedToday?.[0];
    return {
      headline: mission?.headline || mission?.objective,
      detail: mission?.resultSummary || mission?.latestUpdate
    };
  }
  if (state === 'working') {
    const mission =
      snapshot.missions?.primary ||
      active.find((item) => item?.status === 'active');
    return {
      headline: mission?.headline || mission?.objective,
      detail: mission?.latestUpdate || mission?.doneWhen
    };
  }
  if (state === 'up_next') {
    const mission = active.find((item) => item?.status === 'queued');
    const priority = snapshot.priorities?.[0];
    return {
      headline:
        mission?.headline ||
        mission?.objective ||
        priority?.nextAction ||
        priority?.title,
      detail: mission?.doneWhen || priority?.why || priority?.doneWhen
    };
  }
  if (state === 'waiting') {
    const mission = active.find(
      (item) => item?.status === 'waiting_for_source'
    );
    return {
      headline: mission?.headline || mission?.objective,
      detail: mission?.waitingReason || mission?.doneWhen
    };
  }
  return { headline: '', detail: '' };
}

function splitProjectHeadline(value) {
  const match = /^([^:]{2,60}):\s*(.{3,})$/.exec(cleanText(value, 180));
  if (!match) return null;
  return {
    project: match[1].trim(),
    action: match[2].trim()
  };
}

export function chooseTodayAttention(candidates = []) {
  return (
    candidates
      .filter((candidate) => candidate && candidate.active === true)
      .map(normalizeAttention)
      .filter(Boolean)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (
          (ATTENTION_KIND_ORDER.get(left.kind) ?? 99) -
          (ATTENTION_KIND_ORDER.get(right.kind) ?? 99)
        );
      })[0] || null
  );
}

function normalizeCompanySummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const counts =
    source.counts && typeof source.counts === 'object' ? source.counts : {};
  return {
    state: cleanText(source.state, 40),
    headline: cleanText(source.headline, 180),
    detail: cleanText(source.detail, 240),
    deepLink: normalizeDeepLink(source.deep_link || source.deepLink),
    missionId: cleanText(source.mission_id || source.missionId, 100),
    counts: {
      needsYou: toCount(counts.needs_you ?? counts.needsYou),
      ready: toCount(counts.ready),
      working: toCount(counts.working),
      upNext: toCount(counts.up_next ?? counts.upNext),
      waiting: toCount(counts.waiting)
    }
  };
}

function fallbackCompanyState(snapshot) {
  const active = Array.isArray(snapshot.missions?.active)
    ? snapshot.missions.active
    : [];
  if (
    snapshot.decisions?.pendingCount ||
    snapshot.decisions?.pending?.length ||
    active.some((mission) => mission?.status === 'waiting_for_decision') ||
    snapshot.missions?.waitingCount
  ) {
    return 'needs_you';
  }
  if (
    snapshot.missions?.completedTodayCount ||
    snapshot.missions?.completedToday?.length
  ) {
    return 'ready';
  }
  if (active.some((mission) => mission?.status === 'active')) return 'working';
  if (active.some((mission) => mission?.status === 'queued')) return 'up_next';
  if (snapshot.priorities?.length) return 'up_next';
  if (active.some((mission) => mission?.status === 'waiting_for_source')) {
    return 'waiting';
  }
  if (snapshot.missions?.activeCount) return 'working';
  return 'clear';
}

function companyStateLabel(state) {
  return (
    {
      needs_you: 'Company · Needs you',
      ready: 'Company · Ready',
      working: 'Company · Working',
      up_next: 'Company · Up next',
      waiting: 'Company · Waiting',
      clear: 'Company'
    }[state] || 'Company'
  );
}

function companyStateTone(state) {
  return (
    {
      needs_you: 'risk',
      ready: 'success',
      working: 'primary',
      up_next: '',
      waiting: 'muted',
      clear: 'muted'
    }[state] || ''
  );
}

function normalizeAttention(value) {
  const kind = cleanText(value.kind, 40);
  const title = cleanText(value.title, 100);
  if (!kind || !title) return null;
  const severity = cleanText(value.severity, 20) || 'normal';
  const urgency = Number(value.urgency);
  return {
    kind,
    title,
    detail: cleanText(value.detail, 180),
    deepLink: normalizeDeepLink(value.deepLink),
    pushEligible: value.pushEligible === true,
    severity,
    fingerprint: cleanText(value.fingerprint, 160),
    score:
      (ATTENTION_SEVERITY[severity] ?? ATTENTION_SEVERITY.normal) +
      (Number.isFinite(urgency) ? Math.max(0, Math.min(99, urgency)) : 0)
  };
}

function normalizeDeepLink(value) {
  const link = String(value || '').trim();
  return /^#[a-zA-Z0-9_-]{1,40}$/.test(link) ? link : '#today';
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function cleanText(value, limit) {
  return [...String(value || '')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}
