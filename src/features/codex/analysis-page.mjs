import { buildCodexAnalytics } from './analytics.mjs';

const TIMEKEEPER_DATA_KEY = 'timekeeperDataPro';
const USAGE_HISTORY_URL = new URL(
  '../../../assets/timekeeper-codex-usage-history.json',
  import.meta.url
);
const RANGE_OPTIONS = [1, 7, 30, 90];

const state = {
  rangeDays: 7,
  analytics: null,
  data: null,
  usageHistory: []
};

function byId(id) {
  return document.getElementById(id);
}

function readTimekeeperData() {
  try {
    const raw = localStorage.getItem(TIMEKEEPER_DATA_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('Unable to read TimeKeeper data:', error);
    return null;
  }
}

function normalizeUsageHistoryPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.samples)) return payload.samples;
  return [];
}

function getCurrentUsageSample(data) {
  const integration = data?.codexIntegration;
  const usageLimits =
    integration?.usageLimits ||
    integration?.lastUsageLimits ||
    data?.codexUsageLimits;
  if (!usageLimits || typeof usageLimits !== 'object') return null;
  return {
    observedAt:
      usageLimits.observedAt ||
      integration.lastUsageAt ||
      integration.lastImportAt ||
      new Date().toISOString(),
    primary: usageLimits.primary || null,
    secondary: usageLimits.secondary || null,
    sourceMachineId: 'browser-cache'
  };
}

async function loadUsageHistory(data) {
  let samples = [];
  try {
    const response = await fetch(`${USAGE_HISTORY_URL}?v=${Date.now()}`, {
      cache: 'no-store'
    });
    if (response.ok) {
      samples = normalizeUsageHistoryPayload(await response.json());
    }
  } catch (error) {
    console.warn('Unable to load Codex usage history:', error);
  }
  const current = getCurrentUsageSample(data);
  if (current) samples.push(current);
  return samples;
}

function formatNumber(value, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '—';
}

function formatPercent(value, decimals = 0) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : '—';
}

function formatHours(value, decimals = 1) {
  return Number.isFinite(value) ? `${value.toFixed(decimals)} h` : '—';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function titleCase(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function makeElement(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function renderMeasurementBanner(analytics) {
  const banner = byId('measurementBanner');
  banner.className = `measurement-banner ${analytics.measurementState}`;
  banner.replaceChildren();
  const title = makeElement('strong');
  const detail = makeElement('span');
  if (analytics.measurementState === 'ready') {
    title.textContent = 'Measured quota efficiency';
    detail.textContent =
      'Usage rates are based on reset-safe quota changes aligned with imported Codex activity.';
  } else if (analytics.measurementState === 'partial') {
    title.textContent = 'Preliminary quota efficiency';
    detail.textContent =
      'The model rankings are usable, but history or activity attribution is still incomplete. Treat low-confidence rows as directional.';
  } else {
    title.textContent = 'Collecting usage history';
    detail.textContent =
      'Time and focus metrics are available now. Usage-per-hour and effective-time-per-usage will appear after at least two quota snapshots have been collected.';
  }
  banner.append(title, detail);
}

function renderMetricCards(analytics) {
  const cards = byId('metricCards');
  cards.replaceChildren();
  const metrics = [
    {
      label: 'Primary quota',
      value: Number.isFinite(analytics.overall.latestUsedPercent)
        ? `${analytics.overall.latestUsedPercent.toFixed(0)}% used`
        : 'Unavailable',
      detail: analytics.overall.resetsAt
        ? `Resets ${formatDateTime(analytics.overall.resetsAt)}`
        : 'Waiting for a quota snapshot'
    },
    {
      label: 'Quota burn',
      value: Number.isFinite(analytics.overall.burnPerDay)
        ? `${analytics.overall.burnPerDay.toFixed(2)} pts/day`
        : 'Collecting',
      detail: Number.isFinite(analytics.overall.projectedUsedAtReset)
        ? `${analytics.overall.projectedUsedAtReset.toFixed(0)}% projected at reset`
        : 'Needs a measured interval'
    },
    {
      label: 'Effective yield',
      value: Number.isFinite(analytics.overall.effectiveHoursPerUsagePoint)
        ? `${analytics.overall.effectiveHoursPerUsagePoint.toFixed(2)} h/pt`
        : 'Collecting',
      detail: 'Effective hours per quota percentage point'
    },
    {
      label: 'Attributed usage',
      value: formatPercent(analytics.overall.attributionRate),
      detail: `${formatNumber(analytics.overall.attributedUsagePoints, 2)} of ${formatNumber(
        analytics.overall.totalUsagePoints,
        2
      )} quota points`
    },
    {
      label: 'Effective time',
      value: formatHours(analytics.overall.totalEffectiveHours),
      detail: `${formatHours(analytics.overall.totalWallHours)} active · ${formatPercent(
        analytics.overall.focusConversion
      )} credited`
    },
    {
      label: 'Session shape',
      value: Number.isFinite(analytics.overall.medianSessionMinutes)
        ? `${analytics.overall.medianSessionMinutes.toFixed(0)} min median`
        : 'No sessions',
      detail: `${formatNumber(
        analytics.overall.sessionsPerEffectiveHour,
        2
      )} sessions/effective hour`
    }
  ];
  metrics.forEach((metric) => {
    const card = makeElement('article', 'metric-card');
    card.append(
      makeElement('span', 'metric-label', metric.label),
      makeElement('strong', 'metric-value', metric.value),
      makeElement('small', 'metric-detail', metric.detail)
    );
    cards.appendChild(card);
  });
}

function renderInsights(analytics) {
  const container = byId('insights');
  container.replaceChildren();
  if (!analytics.insights.length) {
    container.appendChild(
      makeElement(
        'p',
        'empty-state',
        'No measured efficiency findings yet. The page will populate as quota history accumulates.'
      )
    );
    return;
  }
  analytics.insights.forEach((insight) => {
    const card = makeElement('article', `insight ${insight.tone}`);
    card.append(
      makeElement('strong', '', insight.title),
      makeElement('span', '', insight.detail)
    );
    container.appendChild(card);
  });
}

function confidenceBadge(confidence) {
  return `<span class="confidence ${confidence}">${titleCase(confidence)}</span>`;
}

function formatCell(column, row) {
  const value = row[column.key];
  if (column.format) return column.format(value, row);
  return value ?? '—';
}

function renderTable(containerId, rows, columns, emptyMessage) {
  const container = byId(containerId);
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(makeElement('p', 'empty-state', emptyMessage));
    return;
  }
  const wrapper = makeElement('div', 'table-scroll');
  const table = makeElement('table', 'analysis-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => {
    const header = document.createElement('th');
    header.textContent = column.label;
    if (column.title) header.title = column.title;
    headRow.appendChild(header);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const cell = document.createElement('td');
      const formatted = formatCell(column, row);
      if (column.html) {
        cell.innerHTML = String(formatted);
      } else {
        cell.textContent = String(formatted);
      }
      if (column.numeric) cell.className = 'numeric';
      tr.appendChild(cell);
    });
    body.appendChild(tr);
  });
  table.append(head, body);
  wrapper.appendChild(table);
  container.appendChild(wrapper);
}

const efficiencyColumns = [
  { key: 'label', label: 'Model' },
  {
    key: 'effectiveHours',
    label: 'Effective',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'wallHours',
    label: 'Active',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'usagePoints',
    label: 'Quota used',
    title: 'Percentage points consumed in the measured primary limit window',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} pts` : '—'
  },
  {
    key: 'usagePerWallHour',
    label: 'Usage / active h',
    title: 'Lower is more quota-efficient',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} pts/h` : '—'
  },
  {
    key: 'effectiveHoursPerUsagePoint',
    label: 'Effective h / usage',
    title: 'Higher is more quota-efficient',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} h/pt` : '—'
  },
  {
    key: 'focusConversion',
    label: 'Focus conversion',
    numeric: true,
    format: (value) => formatPercent(value)
  },
  {
    key: 'sessions',
    label: 'Sessions',
    numeric: true,
    format: (value) => String(value)
  },
  {
    key: 'confidence',
    label: 'Confidence',
    html: true,
    format: (value) => confidenceBadge(value)
  }
];

function renderTables(analytics) {
  const modelRows = analytics.byModel
    .slice()
    .sort((left, right) => {
      if (
        Number.isFinite(left.usagePerWallHour) &&
        Number.isFinite(right.usagePerWallHour)
      ) {
        return right.usagePerWallHour - left.usagePerWallHour;
      }
      return right.effectiveHours - left.effectiveHours;
    });
  renderTable(
    'modelTable',
    modelRows,
    efficiencyColumns,
    'No imported Codex model activity exists in this range.'
  );
  renderTable(
    'modelEffortTable',
    analytics.byModelEffort,
    [
      { ...efficiencyColumns[0], label: 'Model · effort' },
      ...efficiencyColumns.slice(1)
    ],
    'No model-and-effort breakdown is available.'
  );
  renderTable(
    'projectTable',
    analytics.byProject,
    [
      { ...efficiencyColumns[0], label: 'Project' },
      ...efficiencyColumns.slice(1)
    ],
    'No project-level Codex activity exists in this range.'
  );
  renderTable(
    'dailyTable',
    analytics.daily.slice(-14).reverse(),
    [
      { key: 'date', label: 'Date' },
      {
        key: 'effectiveHours',
        label: 'Effective',
        numeric: true,
        format: (value) => formatHours(value)
      },
      {
        key: 'wallHours',
        label: 'Active',
        numeric: true,
        format: (value) => formatHours(value)
      },
      {
        key: 'usagePoints',
        label: 'Quota used',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} pts` : '—'
      },
      {
        key: 'usagePerWallHour',
        label: 'Usage / active h',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} pts/h` : '—'
      }
    ],
    'Daily measurements will appear once usage history accumulates.'
  );
}

function renderDataQuality(analytics) {
  const container = byId('dataQuality');
  container.replaceChildren();
  const rows = [
    ['Quota snapshots', String(analytics.coverage.sampleCount)],
    ['Measured intervals', String(analytics.coverage.intervalCount)],
    ['Measurement coverage', formatPercent(analytics.coverage.timeCoverage)],
    ['Quota attribution', formatPercent(analytics.overall.attributionRate)],
    ['Unknown model time', formatPercent(analytics.overall.unknownModelShare)],
    [
      'Mixed-model sessions',
      formatPercent(analytics.overall.mixedModelSessionShare)
    ],
    [
      'Subagent active-time share',
      formatPercent(analytics.overall.subagentWallShare)
    ],
    [
      'Skipped large snapshot gaps',
      String(analytics.coverage.skippedLargeGaps)
    ],
    [
      'Detected reset transitions',
      String(analytics.coverage.resetTransitions)
    ]
  ];
  rows.forEach(([label, value]) => {
    const row = makeElement('div', 'quality-row');
    row.append(
      makeElement('span', '', label),
      makeElement('strong', '', value)
    );
    container.appendChild(row);
  });
}

function updateRangeControls() {
  const container = byId('rangeControls');
  container.replaceChildren();
  RANGE_OPTIONS.forEach((rangeDays) => {
    const button = makeElement(
      'button',
      rangeDays === state.rangeDays ? 'range-button active' : 'range-button',
      rangeDays === 1 ? '24h' : `${rangeDays}d`
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      state.rangeDays = rangeDays;
      updateRangeControls();
      render();
    });
    container.appendChild(button);
  });
}

function buildCsv(analytics) {
  const headers = [
    'model',
    'effective_hours',
    'active_hours',
    'quota_points',
    'quota_points_per_active_hour',
    'effective_hours_per_quota_point',
    'focus_conversion',
    'sessions',
    'confidence'
  ];
  const rows = analytics.byModel.map((row) => [
    row.label,
    row.effectiveHours,
    row.wallHours,
    row.usagePoints,
    row.usagePerWallHour ?? '',
    row.effectiveHoursPerUsagePoint ?? '',
    row.focusConversion ?? '',
    row.sessions,
    row.confidence
  ]);
  return [headers, ...rows]
    .map((row) =>
      row
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(',')
    )
    .join('\n');
}

function exportCsv() {
  if (!state.analytics) return;
  const blob = new Blob([buildCsv(state.analytics)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `timekeeper-codex-analysis-${state.rangeDays}d.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function render() {
  if (!state.data) return;
  const analytics = buildCodexAnalytics({
    entries: state.data.entries || [],
    projects: state.data.projects || [],
    usageHistory: state.usageHistory,
    rangeDays: state.rangeDays,
    now: new Date()
  });
  state.analytics = analytics;
  byId('rangeLabel').textContent =
    state.rangeDays === 1 ? 'Last 24 hours' : `Last ${state.rangeDays} days`;
  byId('updatedAt').textContent = `Calculated ${formatDateTime(
    analytics.generatedAt
  )}`;
  renderMeasurementBanner(analytics);
  renderMetricCards(analytics);
  renderInsights(analytics);
  renderTables(analytics);
  renderDataQuality(analytics);
}

async function initialize() {
  updateRangeControls();
  byId('exportCsv').addEventListener('click', exportCsv);
  byId('refreshAnalysis').addEventListener('click', () =>
    window.location.reload()
  );
  state.data = readTimekeeperData();
  if (!state.data) {
    byId('loadingState').className = 'fatal-state';
    byId('loadingState').textContent =
      'No TimeKeeper browser data was found. Open TimeKeeper on this same origin and import Codex activity first.';
    byId('analysisContent').hidden = true;
    return;
  }
  state.usageHistory = await loadUsageHistory(state.data);
  byId('loadingState').hidden = true;
  byId('analysisContent').hidden = false;
  render();
}

initialize().catch((error) => {
  console.error(error);
  byId('loadingState').className = 'fatal-state';
  byId('loadingState').textContent =
    `Codex analysis failed: ${error.message || error}`;
});
