import { uuid } from '../../shared/id.mjs';
import { openFormDialog, requestConfirm, showToast } from '../../shared/ui.mjs';
import {
  OUTREACH_PATHS,
  buildOutreachCommand,
  normalizeOutreachSnapshot,
  outreachDate,
  outreachGroup
} from './core.mjs';

const SETTINGS = 'timekeeperCompanyOperatorSettings';
const TOKEN = 'timekeeperCompanyOperatorToken';
const CACHE = 'timekeeperOutreachSnapshot';
const PENDING = 'timekeeperOutreachPendingCommands';
const RECEIPTS = 'timekeeperOutreachReceipts';
const REPOSITORY = 'Henrik-KM/timekeeper-private-context';
const GROUPS = [
  ['needs', 'Needs you'],
  ['planned', 'Planned'],
  ['active', 'Active'],
  ['results', 'Results']
];
function el(tag, className = '', content = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function button(label, action, secondary = true) {
  const node = el('button', 'btn' + (secondary ? ' secondary' : ''), label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function link(label, href) {
  const node = el('a', 'outreach-source', label);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

export function createOutreachController({
  root,
  connectButton,
  refreshButton
}) {
  let snapshot = normalizeOutreachSnapshot(load(CACHE, null));
  let busy = false;
  let timer = null;
  let selected = 'needs';
  let search = '';
  let refreshError = '';
  connectButton?.addEventListener('click', configure);
  refreshButton?.addEventListener('click', () => refresh(true));
  function hasConnection() {
    return Boolean(localStorage.getItem(TOKEN));
  }
  function settings() {
    const old = load(SETTINGS, {});
    return {
      repository: old.repository || REPOSITORY,
      branch: old.branch || 'main'
    };
  }
  async function api(path, body = null, missing = false) {
    const config = settings();
    if (config.repository !== REPOSITORY)
      throw new Error('Use the existing private TimeKeeper repository.');
    const endpoint =
      'https://api.github.com/repos/' +
      config.repository +
      '/contents/' +
      path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(
      endpoint + (body ? '' : '?ref=' + encodeURIComponent(config.branch)),
      {
        method: body ? 'PUT' : 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + localStorage.getItem(TOKEN),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      }
    );
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? 'The first outreach update is not ready yet.'
          : 'The private connection needs attention. Check Connection.'
      );
    return response.json();
  }
  async function read(path, missing = false) {
    const row = await api(path, null, missing);
    if (!row) return null;
    if (typeof row.content !== 'string' || row.content.length > 400000)
      throw new Error('Invalid outreach update.');
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(row.content.replace(/\s/g, '')), (c) =>
          c.charCodeAt(0)
        )
      )
    );
  }
  async function write(path, command) {
    let binary = '';
    new TextEncoder().encode(JSON.stringify(command)).forEach((value) => {
      binary += String.fromCharCode(value);
    });
    return api(path, {
      message: 'Queue private outreach control',
      branch: settings().branch,
      content: btoa(binary)
    });
  }
  async function refresh(announce = false) {
    if (busy || !hasConnection()) {
      render();
      return;
    }
    busy = true;
    try {
      const raw = await read(OUTREACH_PATHS.state);
      const next = normalizeOutreachSnapshot(raw);
      if (!next) throw new Error('The outreach update could not be read.');
      snapshot = next;
      save(CACHE, raw);
      refreshError = '';
      const pending = load(PENDING, []),
        outstanding = [],
        receipts = load(RECEIPTS, []);
      for (const command of pending.slice(-30)) {
        const receipt = await read(
          OUTREACH_PATHS.receipts + '/' + command.command_id + '.json',
          true
        );
        if (receipt) receipts.push({ ...receipt, label: command.label });
        else outstanding.push(command);
      }
      save(PENDING, outstanding);
      save(RECEIPTS, receipts.slice(-15));
      if (announce) showToast('Outreach refreshed.');
    } catch (error) {
      refreshError = error.message;
      if (announce) showToast(refreshError);
    } finally {
      busy = false;
      render();
    }
  }
  async function configure() {
    const values = await openFormDialog({
      title: hasConnection() ? 'Outreach connection' : 'Connect outreach',
      fields: [
        {
          name: 'repository',
          label: 'Private repository',
          value: settings().repository,
          required: true
        },
        {
          name: 'token',
          label: hasConnection()
            ? 'New token (leave blank to keep current)'
            : 'Fine-grained GitHub token',
          type: 'password',
          value: '',
          required: !hasConnection()
        }
      ],
      submitLabel: 'Connect'
    });
    if (!values) return;
    if (values.repository.trim() !== REPOSITORY) {
      showToast('Use the existing private TimeKeeper repository.');
      return;
    }
    save(SETTINGS, {
      ...load(SETTINGS, {}),
      repository: REPOSITORY,
      branch: 'main'
    });
    if (values.token.trim()) localStorage.setItem(TOKEN, values.token.trim());
    await refresh(true);
  }
  async function disconnect() {
    if (
      !(await requestConfirm({
        title: 'Disconnect outreach?',
        message: 'Remove the connection and cached view from this device?',
        confirmLabel: 'Disconnect',
        danger: true
      }))
    )
      return;
    [TOKEN, CACHE, PENDING, RECEIPTS].forEach((key) =>
      localStorage.removeItem(key)
    );
    snapshot = null;
    render();
  }
  async function queue(action, row = null) {
    if (busy || !snapshot) return;
    if (
      action === 'suppress' &&
      !(await requestConfirm({
        title: 'Exclude this contact?',
        message: 'Stop future outreach to ' + row.contact + '.',
        confirmLabel: 'Exclude contact'
      }))
    )
      return;
    if (
      action === 'release' &&
      !(await requestConfirm({
        title: 'Release this contact?',
        message:
          'Allow eligible LinkedIn messages again. A new personal message takes over.',
        confirmLabel: 'Release contact'
      }))
    )
      return;
    busy = true;
    render();
    try {
      const command = buildOutreachCommand({
        action,
        commandId: 'outreach-' + uuid(),
        snapshot,
        personId: row?.personId || '',
        until:
          action === 'snooze'
            ? new Date(Date.now() + 7 * 86400000).toISOString()
            : ''
      });
      await write(
        OUTREACH_PATHS.commands + '/' + command.command_id + '.json',
        command
      );
      save(PENDING, [
        ...load(PENDING, []),
        { ...command, label: row?.contact || 'Outreach' }
      ]);
      showToast('Control queued for the next run.');
    } catch (error) {
      showToast(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  function render() {
    if (!root) return;
    root.replaceChildren();
    if (connectButton)
      connectButton.textContent = hasConnection() ? 'Connection' : 'Connect';
    if (refreshButton) refreshButton.disabled = busy || !hasConnection();
    if (!hasConnection() || !snapshot) {
      const card = el('section', 'company-empty-card');
      card.append(
        el(
          'h3',
          '',
          hasConnection()
            ? 'Waiting for the first outreach run'
            : 'Connect outreach'
        ),
        el(
          'p',
          '',
          refreshError ||
            (hasConnection()
              ? 'Your private connection is saved.'
              : 'Use your private TimeKeeper connection to see customer conversations and next steps.')
        ),
        button(
          hasConnection() ? 'Refresh' : 'Connect outreach',
          hasConnection() ? () => refresh(true) : configure,
          false
        )
      );
      root.append(card);
      return;
    }
    const overview = el('section', 'outreach-overview');
    const status = el('div', 'outreach-status-line');
    status.append(
      el(
        'strong',
        '',
        snapshot.status === 'paused'
          ? 'Paused'
          : snapshot.linkedinBlocked
            ? 'LinkedIn needs access'
            : snapshot.status === 'attention_required'
              ? 'Needs attention'
              : 'Scheduled'
      ),
      el(
        'span',
        '',
        'Next run ' + outreachDate(snapshot.nextRunAt) + ' · Berlin'
      )
    );
    const pendingGlobal = load(PENDING, []).some((item) =>
      ['pause', 'resume'].includes(item.action)
    );
    const pause = button(
      pendingGlobal
        ? 'Control queued'
        : snapshot.status === 'paused'
          ? 'Resume outreach'
          : 'Pause outreach',
      () => queue(snapshot.status === 'paused' ? 'resume' : 'pause')
    );
    pause.disabled = busy || pendingGlobal;
    status.append(pause);
    overview.append(status);
    if (snapshot.linkedinBlocked)
      overview.append(
        el(
          'p',
          'outreach-access-note',
          'LinkedIn is waiting for browser access. Customer emails stay in Outlook Drafts.'
        )
      );
    if (refreshError)
      overview.append(el('p', 'outreach-access-note', refreshError));
    overview.append(
      el(
        'p',
        'outreach-updated',
        'Updated ' +
          outreachDate(snapshot.generatedAt) +
          ' · Remaining today: ' +
          snapshot.remaining.linkedin +
          ' LinkedIn messages, ' +
          snapshot.remaining.email +
          ' drafts'
      )
    );
    const metrics = el('div', 'outreach-metrics');
    [
      ['Verified messages', snapshot.counts.messages],
      ['Prepared drafts', snapshot.counts.drafts],
      ['Interested customers', snapshot.counts.interested],
      ['Emails you sent', snapshot.counts.sentEmails]
    ].forEach(([name, value]) => {
      const item = el('div', 'outreach-metric');
      item.append(
        el('strong', '', String(value)),
        el('span', '', String(name))
      );
      metrics.append(item);
    });
    overview.append(metrics);
    root.append(overview);
    const toolbar = el('div', 'outreach-toolbar'),
      tabs = el('div', 'outreach-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Outreach views');
    GROUPS.forEach(([key, name], index) => {
      const total = snapshot.opportunities.filter(
        (row) => outreachGroup(row) === key
      ).length;
      const tab = button(name + ' (' + total + ')', () => {
        selected = key;
        render();
        root.querySelector('[aria-selected="true"]')?.focus();
      });
      tab.setAttribute('role', 'tab');
      tab.id = 'outreach-tab-' + key;
      tab.setAttribute('aria-selected', String(selected === key));
      tab.setAttribute('aria-controls', 'outreach-view');
      tab.tabIndex = selected === key ? 0 : -1;
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        selected =
          GROUPS[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? 3
                : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4
          ][0];
        render();
        root.querySelector('[aria-selected="true"]')?.focus();
      });
      tabs.append(tab);
    });
    const input = el('input', 'outreach-search');
    input.type = 'search';
    input.placeholder = 'Find a company or contact';
    input.setAttribute('aria-label', 'Search outreach');
    input.value = search;
    input.addEventListener('input', () => {
      search = input.value;
      renderRows();
    });
    toolbar.append(tabs, input);
    root.append(toolbar);
    const view = el('section', 'outreach-cards');
    view.id = 'outreach-view';
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', 'outreach-tab-' + selected);
    root.append(view);
    renderRows();
    const pending = load(PENDING, []),
      receipts = load(RECEIPTS, []).slice(-5);
    if (pending.length || receipts.length) {
      const controls = el('section', 'outreach-control-status');
      controls.append(el('h3', '', 'Controls'));
      pending.forEach((row) =>
        controls.append(el('p', '', row.label + ' · Queued'))
      );
      receipts.forEach((row) =>
        controls.append(
          el(
            'p',
            '',
            row.label +
              ' · ' +
              (row.status === 'applied' ? 'Applied' : 'Refresh and try again')
          )
        )
      );
      root.append(controls);
    }
    const footer = el('div', 'company-connection-footer');
    footer.append(button('Disconnect', disconnect));
    root.append(footer);
  }
  function renderRows() {
    const view = root.querySelector('#outreach-view');
    if (!view || !snapshot) return;
    view.replaceChildren();
    const query = search.toLocaleLowerCase();
    const rows = snapshot.opportunities.filter(
      (row) =>
        outreachGroup(row) === selected &&
        (!query ||
          (row.company + ' ' + row.contact + ' ' + row.need)
            .toLocaleLowerCase()
            .includes(query))
    );
    if (!rows.length)
      view.append(
        el(
          'p',
          'outreach-empty-state',
          query
            ? 'No matching conversations.'
            : {
                needs: 'Nothing needs your attention.',
                planned: 'No qualified outreach is queued.',
                active: 'No active conversations yet.',
                results: 'No closed conversations yet.'
              }[selected]
        )
      );
    rows.forEach((row) => {
      const card = el('article', 'outreach-card');
      card.append(
        el('h3', '', row.company),
        el(
          'p',
          'outreach-contact',
          row.contact + (row.role ? ' · ' + row.role : '')
        )
      );
      const badges = el('div', 'outreach-badges');
      [
        row.channel,
        row.humanOwned ? 'You own LinkedIn' : '',
        row.interested ? 'Interested' : '',
        row.suppressed ? 'Excluded' : ''
      ]
        .filter(Boolean)
        .forEach((value) => badges.append(el('span', '', value)));
      card.append(badges);
      if (selected === 'needs' && row.attention)
        card.append(el('p', 'outreach-attention', row.attention));
      if (row.need) card.append(el('p', '', row.need));
      if (row.latestOutcome)
        card.append(el('p', 'outreach-outcome', row.latestOutcome));
      if (row.nextStep) {
        const next = el('p', 'outreach-next');
        next.append(
          el('strong', '', 'Next: '),
          document.createTextNode(row.nextStep)
        );
        card.append(next);
      }
      if (row.dueAt)
        card.append(
          el(
            'p',
            'outreach-updated',
            'Follow-up ' + outreachDate(row.dueAt, false)
          )
        );
      const details = el('details', 'outreach-details');
      details.append(el('summary', '', 'Context and controls'));
      if (row.whyNow) details.append(el('p', '', row.whyNow));
      if (row.offer) details.append(el('p', '', row.offer));
      const links = el('div', 'outreach-links');
      if (row.sourceUrl) links.append(link('Source', row.sourceUrl));
      if (row.profileUrl)
        links.append(link('LinkedIn profile', row.profileUrl));
      details.append(links);
      if (!row.suppressed) {
        const actions = el('div', 'company-action-grid'),
          waiting = load(PENDING, []).some(
            (item) => item.person_id === row.personId
          );
        [
          [
            row.humanOwned ? 'Release LinkedIn' : 'Take over LinkedIn',
            row.humanOwned ? 'release' : 'take_over'
          ],
          ['Snooze 7 days', 'snooze'],
          ['Exclude contact', 'suppress'],
          ['Mark handled', 'mark_handled'],
          ...(row.status === 'parked'
            ? [['Reopen follow-up', 'reactivate']]
            : [])
        ].forEach(([label, action]) => {
          const control = button(label, () => queue(action, row));
          control.disabled = busy || waiting;
          actions.append(control);
        });
        details.append(actions);
        if (waiting)
          details.append(
            el('p', 'outreach-updated', 'Control queued for the next run.')
          );
      }
      card.append(details);
      view.append(card);
    });
    if (selected === 'results') {
      const recent = snapshot.recentActions.filter((row) =>
        ['verified', 'drafted', 'sent_manual'].includes(row.status)
      );
      if (recent.length) {
        const section = el('section', 'outreach-recent');
        section.append(el('h3', '', 'Verified activity'));
        recent.forEach((row) => {
          const opportunity = snapshot.opportunities.find(
            (item) => item.id === row.opportunityId
          );
          section.append(
            el(
              'p',
              '',
              (row.status === 'drafted'
                ? 'Prepared Outlook draft'
                : row.status === 'sent_manual'
                  ? 'Email sent by you'
                  : 'LinkedIn message sent') +
                (opportunity ? ' · ' + opportunity.company : '') +
                ' · ' +
                outreachDate(row.date)
            )
          );
        });
        view.append(section);
      }
    }
  }
  function setActive(value) {
    if (timer) clearInterval(timer);
    timer = null;
    if (value === true) {
      render();
      refresh();
      timer = setInterval(() => refresh(), 60000);
    }
  }
  return {
    setActive,
    render,
    refresh,
    hasConnection,
    getSnapshot: () => snapshot
  };
}
