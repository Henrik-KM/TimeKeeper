export const OUTREACH_PATHS = Object.freeze({
  state: 'outreach/state.json',
  commands: 'outreach/commands',
  receipts: 'outreach/receipts'
});
const ACTIONS = new Set([
  'pause',
  'resume',
  'take_over',
  'release',
  'reactivate',
  'snooze',
  'suppress',
  'mark_handled'
]);
const text = (value, limit = 400) =>
  String(value ?? '')
    .split('')
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 || ['\n', '\t', '\r'].includes(character)
    )
    .join('')
    .trim()
    .slice(0, limit);
const count = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

export function safeOutreachUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname.includes('.') &&
      !/^(localhost|127\.|0\.|\[)/i.test(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function normalizeOutreachSnapshot(value) {
  if (!value || value.schema_version !== 1 || value.kind !== 'henrik_outreach')
    return null;
  return {
    stateVersion: text(value.state_version, 128),
    generatedAt: text(value.generated_at, 80),
    status: text(value.status, 40),
    nextRunAt: text(value.next_run_at, 80),
    linkedinBlocked: text(value.linkedin_blocked, 160),
    remaining: {
      linkedin: count(value.remaining_today?.linkedin),
      email: count(value.remaining_today?.email)
    },
    counts: {
      messages: count(value.counts?.messages_sent),
      drafts: count(value.counts?.drafts_prepared),
      sentEmails: count(value.counts?.emails_sent_by_henrik),
      interested: count(value.counts?.interested)
    },
    opportunities: (Array.isArray(value.opportunities)
      ? value.opportunities
      : []
    )
      .slice(0, 150)
      .map((row) => ({
        id: text(row.opportunity_id, 80),
        personId: text(row.person_id, 300),
        company: text(row.company, 120),
        contact: text(row.contact, 120),
        role: text(row.role, 160),
        need: text(row.need),
        offer: text(row.offer),
        whyNow: text(row.why_now),
        nextStep: text(row.next_step),
        latestOutcome: text(row.latest_outcome),
        attention: text(row.attention_reason),
        status: text(row.status, 40),
        channel: row.channel === 'linkedin' ? 'LinkedIn' : 'Outlook',
        dueAt: text(row.due_at, 80),
        profileUrl: safeOutreachUrl(row.profile_url),
        sourceUrl: safeOutreachUrl(row.source_url),
        humanOwned: row.ownership === 'human',
        interested: row.interest_confirmed === true,
        suppressed: row.suppressed === true
      }))
      .filter((row) => row.id && row.personId),
    recentActions: (Array.isArray(value.recent_actions)
      ? value.recent_actions
      : []
    )
      .slice(0, 30)
      .map((row) => ({
        id: text(row.action_id, 100),
        opportunityId: text(row.opportunity_id, 80),
        status: text(row.status, 40),
        date: text(row.verified_at || row.created_at, 80)
      }))
  };
}

export function buildOutreachCommand({
  action,
  commandId,
  snapshot,
  personId = '',
  until = '',
  now = new Date()
}) {
  if (!ACTIONS.has(action) || !/^[A-Za-z0-9_-]{8,100}$/.test(commandId))
    throw new Error('Invalid outreach control.');
  if (!snapshot?.stateVersion || !Number.isFinite(now.getTime()))
    throw new Error('Refresh outreach first.');
  if (
    !['pause', 'resume'].includes(action) &&
    !snapshot.opportunities.some((row) => row.personId === personId)
  )
    throw new Error('Contact no longer in this view.');
  return {
    schema_version: 1,
    source: 'timekeeper_mobile',
    command_id: commandId,
    action,
    state_version: snapshot.stateVersion,
    issued_at: now.toISOString(),
    person_id: text(personId, 300),
    until: text(until, 80)
  };
}

export function outreachGroup(row) {
  if (row.suppressed || ['closed', 'parked'].includes(row.status))
    return 'results';
  if (row.status === 'needs_you') return 'needs';
  return row.status === 'planned' ? 'planned' : 'active';
}

export function outreachDate(value, withTime = true) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'Europe/Berlin',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  }).format(date);
}
