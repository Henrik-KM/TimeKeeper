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
          queuedAt: new Date().toISOString()
        }
      ]);
      showToast('Queued. The company operator will pick this up shortly.');
    } catch (error) {
      showToast(companyErrorMessage(error));
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  async function addDirection(priority) {
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
      note: values.note
    });
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
    const confirmed = await requestConfirm({
      title: 'Mark this handled?',
      message:
        'This hides the current evidence-backed item. It will reappear automatically if new evidence arrives.',
      confirmLabel: 'Mark handled'
    });
    if (!confirmed) return;
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
        completed.push({
          commandId: item.commandId,
          label: item.label,
          action: item.action,
          status: String(remote.payload.status || 'unknown'),
          reason: String(remote.payload.reason || ''),
          processedAt: String(remote.payload.processed_at || '')
        });
        applied = applied || remote.payload.status === 'applied';
      } catch (error) {
        remaining.push(item);
      }
    }
    savePending(remaining);
    saveReceipts(completed.slice(-30));
    if (applied) showToast('Your Company direction has been applied.');
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
    const primary = snapshot.priorities[0];
    if (primary) root.appendChild(primaryCard(primary));
    root.appendChild(commandStatus());
    if (snapshot.decisions.pending.length) {
      root.appendChild(decisionSection(snapshot.decisions.pending));
    }
    if (snapshot.workProducts.assets.length) {
      root.appendChild(workProductSection(snapshot.workProducts.assets));
    }
    if (snapshot.priorities.length > 1) {
      root.appendChild(prioritySection(snapshot.priorities.slice(1)));
    }
    root.appendChild(handledSection());
    root.appendChild(sourceSection());
    root.appendChild(connectionFooter());
  }

  function statusBanner(freshness) {
    const banner = element('div', `company-status ${freshness.status}`);
    banner.appendChild(element('strong', '', freshness.label));
    banner.appendChild(
      element(
        'span',
        '',
        snapshot.sources.attentionCount
          ? `${snapshot.sources.attentionCount} source updates need attention`
          : 'Company information is connected'
      )
    );
    return banner;
  }

  function primaryCard(priority) {
    const section = element('section', 'company-primary-card');
    section.appendChild(element('p', 'company-eyebrow', 'What matters today'));
    section.appendChild(element('h3', '', priority.project));
    section.appendChild(element('p', 'company-priority-title', priority.title));
    section.appendChild(
      labelledText(
        'Do this next',
        priority.nextAction || snapshot.today.nextAction
      )
    );
    section.appendChild(
      labelledText(
        'Finished when',
        priority.doneWhen || snapshot.today.doneWhen
      )
    );
    if (priority.userDirection) {
      section.appendChild(
        labelledText('Your direction', priority.userDirection)
      );
    }
    const actions = element('div', 'company-action-grid');
    actions.appendChild(
      button('Work on this now', 'primary', () =>
        queuePriorityAction('work_next', priority)
      )
    );
    actions.appendChild(
      button('Add direction', 'secondary', () => addDirection(priority))
    );
    actions.appendChild(button('Pause', 'secondary', () => snooze(priority)));
    actions.appendChild(
      button('Handled', 'secondary', () => markHandled(priority))
    );
    section.appendChild(actions);
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

  function workProductSection(assets) {
    const section = sectionBlock('Prepared for you');
    assets.forEach((asset) => {
      const details = element('details', 'company-work-product');
      const summary = element('summary');
      summary.appendChild(element('strong', '', asset.title));
      summary.appendChild(element('span', '', formatAssetType(asset.format)));
      details.appendChild(summary);
      if (asset.purpose) details.appendChild(element('p', '', asset.purpose));
      if (asset.content) {
        details.appendChild(
          element('div', 'company-work-content', asset.content)
        );
      }
      section.appendChild(details);
    });
    return section;
  }

  function prioritySection(priorities) {
    const section = sectionBlock('Other supported priorities');
    priorities.forEach((priority) => {
      const item = element('article', 'company-list-card');
      item.appendChild(element('p', 'company-eyebrow', priority.project));
      item.appendChild(element('h4', '', priority.title));
      if (priority.nextAction)
        item.appendChild(element('p', '', priority.nextAction));
      item.appendChild(
        button('Make this first', 'secondary', () =>
          queuePriorityAction('set_priority', priority)
        )
      );
      section.appendChild(item);
    });
    return section;
  }

  function commandStatus() {
    const pending = loadPending();
    const receipts = loadReceipts().slice(-5).reverse();
    const section = element('section', 'company-command-status');
    if (pending.length) {
      section.appendChild(
        element(
          'p',
          'company-queued',
          `${pending.length} instruction${pending.length === 1 ? '' : 's'} queued for the desktop operator`
        )
      );
    }
    receipts.forEach((receipt) => {
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

  function handledSection() {
    const section = sectionBlock('Handled for you', true);
    const summary = element(
      'p',
      'company-handled-summary',
      `${snapshot.handled.todayVerifiedActions} useful actions completed today`
    );
    section.appendChild(summary);
    snapshot.handled.receipts.slice(0, 6).forEach((receipt) => {
      const item = element('article', 'company-receipt-card');
      item.appendChild(element('strong', '', receipt.label));
      if (receipt.summary)
        item.appendChild(element('span', '', receipt.summary));
      section.appendChild(item);
    });
    return section;
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
          source.statusText || source.status
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

function formatAssetType(value) {
  const labels = {
    commercial_response_workbook: 'Commercial workbook',
    evidence_backed_decision_brief: 'Decision brief',
    evidence_backed_execution_packet: 'Execution packet'
  };
  return labels[value] || 'Prepared work';
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
