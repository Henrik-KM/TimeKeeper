import { uuid } from '../../shared/id.mjs';
import { openFormDialog, requestConfirm, showToast } from '../../shared/ui.mjs';
import {
  buildCompanyOperatorCommand,
  companySnapshotFreshness,
  normalizeCompanyOperatorSettings,
  normalizeCompanyOperatorSnapshot
} from './core.mjs';

const SETTINGS_KEY = 'timekeeperCompanyOperatorSettings';
const TOKEN_KEY = 'timekeeperCompanyOperatorToken';
const SNAPSHOT_KEY = 'timekeeperCompanyOperatorSnapshot';
const PENDING_KEY = 'timekeeperCompanyOperatorPendingCommands';
const RECEIPTS_KEY = 'timekeeperCompanyOperatorReceipts';
const POLL_INTERVAL_MS = 60 * 1000;
const CODEX_ACTIONS = new Set(['add_direction', 'work_next']);
const HIDE_PRIORITY_ACTIONS = new Set(['mark_handled', 'snooze', 'work_next']);

export function createCompanyOperatorController({
  root,
  connectButton,
  refreshButton
}) {
  let snapshot = loadSnapshot();
  let busy = false;
  let active = false;
  let pollTimer = null;

  connectButton?.addEventListener('click', () => configureConnection());
  refreshButton?.addEventListener('click', () => refresh({ announce: true }));

  function setActive(value) {
    active = value === true;
    if (active) {
      render();
      refresh({ announce: false });
      startPolling();
    } else {
      stopPolling();
    }
  }

  async function refresh({ announce = false } = {}) {
    if (busy || !hasConnection()) {
      render();
      return null;
    }
    busy = true;
    updateButtons();
    try {
      const remote = await readRemoteJson(getSettings().statePath);
      const normalized = normalizeCompanyOperatorSnapshot(remote?.payload);
      if (!normalized) {
        throw new Error(
          'The Company workspace returned an unsupported response.'
        );
      }
      snapshot = normalized;
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(normalized));
      await checkPendingReceipts();
      if (announce) showToast('Company information refreshed.');
      return normalized;
    } catch (error) {
      if (announce) showToast(companyErrorMessage(error));
      return null;
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  async function configureConnection() {
    const settings = getSettings();
    const values = await openFormDialog({
      title: hasConnection() ? 'Company connection' : 'Connect Company',
      fields: [
        {
          name: 'repository',
          label: 'Private GitHub repository',
          value: settings.repository,
          required: true,
          placeholder: 'owner/private-repository'
        },
        {
          name: 'token',
          label: hasConnection()
            ? 'New fine-grained token (leave blank to keep current)'
            : 'Fine-grained GitHub token',
          type: 'password',
          value: '',
          required: !hasConnection(),
          placeholder: 'Access only to the private Company bridge repository'
        }
      ],
      submitLabel: 'Connect'
    });
    if (!values) return;
    const next = normalizeCompanyOperatorSettings({
      ...settings,
      repository: values.repository
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    if (String(values.token || '').trim()) {
      localStorage.setItem(TOKEN_KEY, String(values.token).trim());
    }
    render();
    const connected = await refresh({ announce: false });
    showToast(
      connected
        ? 'Company workspace connected.'
        : 'Connection saved, but the private workspace could not be read.'
    );
  }

  async function disconnect() {
    const confirmed = await requestConfirm({
      title: 'Disconnect Company?',
      message:
        'This removes the private repository connection and cached Company view from this device. It does not delete company information.',
      confirmLabel: 'Disconnect',
      danger: true
    });
    if (!confirmed) return;
    [SETTINGS_KEY, TOKEN_KEY, SNAPSHOT_KEY, PENDING_KEY, RECEIPTS_KEY].forEach(
      (key) => localStorage.removeItem(key)
    );
    snapshot = null;
    render();
    showToast('Company workspace disconnected from this device.');
  }

  async function queuePriorityAction(action, priority, params = {}) {
    if (!snapshot || !priority || busy) return;
    busy = true;
    updateButtons();
    const commandId = `mobile-${uuid()}`;
    try {
      const command = buildCompanyOperatorCommand({
        commandId,
        action,
        snapshot,
        target: {
          issueId: priority.issueId,
          evidenceFingerprint: priority.evidenceFingerprint
        },
        params
      });
      await writeRemoteJson(
        `${getSettings().commandsPath}/${commandId}.json`,
        command,
        'Queue private TimeKeeper Company steering instruction'
      );
      savePending([
        ...loadPending(),
        {
          commandId,
          action,
          label: priority.project || priority.title || 'Company priority',
          issueId: priority.issueId,
          evidenceFingerprint: priority.evidenceFingerprint,
          dispatchId: String(params.dispatchId || ''),
          project: priority.project || 'Company',
          title: priority.title || '',
          status: 'queued',
          queuedAt: new Date().toISOString()
        }
      ]);
      showToast(priorityActionFeedback(action, params));
    } catch (error) {
      showToast(companyErrorMessage(error));
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  async function addDirection(priority, extraParams = {}) {
    const values = await openFormDialog({
      title: `Steer ${priority.project || 'this work'}`,
      fields: [
        {
          name: 'note',
          label: 'What should Codex change or focus on?',
          type: 'textarea',
          rows: 4,
          required: true,
          value: priority.userDirection || '',
          placeholder:
            'Use plain instructions. This becomes direction, not source evidence.'
        }
      ],
      submitLabel: 'Send direction'
    });
    if (!values?.note?.trim()) return;
    await queuePriorityAction('add_direction', priority, {
      ...extraParams,
      note: values.note
    });
  }

  async function answerDispatch(dispatch, choice = null) {
    const priority = {
      issueId: dispatch.issueId,
      evidenceFingerprint: dispatch.evidenceFingerprint,
      project: dispatch.project,
      title: dispatch.result.headline,
      userDirection: ''
    };
    if (choice) {
      const fields = Array.isArray(choice.fields) ? choice.fields : [];
      let answers = [];
      if (fields.length) {
        const values = await openFormDialog({
          title: choice.label || dispatch.result.headline,
          fields: fields.map((field) => ({
            name: field.id,
            label: field.label,
            type: field.type,
            rows: field.type === 'textarea' ? 4 : undefined,
            required: field.required,
            placeholder: field.placeholder,
            options:
              field.type === 'select'
                ? field.options.map((option) => ({
                    value: option,
                    label: option
                  }))
                : undefined,
            value: ''
          })),
          submitLabel: 'Resume work'
        });
        if (!values) return;
        answers = fields
          .map((field) => ({
            fieldId: field.id,
            value: String(values[field.id] || '').trim()
          }))
          .filter((answer) => answer.value);
      }
      await queuePriorityAction('add_direction', priority, {
        dispatchId: dispatch.dispatchId,
        optionId: choice.id,
        answers
      });
      return;
    }
    await addDirection(priority, { dispatchId: dispatch.dispatchId });
  }

  async function rateDispatch(dispatch, rating = '') {
    let selectedRating = rating;
    let note = '';
    if (!selectedRating) {
      const values = await openFormDialog({
        title: 'Improve future Company work',
        fields: [
          {
            name: 'rating',
            label: 'What was wrong?',
            type: 'select',
            required: true,
            value: 'not_useful',
            options: [
              { value: 'not_useful', label: 'Not useful' },
              { value: 'wrong_priority', label: 'Wrong priority' },
              { value: 'already_handled', label: 'Already handled' }
            ]
          },
          {
            name: 'note',
            label: 'What should improve? (optional)',
            type: 'textarea',
            rows: 3,
            value: ''
          }
        ],
        submitLabel: 'Save feedback'
      });
      if (!values) return;
      selectedRating = values.rating;
      note = values.note || '';
    }
    await queuePriorityAction(
      'rate_result',
      {
        issueId: dispatch.issueId,
        evidenceFingerprint: dispatch.evidenceFingerprint,
        project: dispatch.project,
        title: dispatch.result.headline
      },
      { dispatchId: dispatch.dispatchId, rating: selectedRating, note }
    );
  }

  async function snooze(priority) {
    const values = await openFormDialog({
      title: `Pause ${priority.project || 'this work'}`,
      fields: [
        {
          name: 'duration',
          label: 'Show it again',
          type: 'select',
          value: '7',
          options: [
            { value: '1', label: 'Tomorrow' },
            { value: '7', label: 'In one week' },
            { value: '30', label: 'In one month' }
          ]
        }
      ],
      submitLabel: 'Pause'
    });
    if (!values) return;
    const days = Math.max(1, Number(values.duration) || 7);
    await queuePriorityAction('snooze', priority, {
      until: new Date(Date.now() + days * 86400000).toISOString()
    });
  }

  async function markHandled(priority) {
    await queuePriorityAction('mark_handled', priority);
  }

  async function queueDecision(decision, choice) {
    if (!snapshot || !decision || busy) return;
    let note = '';
    let deferUntil = '';
    if (choice === 'modify') {
      const values = await openFormDialog({
        title: 'Change the direction',
        fields: [
          {
            name: 'note',
            label: 'What should change?',
            type: 'textarea',
            rows: 4,
            required: true,
            value: ''
          }
        ],
        submitLabel: 'Send change'
      });
      if (!values?.note?.trim()) return;
      note = values.note;
    } else if (choice === 'defer') {
      deferUntil = new Date(Date.now() + 86400000).toISOString();
    } else {
      const confirmed = await requestConfirm({
        title:
          choice === 'approve'
            ? 'Choose this direction?'
            : 'Dismiss this decision?',
        message:
          choice === 'approve'
            ? 'This records your direction. It does not send, publish, delete, deploy, or make a commitment.'
            : 'It will stay dismissed unless the underlying information changes.',
        confirmLabel: choice === 'approve' ? 'Choose direction' : 'Dismiss'
      });
      if (!confirmed) return;
    }
    if (busy) return;
    busy = true;
    updateButtons();
    const commandId = `mobile-${uuid()}`;
    const command = buildCompanyOperatorCommand({
      commandId,
      action: 'record_decision',
      snapshot,
      params: {
        approvalId: decision.approvalId,
        decisionFingerprint: decision.decisionFingerprint,
        decision: choice,
        note,
        deferUntil
      }
    });
    try {
      await writeRemoteJson(
        `${getSettings().commandsPath}/${commandId}.json`,
        command,
        'Queue private TimeKeeper Company decision'
      );
      savePending([
        ...loadPending(),
        {
          commandId,
          action: 'record_decision',
          label: decision.title || 'Company decision',
          queuedAt: new Date().toISOString()
        }
      ]);
      render();
      showToast('Decision queued. No external action was executed.');
    } catch (error) {
      showToast(companyErrorMessage(error));
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  async function checkPendingReceipts() {
    const pending = loadPending();
    if (!pending.length || !hasConnection()) return;
    const remaining = [];
    const completed = loadReceipts();
    let applied = false;
    for (const item of pending.slice(-30)) {
      try {
        const remote = await readRemoteJson(
          `${getSettings().receiptsPath}/${item.commandId}.json`,
          { allowMissing: true }
        );
        if (!remote?.payload) {
          remaining.push(item);
          continue;
        }
        let status = String(remote.payload.status || 'unknown');
        let reason = String(remote.payload.reason || '');
        if (
          item.action === 'mark_handled' &&
          status === 'blocked' &&
          reason === 'priority_no_longer_available'
        ) {
          status = 'applied';
          reason = '';
        }
        if (['queued', 'accepted', 'processing', 'running'].includes(status)) {
          remaining.push({
            ...item,
            status,
            reason,
            dispatch: safeRemoteDispatch(remote.payload.dispatch)
          });
          continue;
        }
        completed.push({
          commandId: item.commandId,
          label: item.label,
          action: item.action,
          issueId: item.issueId || '',
          evidenceFingerprint: item.evidenceFingerprint || '',
          dispatchId: item.dispatchId || '',
          status,
          reason,
          processedAt: String(remote.payload.processed_at || ''),
          dispatch: safeRemoteDispatch(remote.payload.dispatch)
        });
        applied = applied || status === 'applied';
      } catch (error) {
        remaining.push(item);
      }
    }
    savePending(remaining);
    saveReceipts(completed.slice(-30));
    if (applied) showToast('Company change synced.');
  }

  function render() {
    if (!root) return;
    root.replaceChildren();
    updateButtons();
    if (!hasConnection()) {
      root.appendChild(
        card(
          'Connect your private Company workspace',
          'Enter a fine-grained GitHub token with access only to the private TimeKeeper bridge repository. Company information is kept separate from normal TimeKeeper backups.',
          [button('Connect Company', 'primary', configureConnection)]
        )
      );
      return;
    }
    if (!snapshot) {
      root.appendChild(
        card(
          'Waiting for Company information',
          'The connection is saved. Refresh to load the latest company priority.',
          [button('Refresh', 'primary', () => refresh({ announce: true }))]
        )
      );
      root.appendChild(connectionFooter());
      return;
    }

    const freshness = companySnapshotFreshness(snapshot);
    root.appendChild(statusBanner(freshness));
    const dispatches = compactDispatchSections();
    if (dispatches.inProgress) root.appendChild(dispatches.inProgress);
    if (dispatches.done) root.appendChild(dispatches.done);
    const priorities = visiblePriorities();
    const primary = priorities[0];
    if (primary) root.appendChild(primaryCard(primary));
    else if (loadPending().some((item) => item.action === 'work_next')) {
      root.appendChild(
        card(
          'Codex is handling the current priority',
          'The next supported priority will appear here as soon as one is available.'
        )
      );
    }
    if (dispatches.needsYou) root.appendChild(dispatches.needsYou);
    if (snapshot.decisions.pending.length) {
      root.appendChild(decisionSection(snapshot.decisions.pending));
    } else if (!primary && !dispatches.needsYou && !dispatches.inProgress) {
      root.appendChild(
        card(
          'Nothing needs you',
          'No company action is worth your time right now.'
        )
      );
    }
    if (dispatches.problems) root.appendChild(dispatches.problems);
    const commands = commandStatus();
    if (commands) root.appendChild(commands);
    root.appendChild(sourceSection());
    root.appendChild(connectionFooter());
  }

  function statusBanner(freshness) {
    const banner = element('div', `company-status ${freshness.status}`);
    banner.appendChild(
      element(
        'strong',
        '',
        freshness.label.replace(/^Updated/, 'Dashboard synced')
      )
    );
    banner.appendChild(
      element(
        'span',
        '',
        snapshot.sources.attentionCount
          ? sourceAttentionSummary()
          : 'Company information is connected'
      )
    );
    return banner;
  }

  function sourceAttentionSummary() {
    const items = snapshot.sources.items
      .filter(
        (source) => !['ready', 'configured', 'disabled'].includes(source.status)
      )
      .map((source) => {
        const age = formatSourceAge(source.updatedAt);
        if (source.status === 'awaiting_transcript_export') {
          return `${displaySource(source.name)} transcript missing`;
        }
        return [displaySource(source.name), age].filter(Boolean).join(' ');
      });
    return items.slice(0, 2).join(' · ') || 'Some information needs refreshing';
  }

  function formatSourceAge(value) {
    const timestamp = new Date(value || '');
    if (Number.isNaN(timestamp.getTime())) return '';
    const minutes = Math.max(
      0,
      Math.round((Date.now() - timestamp.getTime()) / 60000)
    );
    if (minutes < 60) return `${Math.max(1, minutes)}m old`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h old`;
    return `${Math.round(hours / 24)}d old`;
  }

  function primaryCard(priority) {
    const section = element('section', 'company-primary-card');
    section.appendChild(element('p', 'company-eyebrow', 'Up next'));
    section.appendChild(element('h3', '', priority.project));
    section.appendChild(element('p', 'company-priority-title', priority.title));
    section.appendChild(
      element(
        'p',
        'company-next-action',
        priority.nextAction || 'Ready to work'
      )
    );
    if (priority.userDirection) {
      section.appendChild(
        labelledText('Your direction', priority.userDirection)
      );
    }
    const actions = element('div', 'company-action-grid');
    actions.appendChild(
      button('Start now', 'primary', () =>
        queuePriorityAction('work_next', priority)
      )
    );
    actions.appendChild(
      button('Add direction', 'secondary', () => addDirection(priority))
    );
    section.appendChild(actions);
    const more = element('details', 'company-more-actions');
    more.appendChild(element('summary', '', 'More actions'));
    const secondaryActions = element('div', 'company-action-grid');
    secondaryActions.appendChild(
      button('Pause', 'secondary', () => snooze(priority))
    );
    secondaryActions.appendChild(
      button('Already handled', 'secondary', () => markHandled(priority))
    );
    more.appendChild(secondaryActions);
    section.appendChild(more);
    return section;
  }

  function decisionSection(decisions) {
    const section = sectionBlock('Needs your decision');
    decisions.forEach((decision) => {
      const item = element('article', 'company-list-card decision');
      item.appendChild(element('h4', '', decision.title || 'Company decision'));
      if (decision.decisionRequested) {
        item.appendChild(element('p', '', decision.decisionRequested));
      }
      const actions = element('div', 'company-action-grid');
      actions.appendChild(
        button('Choose direction', 'primary', () =>
          queueDecision(decision, 'approve')
        )
      );
      actions.appendChild(
        button('Change', 'secondary', () => queueDecision(decision, 'modify'))
      );
      actions.appendChild(
        button('Tomorrow', 'secondary', () => queueDecision(decision, 'defer'))
      );
      actions.appendChild(
        button('Dismiss', 'secondary', () => queueDecision(decision, 'dismiss'))
      );
      item.appendChild(actions);
      section.appendChild(item);
    });
    return section;
  }

  function visiblePriorities() {
    const pending = loadPending().filter(
      (item) => HIDE_PRIORITY_ACTIONS.has(item.action) && item.issueId
    );
    const applied = loadReceipts().filter(
      (item) =>
        HIDE_PRIORITY_ACTIONS.has(item.action) &&
        item.status === 'applied' &&
        item.issueId
    );
    const remoteInProgress = Array.isArray(snapshot?.dispatches?.inProgress)
      ? snapshot.dispatches.inProgress
      : [];
    return snapshot.priorities.filter((priority) => {
      if (
        pending.some(
          (item) =>
            item.issueId === priority.issueId &&
            (!item.evidenceFingerprint ||
              item.evidenceFingerprint === priority.evidenceFingerprint)
        )
      ) {
        return false;
      }
      if (
        applied.some(
          (item) =>
            item.issueId === priority.issueId &&
            item.evidenceFingerprint === priority.evidenceFingerprint
        )
      ) {
        return false;
      }
      return !remoteInProgress.some(
        (item) => item.issueId && item.issueId === priority.issueId
      );
    });
  }

  function compactDispatchSections() {
    const pending = loadPending().filter((item) =>
      ['add_direction', 'work_next'].includes(item.action)
    );
    const pendingIssues = new Set(
      pending.map((item) => item.issueId).filter(Boolean)
    );
    const recent = Array.isArray(snapshot?.dispatches?.recent)
      ? snapshot.dispatches.recent
          .filter((dispatch) => !pendingIssues.has(dispatch.issueId))
          .slice(0, 5)
      : [];
    const sections = {
      inProgress: null,
      done: null,
      needsYou: null,
      problems: null
    };
    if (pending.length) {
      const inProgress = sectionBlock('In progress');
      pending.forEach((item) => {
        const row = element('article', 'company-dispatch-card in-progress');
        row.appendChild(element('strong', '', item.label || 'Company work'));
        row.appendChild(element('span', '', 'Codex is working on this now'));
        inProgress.appendChild(row);
      });
      sections.inProgress = inProgress;
    }
    const needsYou = recent.filter((dispatch) =>
      ['needs_decision', 'needs_you'].includes(dispatch.result.status)
    );
    const done = recent.filter((dispatch) =>
      ['completed', 'done'].includes(dispatch.result.status)
    );
    const problems = recent.filter(
      (dispatch) => !needsYou.includes(dispatch) && !done.includes(dispatch)
    );
    if (done.length) {
      const section = sectionBlock('Done for you');
      section.appendChild(compactDispatchCard(done[0], 'done'));
      if (done.length > 1) {
        const earlier = element('details', 'company-result-backlog');
        earlier.appendChild(
          element(
            'summary',
            '',
            `${done.length - 1} earlier result${done.length === 2 ? '' : 's'}`
          )
        );
        done.slice(1).forEach((dispatch) => {
          const card = compactDispatchCard(dispatch, 'done');
          card.classList.add('compact');
          earlier.appendChild(card);
        });
        section.appendChild(earlier);
      }
      sections.done = section;
    }
    if (needsYou.length) {
      const section = sectionBlock('Needs you');
      section.appendChild(compactDispatchCard(needsYou[0], 'needs-you'));
      if (needsYou.length > 1) {
        const backlog = element('details', 'company-question-backlog');
        backlog.appendChild(
          element(
            'summary',
            '',
            `${needsYou.length - 1} more question${needsYou.length === 2 ? '' : 's'}`
          )
        );
        needsYou.slice(1).forEach((dispatch) => {
          const card = compactDispatchCard(dispatch, 'needs-you');
          card.classList.add('compact');
          backlog.appendChild(card);
        });
        section.appendChild(backlog);
      }
      sections.needsYou = section;
    }
    if (problems.length) {
      const section = sectionBlock('System status', true);
      problems.forEach((dispatch) =>
        section.appendChild(compactDispatchCard(dispatch, 'problem'))
      );
      sections.problems = section;
    }
    return sections;
  }

  function compactDispatchCard(dispatch, tone) {
    const row = element('article', `company-dispatch-card ${tone}`);
    row.appendChild(element('p', 'company-eyebrow', dispatch.project));
    row.appendChild(
      element('strong', '', dispatch.result.headline || 'Company work updated')
    );
    if (dispatch.result.message && tone !== 'needs-you') {
      row.appendChild(element('span', '', dispatch.result.message));
    }
    if (tone === 'needs-you') {
      const request = dispatch.result.userRequest;
      row.appendChild(
        element(
          'p',
          'company-dispatch-next',
          request.instruction || dispatch.result.nextAction
        )
      );
      const actions = element('div', 'company-action-grid');
      request.choices.forEach((choice) => {
        actions.appendChild(
          button(choice.label, 'primary', () =>
            answerDispatch(dispatch, choice)
          )
        );
      });
      actions.appendChild(
        button('Add context', 'secondary', () => answerDispatch(dispatch))
      );
      row.appendChild(actions);
    }
    if (tone === 'done') {
      dispatch.result.destinations.forEach((destination) => {
        row.appendChild(compactResultDestination(destination));
      });
      const feedback = element('div', 'company-feedback-actions');
      const feedbackStatus = dispatchFeedbackStatus(dispatch);
      if (feedbackStatus === 'pending') {
        feedback.appendChild(
          element('span', 'company-feedback-status', 'Feedback syncing')
        );
      } else if (feedbackStatus === 'saved') {
        feedback.appendChild(
          element('span', 'company-feedback-status saved', 'Feedback saved')
        );
      } else {
        feedback.appendChild(
          button('Useful', 'secondary', () => rateDispatch(dispatch, 'useful'))
        );
        feedback.appendChild(
          button('Needs improvement', 'secondary', () => rateDispatch(dispatch))
        );
      }
      row.appendChild(feedback);
    }
    const details = [
      [dispatch.model, dispatch.reasoningEffort].filter(Boolean).join(' / '),
      dispatch.executionRepo,
      dispatch.executionBranch ? `Branch ${dispatch.executionBranch}` : '',
      formatDispatchDuration(dispatch.durationSeconds),
      dispatch.timeTrackingStatus === 'session_persisted'
        ? 'IFLAI time recorded'
        : ''
    ].filter(Boolean);
    if (details.length) {
      const runDetails = element('details', 'company-run-details');
      runDetails.appendChild(element('summary', '', 'Details'));
      if (tone === 'needs-you' && dispatch.result.userRequest.reason) {
        runDetails.appendChild(
          element('p', '', dispatch.result.userRequest.reason)
        );
      }
      runDetails.appendChild(element('small', '', details.join(' · ')));
      row.appendChild(runDetails);
    }
    return row;
  }

  function compactResultDestination(destination) {
    const item = element('div', 'company-result-destination');
    const description = element('div', 'company-result-location');
    description.appendChild(element('strong', '', destination.label));
    description.appendChild(
      element(
        'span',
        '',
        [destination.location, destination.reference]
          .filter(Boolean)
          .join(' · ')
      )
    );
    if (destination.statusText) {
      description.appendChild(element('small', '', destination.statusText));
    }
    item.appendChild(description);
    if (destination.mode === 'open') {
      const link = element(
        'a',
        'btn secondary company-result-action',
        destination.actionLabel
      );
      link.href = destination.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.appendChild(link);
    }
    return item;
  }

  function commandStatus() {
    const pending = loadPending();
    const codexPending = pending.filter((item) =>
      CODEX_ACTIONS.has(item.action)
    );
    const syncingPending = pending.filter(
      (item) => !CODEX_ACTIONS.has(item.action)
    );
    const receipts = loadReceipts().slice(-5).reverse();
    if (
      !pending.length &&
      !receipts.some((item) => item.status !== 'applied')
    ) {
      return null;
    }
    const section = element('section', 'company-command-status');
    if (codexPending.length) {
      section.appendChild(
        element(
          'p',
          'company-queued',
          `${codexPending.length} Codex job${codexPending.length === 1 ? '' : 's'} queued or in progress`
        )
      );
    }
    if (syncingPending.length) {
      section.appendChild(
        element(
          'p',
          'company-queued',
          `${syncingPending.length} Company change${syncingPending.length === 1 ? '' : 's'} syncing`
        )
      );
    }
    receipts
      .filter((receipt) => receipt.status !== 'applied')
      .forEach((receipt) => {
        section.appendChild(
          element(
            'p',
            `company-receipt ${receipt.status}`,
            `${receipt.label}: ${receipt.status === 'applied' ? 'Applied' : receipt.reason || 'Needs attention'}`
          )
        );
      });
    return section;
  }

  function priorityActionFeedback(action, params = {}) {
    if (action === 'mark_handled') {
      return 'Marked handled. Showing the next priority.';
    }
    if (action === 'snooze') {
      return 'Paused. Showing the next priority.';
    }
    if (action === 'work_next') {
      return 'Sent to Codex. Showing the next priority.';
    }
    if (action === 'add_direction') {
      return params.dispatchId
        ? 'Answer sent. Codex will resume this case.'
        : 'Direction sent to Codex.';
    }
    if (action === 'rate_result') {
      return 'Feedback queued. It will shape future Company work after the next sync.';
    }
    return 'Company change syncing.';
  }

  function dispatchFeedbackStatus(dispatch) {
    if (!dispatch?.dispatchId) return '';
    if (
      loadPending().some(
        (item) =>
          item.action === 'rate_result' &&
          item.dispatchId === dispatch.dispatchId
      )
    ) {
      return 'pending';
    }
    if (
      loadReceipts().some(
        (item) =>
          item.action === 'rate_result' &&
          item.dispatchId === dispatch.dispatchId &&
          item.status === 'applied'
      )
    ) {
      return 'saved';
    }
    return '';
  }

  function sourceSection() {
    const details = element('details', 'company-sources');
    details.appendChild(element('summary', '', 'Information status'));
    snapshot.sources.items.forEach((source) => {
      const row = element('div', 'company-source-row');
      row.appendChild(element('span', '', displaySource(source.name)));
      row.appendChild(
        element(
          'strong',
          source.status === 'ready' || source.status === 'configured'
            ? 'ready'
            : 'attention',
          [
            source.statusText || source.status,
            formatSourceAge(source.updatedAt)
          ]
            .filter(Boolean)
            .join(' · ')
        )
      );
      details.appendChild(row);
    });
    return details;
  }

  function connectionFooter() {
    const footer = element('div', 'company-connection-footer');
    footer.appendChild(
      element('span', '', `Private workspace: ${getSettings().repository}`)
    );
    footer.appendChild(button('Disconnect', 'secondary', disconnect));
    return footer;
  }

  function sectionBlock(title, compact = false) {
    const section = element(
      'section',
      `company-section${compact ? ' compact' : ''}`
    );
    section.appendChild(element('h3', '', title));
    return section;
  }

  function labelledText(label, value) {
    const wrapper = element('div', 'company-labelled-text');
    wrapper.appendChild(element('span', '', label));
    wrapper.appendChild(element('p', '', value || 'Not yet clear'));
    return wrapper;
  }

  function card(title, description, actions = []) {
    const wrapper = element('section', 'company-empty-card');
    wrapper.appendChild(element('h3', '', title));
    wrapper.appendChild(element('p', '', description));
    actions.forEach((action) => wrapper.appendChild(action));
    return wrapper;
  }

  function button(label, tone, handler) {
    const control = element('button', `btn ${tone}`, label);
    control.type = 'button';
    control.disabled = busy;
    control.addEventListener('click', handler);
    return control;
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = String(text);
    return node;
  }

  function updateButtons() {
    if (connectButton) {
      connectButton.disabled = busy;
      connectButton.textContent = hasConnection() ? 'Settings' : 'Connect';
    }
    if (refreshButton) {
      refreshButton.disabled = busy || !hasConnection();
      refreshButton.textContent = busy ? 'Refreshing...' : 'Refresh';
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(() => {
      if (active && document.visibilityState !== 'hidden') {
        refresh({ announce: false });
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function hasConnection() {
    return Boolean(localStorage.getItem(TOKEN_KEY));
  }

  function getSettings() {
    return normalizeCompanyOperatorSettings(readLocalJson(SETTINGS_KEY));
  }

  async function readRemoteJson(path, { allowMissing = false } = {}) {
    const settings = getSettings();
    const response = await fetch(githubContentsUrl(settings, path), {
      cache: 'no-store',
      headers: githubHeaders()
    });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    const metadata = await response.json();
    return {
      payload: decodeGitHubJson(metadata.content),
      sha: String(metadata.sha || '')
    };
  }

  async function writeRemoteJson(path, payload, message) {
    const settings = getSettings();
    const response = await fetch(githubContentsUrl(settings, path, false), {
      method: 'PUT',
      cache: 'no-store',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        branch: settings.branch,
        content: encodeGitHubJson(payload)
      })
    });
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    return response.json();
  }

  function githubHeaders() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function githubContentsUrl(settings, path, includeRef = true) {
    const repository = settings.repository
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const encodedPath = String(path || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
    const base = `https://api.github.com/repos/${repository}/contents/${encodedPath}`;
    return includeRef
      ? `${base}?ref=${encodeURIComponent(settings.branch)}`
      : base;
  }

  function decodeGitHubJson(content) {
    const binary = atob(String(content || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function encodeGitHubJson(payload) {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(payload, null, 2)}\n`
    );
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function loadSnapshot() {
    return normalizeCompanyOperatorSnapshot(readLocalJson(SNAPSHOT_KEY));
  }

  function loadPending() {
    const value = readLocalJson(PENDING_KEY);
    return Array.isArray(value) ? value.filter((item) => item?.commandId) : [];
  }

  function savePending(value) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(value.slice(-30)));
  }

  function loadReceipts() {
    const value = readLocalJson(RECEIPTS_KEY);
    return Array.isArray(value) ? value.filter((item) => item?.commandId) : [];
  }

  function saveReceipts(value) {
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(value.slice(-30)));
  }

  function readLocalJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  render();
  return { setActive, refresh, render };
}

function companyErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (message.includes('github_http_401')) {
    return 'The private Company token is not valid.';
  }
  if (message.includes('github_http_403')) {
    return 'The token does not have access to the private Company workspace.';
  }
  if (message.includes('github_http_404')) {
    return 'The private Company workspace is not ready yet.';
  }
  return 'Company information could not be refreshed. Your TimeKeeper data is unaffected.';
}

function safeRemoteDispatch(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    status: String(source.status || '').slice(0, 60),
    summary: String(source.summary || '').slice(0, 500),
    outcomeStatus: String(
      source.outcome_status || source.outcomeStatus || ''
    ).slice(0, 60),
    requiresDecision:
      source.requires_decision === true || source.requiresDecision === true,
    recommendedNextAction: String(
      source.recommended_next_action || source.recommendedNextAction || ''
    ).slice(0, 500),
    model: String(source.model || '').slice(0, 100),
    reasoningEffort: String(
      source.reasoning_effort || source.reasoningEffort || ''
    ).slice(0, 30),
    modelRoutingTier: String(
      source.model_routing_tier || source.modelRoutingTier || ''
    ).slice(0, 40),
    executionRepo: String(
      source.execution_repo || source.executionRepo || ''
    ).slice(0, 120),
    sessionId: String(source.session_id || source.sessionId || '').slice(
      0,
      140
    ),
    durationSeconds: Math.max(
      0,
      Math.round(Number(source.duration_seconds || source.durationSeconds) || 0)
    ),
    timeTrackingStatus: String(
      source.time_tracking_status || source.timeTrackingStatus || ''
    ).slice(0, 80)
  };
}

function formatDispatchDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function displaySource(value) {
  const labels = {
    outlook: 'Outlook',
    slack: 'Slack',
    local_docs: 'Documents',
    timekeeper: 'Time tracking',
    zoom: 'Meetings',
    crm: 'CRM',
    website: 'Website',
    sharepoint: 'SharePoint'
  };
  return labels[value] || String(value || 'Source');
}
