import {
  buildCodexAnalytics,
  rankCodexModelPerformance
} from './analytics.mjs';
import {
  getCodexAnalyticsDataSignature,
  readCodexTopPerformanceCache,
  writeCodexTopPerformanceCache
} from './top-performance-cache.mjs';

const TIMEKEEPER_DATA_KEY = 'timekeeperDataPro';
const USAGE_HISTORY_URL = new URL(
  '../../../assets/timekeeper-codex-usage-history.json',
  import.meta.url
);
const RANGE_OPTIONS = [1, 7, 30, 90];
const CHART_COLORS = [
  '#2563eb',
  '#047857',
  '#b45309',
  '#7c3aed',
  '#be123c',
  '#0891b2'
];

const state = {
  rangeDays: 7,
  windowKey: 'primary',
  analytics: null,
  data: null,
  usageHistory: [],
  filters: {
    model: 'all',
    effort: 'all',
    project: 'all',
    minMeasuredHours: 0,
    minUsagePoints: 0,
    hideUnknown: true
  },
  sort: {
    model: { key: 'usagePerWallHour', direction: 'desc' },
    modelEffort: { key: 'effectiveHours', direction: 'desc' },
    project: { key: 'effectiveHoursPerUsagePoint', direction: 'desc' },
    daily: { key: 'date', direction: 'desc' },
    modelTrend: { key: 'date', direction: 'desc' }
  },
  trend: {
    fastMode: 'all',
    metric: 'effectiveHours',
    minimumSessions: 2
  }
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
      integration?.lastUsageAt ||
      integration?.lastImportAt ||
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
  return Number.isFinite(value) ? value.toFixed(decimals) : '-';
}

function formatPercent(value, decimals = 0) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : '-';
}

function formatQuotaPercent(value, decimals = 0) {
  return Number.isFinite(value) ? `${value.toFixed(decimals)}%` : '-';
}

function formatHours(value, decimals = 1) {
  return Number.isFinite(value) ? `${value.toFixed(decimals)} h` : '-';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
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

function windowHasData(samples, windowKey) {
  return samples.some((sample) => {
    const window = sample?.[windowKey];
    const hasNumber = (value) =>
      value !== null &&
      value !== undefined &&
      value !== '' &&
      Number.isFinite(Number(value));
    return (
      window &&
      (hasNumber(window.usedPercent) || hasNumber(window.remainingPercent))
    );
  });
}

function windowLabel(windowKey) {
  return windowKey === 'secondary'
    ? 'Secondary quota window'
    : 'Primary quota window';
}

function rangeLabel(rangeDays) {
  return rangeDays === 1 ? 'Last 24 hours' : `Last ${rangeDays} days`;
}

function renderMeasurementBanner(analytics) {
  const banner = byId('measurementBanner');
  banner.className = `measurement-banner ${analytics.measurementState}`;
  banner.replaceChildren();
  const title = makeElement('strong');
  const detail = makeElement('span');
  if (analytics.measurementState === 'ready') {
    title.textContent = `Measured ${windowLabel(analytics.windowKey).toLowerCase()}`;
    detail.textContent =
      'Usage rates use reset-safe quota changes aligned with imported Codex activity.';
  } else if (analytics.measurementState === 'partial') {
    title.textContent = 'Preliminary quota efficiency';
    detail.textContent =
      'History or activity attribution is incomplete. Treat low-confidence rows as directional.';
  } else {
    title.textContent = 'Collecting usage history';
    detail.textContent =
      'Time and focus metrics are available now. Efficiency ratios need at least two usable quota snapshots in this window.';
  }
  banner.append(title, detail);
}

function renderMetricCards(analytics) {
  const cards = byId('metricCards');
  cards.replaceChildren();
  const metrics = [
    {
      label: `${titleCase(analytics.windowKey)} quota`,
      value: Number.isFinite(analytics.overall.latestUsedPercent)
        ? `${formatQuotaPercent(analytics.overall.latestUsedPercent)} used`
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
      detail: `${formatHours(analytics.overall.measuredEffectiveHours)} measured effective time`
    },
    {
      label: 'Attributed usage',
      value: formatPercent(analytics.overall.attributionRate),
      detail: `${formatNumber(
        analytics.overall.attributedUsagePoints,
        2
      )} of ${formatNumber(analytics.overall.totalUsagePoints, 2)} quota points`
    },
    {
      label: 'Effective time',
      value: formatHours(analytics.overall.totalEffectiveHours),
      detail: `${formatHours(analytics.overall.totalWallHours)} active - ${formatPercent(
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
  return makeElement('span', `confidence ${confidence}`, titleCase(confidence));
}

function isUnknownRow(row) {
  return [row?.key, row?.label, row?.model, row?.effort]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes('unknown'));
}

function isUnknownTrendRow(row) {
  return [row?.model, row?.effort]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes('unknown'));
}

function applyTrendFilters(analytics) {
  const rows = Array.isArray(analytics?.modelTrends)
    ? analytics.modelTrends
    : [];
  return rows.filter((row) => {
    if (state.filters.hideUnknown && isUnknownTrendRow(row)) return false;
    if (state.filters.model !== 'all' && row.model !== state.filters.model) {
      return false;
    }
    if (state.filters.effort !== 'all' && row.effort !== state.filters.effort) {
      return false;
    }
    if (
      state.trend.fastMode !== 'all' &&
      row.fastMode !== state.trend.fastMode
    ) {
      return false;
    }
    return true;
  });
}

function applyFilters(rows, tableKey) {
  const filters = state.filters;
  return rows.filter((row) => {
    if (filters.hideUnknown && isUnknownRow(row)) return false;
    if (tableKey === 'model' && filters.model !== 'all') {
      if (row.key !== filters.model) return false;
    }
    if (tableKey === 'modelEffort') {
      if (filters.model !== 'all' && row.model !== filters.model) return false;
      if (filters.effort !== 'all' && row.effort !== filters.effort)
        return false;
    }
    if (tableKey === 'project' && filters.project !== 'all') {
      if (row.key !== filters.project) return false;
    }
    if (
      Number.isFinite(filters.minMeasuredHours) &&
      row.measuredWallHours < filters.minMeasuredHours
    ) {
      return false;
    }
    if (
      Number.isFinite(filters.minUsagePoints) &&
      row.usagePoints < filters.minUsagePoints
    ) {
      return false;
    }
    return true;
  });
}

function sortValue(row, key) {
  const value = row?.[key];
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function sortRows(rows, tableKey) {
  const sort = state.sort[tableKey] || { key: 'label', direction: 'asc' };
  return rows.slice().sort((left, right) => {
    const leftValue = sortValue(left, sort.key);
    const rightValue = sortValue(right, sort.key);
    const leftMissing =
      leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing =
      rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing || rightMissing) {
      if (leftMissing && rightMissing) return 0;
      return leftMissing ? 1 : -1;
    }
    const comparison =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return sort.direction === 'asc' ? comparison : -comparison;
  });
}

function formatCell(column, row) {
  const value = row[column.key];
  return column.format ? column.format(value, row) : (value ?? '-');
}

function renderTable(containerId, rows, columns, emptyMessage, tableKey) {
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
  const activeSort = state.sort[tableKey];
  columns.forEach((column) => {
    const header = document.createElement('th');
    const sortKey = column.sortKey || column.key;
    const button = makeElement('button', 'table-sort-button', column.label);
    button.type = 'button';
    button.title = column.title || `Sort by ${column.label}`;
    button.setAttribute(
      'aria-sort',
      activeSort?.key === sortKey
        ? activeSort.direction === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none'
    );
    button.addEventListener('click', () => {
      const current = state.sort[tableKey] || {
        key: sortKey,
        direction: 'asc'
      };
      state.sort[tableKey] = {
        key: sortKey,
        direction:
          current.key === sortKey && current.direction === 'asc'
            ? 'desc'
            : 'asc'
      };
      render();
    });
    header.appendChild(button);
    headRow.appendChild(header);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  sortRows(rows, tableKey).forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const cell = document.createElement('td');
      const formatted = formatCell(column, row);
      if (column.render) {
        cell.appendChild(column.render(formatted, row));
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
  { key: 'label', label: 'Name' },
  {
    key: 'effectiveHours',
    label: 'Effective',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'wallHours',
    label: 'Active',
    title: 'Total active time in the selected range',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'measuredWallHours',
    label: 'Measured active',
    title: 'Active time overlapping quota-history coverage',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'measuredEffectiveHours',
    label: 'Measured effective',
    title: 'Effective time overlapping quota-history coverage',
    numeric: true,
    format: (value) => formatHours(value)
  },
  {
    key: 'usagePoints',
    label: 'Quota used',
    title: 'Percentage points consumed in the selected quota window',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} pts` : '-'
  },
  {
    key: 'usagePerWallHour',
    label: 'Usage / active h',
    title: 'Lower is more quota-efficient',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} pts/h` : '-'
  },
  {
    key: 'effectiveHoursPerUsagePoint',
    label: 'Effective h / usage',
    title: 'Higher is more quota-efficient',
    numeric: true,
    format: (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)} h/pt` : '-'
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
    title:
      'Confidence considers measured time, quota points, and interval count',
    format: (value) => value,
    render: (value) => confidenceBadge(value)
  }
];

function renderTables(analytics) {
  const modelRows = applyFilters(analytics.byModel, 'model');
  const modelEffortRows = applyFilters(analytics.byModelEffort, 'modelEffort');
  const projectRows = applyFilters(analytics.byProject, 'project');
  renderTable(
    'modelTable',
    modelRows,
    efficiencyColumns,
    'No imported Codex model activity exists in this range.',
    'model'
  );
  renderTable(
    'modelEffortTable',
    modelEffortRows,
    [
      { ...efficiencyColumns[0], label: 'Model / effort' },
      ...efficiencyColumns.slice(1)
    ],
    'No model-and-effort breakdown is available.',
    'modelEffort'
  );
  renderTable(
    'projectTable',
    projectRows,
    [
      { ...efficiencyColumns[0], label: 'Project' },
      ...efficiencyColumns.slice(1)
    ],
    'No project-level Codex activity exists in this range.',
    'project'
  );
  renderTable(
    'dailyTable',
    analytics.daily.slice(-14),
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
        key: 'measuredWallHours',
        label: 'Measured active',
        title: 'Active time overlapping quota-history coverage',
        numeric: true,
        format: (value) => formatHours(value)
      },
      {
        key: 'usagePoints',
        label: 'Quota used',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} pts` : '-'
      },
      {
        key: 'usagePerWallHour',
        label: 'Usage / active h',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} pts/h` : '-'
      }
    ],
    'Daily measurements will appear once usage history accumulates.',
    'daily'
  );
  const trendRows = applyTrendFilters(analytics);
  renderTable(
    'modelTrendTable',
    trendRows,
    [
      { key: 'date', label: 'Date' },
      { key: 'model', label: 'Model' },
      { key: 'effort', label: 'Reasoning' },
      {
        key: 'fastMode',
        label: 'Fast mode',
        format: (value) => titleCase(value)
      },
      {
        key: 'effectiveHours',
        label: 'Effective',
        numeric: true,
        format: (value) => formatHours(value)
      },
      {
        key: 'measuredEffectiveHours',
        label: 'Measured effective',
        title: 'Effective time overlapping quota-history coverage',
        numeric: true,
        format: (value) => formatHours(value)
      },
      {
        key: 'usagePoints',
        label: 'Quota used',
        title: 'Percentage points consumed in the selected quota window',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} pts` : '-'
      },
      {
        key: 'effectiveHoursPerUsagePoint',
        label: 'Effective h / quota',
        title: 'Measured effective hours per observed quota percentage point',
        numeric: true,
        format: (value) =>
          Number.isFinite(value) ? `${value.toFixed(2)} h/pt` : '-'
      },
      {
        key: 'sessions',
        label: 'Sessions',
        numeric: true,
        format: (value) => String(value)
      },
      {
        key: 'sampleWarning',
        label: 'Sample',
        title:
          'Rows below the selected minimum-sample threshold are directional',
        render: (value, row) => {
          const warning =
            value ||
            (row.sessions < state.trend.minimumSessions
              ? `Low sample: fewer than ${state.trend.minimumSessions} sessions`
              : 'Sample threshold met');
          const badge = makeElement(
            'span',
            warning.startsWith('Low sample') ? 'trend-warning' : 'trend-ok',
            warning
          );
          badge.title = warning;
          return badge;
        }
      }
    ],
    'No model trend data exists in this range.',
    'modelTrend'
  );
}

function renderDataQuality(analytics) {
  const container = byId('dataQuality');
  container.replaceChildren();
  const rows = [
    ['Window', titleCase(analytics.windowKey)],
    ['Measurement state', titleCase(analytics.measurementState)],
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
    ['Skipped anomalous deltas', String(analytics.coverage.skippedAnomalies)],
    ['Detected reset transitions', String(analytics.coverage.resetTransitions)]
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
    button.setAttribute('aria-pressed', String(rangeDays === state.rangeDays));
    button.addEventListener('click', () => {
      state.rangeDays = rangeDays;
      render();
    });
    container.appendChild(button);
  });
}

function renderWindowControls() {
  const select = /** @type {HTMLSelectElement} */ (byId('windowSelect'));
  const secondaryAvailable = windowHasData(state.usageHistory, 'secondary');
  const options = [
    {
      key: 'primary',
      label: 'Primary quota window',
      available: windowHasData(state.usageHistory, 'primary')
    }
  ];
  if (secondaryAvailable) {
    options.push({
      key: 'secondary',
      label: 'Secondary quota window',
      available: true
    });
  }
  if (!options.some((option) => option.key === state.windowKey)) {
    state.windowKey = options[0].key;
  }
  select.replaceChildren();
  options.forEach((option) => {
    const element = document.createElement('option');
    element.value = option.key;
    element.textContent = option.available
      ? option.label
      : `${option.label} - no snapshots`;
    element.disabled = !option.available;
    select.appendChild(element);
  });
  select.value = state.windowKey;
  select.onchange = () => {
    state.windowKey = select.value;
    render();
  };
}

function setSelectOptions(select, allLabel, rows, valueGetter, labelGetter) {
  const values = new Map();
  rows.forEach((row) => {
    const value = valueGetter(row);
    if (value && !values.has(value)) values.set(value, labelGetter(row));
  });
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = allLabel;
  select.appendChild(all);
  [...values.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
}

function renderFilterControls(analytics) {
  setSelectOptions(
    byId('filterModel'),
    'All models',
    analytics.byModel,
    (row) => row.key,
    (row) => row.label
  );
  setSelectOptions(
    byId('filterEffort'),
    'All efforts',
    analytics.byEffort,
    (row) => row.key,
    (row) => titleCase(row.label)
  );
  setSelectOptions(
    byId('filterProject'),
    'All projects',
    analytics.byProject,
    (row) => row.key,
    (row) => row.label
  );
  const modelFilter = /** @type {HTMLSelectElement} */ (byId('filterModel'));
  const effortFilter = /** @type {HTMLSelectElement} */ (byId('filterEffort'));
  const projectFilter = /** @type {HTMLSelectElement} */ (
    byId('filterProject')
  );
  modelFilter.value = state.filters.model;
  effortFilter.value = state.filters.effort;
  projectFilter.value = state.filters.project;
  modelFilter.onchange = () => {
    state.filters.model = modelFilter.value;
    render();
  };
  effortFilter.onchange = () => {
    state.filters.effort = effortFilter.value;
    render();
  };
  projectFilter.onchange = () => {
    state.filters.project = projectFilter.value;
    render();
  };
  const minMeasured = /** @type {HTMLInputElement} */ (
    byId('minMeasuredHours')
  );
  const minUsage = /** @type {HTMLInputElement} */ (byId('minUsagePoints'));
  const hideUnknown = /** @type {HTMLInputElement} */ (byId('hideUnknown'));
  minMeasured.value = String(state.filters.minMeasuredHours || '');
  minUsage.value = String(state.filters.minUsagePoints || '');
  hideUnknown.checked = state.filters.hideUnknown;
  minMeasured.onchange = () => {
    state.filters.minMeasuredHours = Math.max(
      0,
      Number(minMeasured.value) || 0
    );
    render();
  };
  minUsage.onchange = () => {
    state.filters.minUsagePoints = Math.max(0, Number(minUsage.value) || 0);
    render();
  };
  hideUnknown.onchange = () => {
    state.filters.hideUnknown = hideUnknown.checked;
    render();
  };
  const visible = applyFilters(analytics.byModel, 'model').length;
  byId('filterSummary').textContent =
    `${visible} of ${analytics.byModel.length} model rows shown. Filters affect tables and charts, not the overall totals above.`;
}

function renderTrendControls(analytics) {
  const fastMode = /** @type {HTMLSelectElement} */ (byId('trendFastMode'));
  const metric = /** @type {HTMLSelectElement} */ (byId('trendMetric'));
  const minimumSessions = /** @type {HTMLInputElement} */ (
    byId('trendMinimumSessions')
  );
  const modes = new Set(
    (analytics.modelTrends || []).map((row) => row.fastMode).filter(Boolean)
  );
  fastMode.replaceChildren();
  [
    ['all', 'All Fast modes'],
    ['on', 'Fast on'],
    ['off', 'Fast off'],
    ['unknown', 'Fast unknown']
  ].forEach(([value, label]) => {
    if (value !== 'all' && !modes.has(value)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fastMode.appendChild(option);
  });
  if (
    ![...fastMode.options].some(
      (option) => option.value === state.trend.fastMode
    )
  ) {
    state.trend.fastMode = 'all';
  }
  fastMode.value = state.trend.fastMode;
  fastMode.onchange = () => {
    state.trend.fastMode = fastMode.value;
    render();
  };
  metric.value = state.trend.metric;
  metric.onchange = () => {
    state.trend.metric = metric.value;
    render();
  };
  minimumSessions.value = String(state.trend.minimumSessions);
  minimumSessions.onchange = () => {
    state.trend.minimumSessions = Math.max(
      1,
      Math.floor(Number(minimumSessions.value) || 1)
    );
    render();
  };
  const visibleRows = applyTrendFilters(analytics);
  byId('trendSummary').textContent =
    `${visibleRows.length} trend rows. Rows below ${state.trend.minimumSessions} sessions are marked low sample.`;
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width || 600));
  const height = 230;
  const deviceScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * deviceScale);
  canvas.height = Math.floor(height * deviceScale);
  const context = canvas.getContext('2d');
  context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = '12px system-ui, sans-serif';
  context.lineJoin = 'round';
  return { context, width, height };
}

function drawEmptyChart(canvas, message) {
  const { context, width, height } = prepareCanvas(canvas);
  context.fillStyle = '#64748b';
  context.textAlign = 'center';
  context.fillText(message, width / 2, height / 2);
}

function drawGrid(context, left, top, plotWidth, plotHeight, maxValue, suffix) {
  context.strokeStyle = '#dbe4ef';
  context.fillStyle = '#64748b';
  context.lineWidth = 1;
  context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) {
    const value = (maxValue * index) / 4;
    const y = top + plotHeight - (plotHeight * index) / 4;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(left + plotWidth, y);
    context.stroke();
    context.fillText(`${value.toFixed(1)}${suffix}`, left - 7, y + 4);
  }
}

function truncateLabel(value, maxLength = 16) {
  const label = String(value || '-');
  return label.length > maxLength
    ? `${label.slice(0, maxLength - 1)}...`
    : label;
}

function drawBarChart(canvas, items, emptyMessage, suffix = '') {
  if (!items.length) {
    drawEmptyChart(canvas, emptyMessage);
    return;
  }
  const { context, width, height } = prepareCanvas(canvas);
  const left = 48;
  const top = 14;
  const right = 12;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  drawGrid(context, left, top, plotWidth, plotHeight, maxValue, suffix);
  const slotWidth = plotWidth / items.length;
  const barWidth = Math.max(4, Math.min(44, slotWidth * 0.68));
  items.forEach((item, index) => {
    const x = left + slotWidth * index + (slotWidth - barWidth) / 2;
    const barHeight = (item.value / maxValue) * plotHeight;
    const y = top + plotHeight - barHeight;
    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.fillRect(x, y, barWidth, barHeight);
    if (items.length <= 16) {
      context.fillStyle = '#334155';
      context.textAlign = 'center';
      context.fillText(
        item.value.toFixed(1),
        x + barWidth / 2,
        Math.max(top + 11, y - 5)
      );
    }
    context.save();
    context.translate(x + barWidth / 2, top + plotHeight + 10);
    context.rotate(-Math.PI / 5);
    context.fillStyle = '#64748b';
    context.textAlign = 'right';
    context.fillText(truncateLabel(item.label), 0, 0);
    context.restore();
  });
}

function compactTimeline(intervals, maxItems = 48) {
  if (intervals.length <= maxItems) {
    return intervals.map((interval) => ({
      label: formatDateTime(interval.startAt),
      value: interval.usagePoints
    }));
  }
  const bucketSize = Math.ceil(intervals.length / maxItems);
  const buckets = [];
  for (let index = 0; index < intervals.length; index += bucketSize) {
    const bucket = intervals.slice(index, index + bucketSize);
    buckets.push({
      label: formatDateTime(bucket[0].startAt),
      value: bucket.reduce((total, interval) => total + interval.usagePoints, 0)
    });
  }
  return buckets;
}

function drawQuotaBurnChart(analytics) {
  drawBarChart(
    byId('quotaBurnChart'),
    compactTimeline(analytics.quotaTimeline),
    'Quota burn will appear after usable snapshots accumulate.',
    ' pts'
  );
}

function drawModelYieldChart(analytics) {
  const rows = applyFilters(analytics.byModel, 'model').filter(
    (row) =>
      Number.isFinite(row.usagePerWallHour) &&
      Number.isFinite(row.effectiveHoursPerUsagePoint)
  );
  if (!rows.length) {
    drawEmptyChart(
      byId('modelYieldChart'),
      'Measured model yield is still collecting.'
    );
    return;
  }
  const { context, width, height } = prepareCanvas(byId('modelYieldChart'));
  const left = 48;
  const top = 18;
  const right = 18;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxX = Math.max(1, ...rows.map((row) => row.usagePerWallHour));
  const maxY = Math.max(
    1,
    ...rows.map((row) => row.effectiveHoursPerUsagePoint)
  );
  drawGrid(context, left, top, plotWidth, plotHeight, maxY, ' h');
  context.strokeStyle = '#94a3b8';
  context.beginPath();
  context.moveTo(left, top + plotHeight);
  context.lineTo(left + plotWidth, top + plotHeight);
  context.stroke();
  context.fillStyle = '#64748b';
  context.textAlign = 'center';
  context.fillText(
    'Quota points per measured active hour',
    left + plotWidth / 2,
    height - 8
  );
  rows.forEach((row, index) => {
    const x = left + (row.usagePerWallHour / maxX) * plotWidth;
    const y =
      top + plotHeight - (row.effectiveHoursPerUsagePoint / maxY) * plotHeight;
    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#334155';
    context.textAlign = x > width - 90 ? 'right' : 'left';
    context.fillText(
      truncateLabel(row.label),
      x + (x > width - 90 ? -8 : 8),
      y - 8
    );
  });
}

function drawModelEffortChart(analytics) {
  const rows = applyFilters(analytics.byModelEffort, 'modelEffort')
    .filter(
      (row) => Number.isFinite(row.effectiveHours) && row.effectiveHours > 0
    )
    .slice(0, 24)
    .map((row) => ({ label: row.label, value: row.effectiveHours }));
  drawBarChart(
    byId('modelEffortChart'),
    rows,
    'No model-and-effort time in this range.',
    ' h'
  );
}

function drawProjectEfficiencyChart(analytics) {
  const rows = applyFilters(analytics.byProject, 'project')
    .filter(
      (row) =>
        Number.isFinite(row.effectiveHoursPerUsagePoint) &&
        row.effectiveHoursPerUsagePoint > 0
    )
    .slice(0, 24)
    .map((row) => ({
      label: row.label,
      value: row.effectiveHoursPerUsagePoint
    }));
  drawBarChart(
    byId('projectEfficiencyChart'),
    rows,
    'Project efficiency is still collecting.',
    ' h'
  );
}

function resetMatches(left, right) {
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? Math.abs(leftMs - rightMs) <= 5 * 60 * 1000
    : left === right;
}

function drawQuotaTrajectoryChart(analytics) {
  const points = analytics.quotaTrajectory.filter((point) =>
    Number.isFinite(point.usedPercent)
  );
  if (!points.length) {
    drawEmptyChart(
      byId('quotaTrajectoryChart'),
      'Quota trajectory is still collecting.'
    );
    return;
  }
  const { context, width, height } = prepareCanvas(
    byId('quotaTrajectoryChart')
  );
  const left = 48;
  const top = 14;
  const right = 18;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  drawGrid(context, left, top, plotWidth, plotHeight, 100, '%');
  context.strokeStyle = '#2563eb';
  context.lineWidth = 2;
  points.forEach((point, index) => {
    const x =
      points.length === 1
        ? left + plotWidth / 2
        : left + (index / (points.length - 1)) * plotWidth;
    const y = top + plotHeight - (point.usedPercent / 100) * plotHeight;
    const previous = points[index - 1];
    if (!previous || !resetMatches(previous.resetsAt, point.resetsAt)) {
      context.beginPath();
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
    context.stroke();
    context.fillStyle = '#2563eb';
    context.beginPath();
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
  });
  context.fillStyle = '#64748b';
  context.textAlign = 'left';
  context.fillText(formatDateTime(points[0].observedAt), left, height - 8);
  context.textAlign = 'right';
  context.fillText(
    formatDateTime(points.at(-1).observedAt),
    width - right,
    height - 8
  );
}

function drawModelTrendChart(analytics) {
  const rows = applyTrendFilters(analytics).filter((row) =>
    Number.isFinite(row[state.trend.metric])
  );
  if (!rows.length) {
    drawEmptyChart(
      byId('modelTrendChart'),
      state.trend.metric === 'effectiveHoursPerUsagePoint'
        ? 'Quota efficiency trend is still collecting measured history.'
        : 'No model trend activity exists in this range.'
    );
    return;
  }
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.model}::${row.effort}::${row.fastMode}`;
    const group = groups.get(key) || {
      label: `${titleCase(row.model)} · ${titleCase(row.effort)} · ${titleCase(row.fastMode)}`,
      rows: new Map(),
      total: 0
    };
    group.rows.set(row.date, row);
    group.total += row[state.trend.metric];
    groups.set(key, group);
  });
  const visibleGroups = [...groups.values()]
    .sort((left, right) => right.total - left.total)
    .slice(0, 8);
  const { context, width, height } = prepareCanvas(byId('modelTrendChart'));
  const left = 54;
  const top = 18;
  const right = 18;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(
    1,
    ...visibleGroups.flatMap((group) =>
      [...group.rows.values()].map((row) => row[state.trend.metric])
    )
  );
  drawGrid(
    context,
    left,
    top,
    plotWidth,
    plotHeight,
    maxValue,
    state.trend.metric === 'effectiveHoursPerUsagePoint' ? ' h/pt' : ' h'
  );
  context.textAlign = 'left';
  visibleGroups.forEach((group, groupIndex) => {
    context.strokeStyle = CHART_COLORS[groupIndex % CHART_COLORS.length];
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 2;
    let started = false;
    dates.forEach((date, dateIndex) => {
      const row = group.rows.get(date);
      const value = row?.[state.trend.metric];
      if (!Number.isFinite(value)) {
        started = false;
        return;
      }
      const x =
        dates.length === 1
          ? left + plotWidth / 2
          : left + (dateIndex / (dates.length - 1)) * plotWidth;
      const y = top + plotHeight - (value / maxValue) * plotHeight;
      if (!started) {
        context.beginPath();
        context.moveTo(x, y);
        started = true;
      } else {
        context.lineTo(x, y);
      }
      context.stroke();
      context.beginPath();
      context.arc(x, y, 3, 0, Math.PI * 2);
      context.fill();
    });
    context.fillText(
      truncateLabel(group.label, 28),
      left + 6,
      top + 12 + groupIndex * 13
    );
  });
  context.fillStyle = '#64748b';
  context.textAlign = 'left';
  context.fillText(dates[0], left, height - 8);
  context.textAlign = 'right';
  context.fillText(dates.at(-1), width - right, height - 8);
}

function drawCharts(analytics) {
  drawQuotaBurnChart(analytics);
  drawModelYieldChart(analytics);
  drawModelEffortChart(analytics);
  drawProjectEfficiencyChart(analytics);
  drawQuotaTrajectoryChart(analytics);
  drawModelTrendChart(analytics);
}

export function buildCsv(analytics, rows = analytics?.byModel || []) {
  const headers = [
    'window_key',
    'model',
    'effective_hours',
    'active_hours',
    'measured_active_hours',
    'measured_effective_hours',
    'quota_points',
    'quota_points_per_active_hour',
    'effective_hours_per_quota_point',
    'focus_conversion',
    'sessions',
    'confidence'
  ];
  const values = rows.map((row) => [
    analytics?.windowKey || 'primary',
    row.label,
    row.effectiveHours,
    row.wallHours,
    row.measuredWallHours,
    row.measuredEffectiveHours,
    row.usagePoints,
    row.usagePerWallHour ?? '',
    row.effectiveHoursPerUsagePoint ?? '',
    row.focusConversion ?? '',
    row.sessions,
    row.confidence
  ]);
  return [headers, ...values]
    .map((row) =>
      row
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(',')
    )
    .join('\n');
}

export function buildTrendCsv(analytics, rows = analytics?.modelTrends || []) {
  const headers = [
    'window_key',
    'date',
    'model',
    'reasoning_effort',
    'fast_mode',
    'effective_hours',
    'measured_effective_hours',
    'quota_points',
    'effective_hours_per_quota_point',
    'sessions',
    'confidence',
    'sample_warning'
  ];
  const values = rows.map((row) => [
    analytics?.windowKey || 'primary',
    row.date,
    row.model,
    row.effort,
    row.fastMode,
    row.effectiveHours,
    row.measuredEffectiveHours,
    row.usagePoints,
    row.effectiveHoursPerUsagePoint ?? '',
    row.sessions,
    row.confidence,
    row.sampleWarning || ''
  ]);
  return [headers, ...values]
    .map((row) =>
      row
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(',')
    )
    .join('\n');
}

function exportCsv() {
  if (!state.analytics) return;
  const rows = applyFilters(state.analytics.byModel, 'model');
  const blob = new Blob([buildCsv(state.analytics, rows)], {
    type: 'text/csv'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `timekeeper-codex-analysis-${state.windowKey}-${state.rangeDays}d.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function exportTrendCsv() {
  if (!state.analytics) return;
  const rows = applyTrendFilters(state.analytics);
  const blob = new Blob([buildTrendCsv(state.analytics, rows)], {
    type: 'text/csv'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `timekeeper-codex-model-trend-${state.windowKey}-${state.rangeDays}d.csv`;
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
    windowKey: state.windowKey,
    now: new Date()
  });
  state.analytics = analytics;
  if (state.rangeDays === 7 || state.rangeDays === 30) {
    const signature = getCodexAnalyticsDataSignature(state.data);
    const stored = readCodexTopPerformanceCache();
    const topRows = stored?.signature === signature ? stored.topRows || {} : {};
    topRows[String(state.rangeDays)] = rankCodexModelPerformance(
      analytics.byModelEffort
    ).slice(0, 3);
    writeCodexTopPerformanceCache({ signature, topRows });
  }
  updateRangeControls();
  renderWindowControls();
  byId('rangeLabel').textContent = rangeLabel(state.rangeDays);
  byId('updatedAt').textContent =
    `Calculated ${formatDateTime(analytics.generatedAt)}`;
  renderFilterControls(analytics);
  renderTrendControls(analytics);
  renderMeasurementBanner(analytics);
  renderMetricCards(analytics);
  renderInsights(analytics);
  renderTables(analytics);
  renderDataQuality(analytics);
  drawCharts(analytics);
}

async function initialize() {
  updateRangeControls();
  byId('exportCsv').addEventListener('click', exportCsv);
  byId('exportTrendCsv').addEventListener('click', exportTrendCsv);
  byId('refreshAnalysis').addEventListener('click', () =>
    window.location.reload()
  );
  window.addEventListener('resize', () => {
    if (state.analytics) drawCharts(state.analytics);
  });
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

if (typeof document !== 'undefined') {
  initialize().catch((error) => {
    console.error(error);
    byId('loadingState').className = 'fatal-state';
    byId('loadingState').textContent =
      `Codex analysis failed: ${error.message || error}`;
  });
}
