/* eslint-disable no-inner-declarations */
/* global Chart */
// @ts-nocheck

import {
  addLocalDays,
  clampUnitInterval,
  countWorkdays,
  diffCalendarDays,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatLocalDateString,
  formatRelativeTime,
  getProjectDeadlineDay,
  getProjectDeadlineEndExclusive,
  getProjectPlanningSnapshot,
  getProjectPlannedHoursForPeriod,
  getProjectStartDate,
  getRollingWindowBounds,
  isProjectActive,
  maxDate,
  parseLocalDateString,
  startOfLocalDay,
  sumEntryHours
} from './shared/runtime-helpers.mjs';
import { uuid } from './shared/id.mjs';
import {
  computeWealthRegression,
  getDefaultWealthHistory,
  makeDefaultWealthGoal,
  normalizeWealthEntry,
  parseWealthAmount
} from './features/wealth/core.mjs';
import {
  STRAVA_SCORE_DEFAULT_SCALE,
  computeStravaScoreScale,
  estimateStravaExertion,
  formatExertion,
  isStravaActivityFaulty,
  parseExertionValue,
  resolveStravaExertion
} from './features/strava/core.mjs';
import {
  applyFitnessDefaults,
  applyWorkoutDefaults,
  clampMultiplier,
  createWorkoutRuntime,
  formatCustomIntensityValue,
  formatDateKey,
  formatPoints,
  formatTimestampForInput,
  formatWorkoutTimestamp,
  getWeekKey,
  getWeekStart,
  makeCustomIntensity,
  makeDefaultFitness,
  makeDefaultWorkouts,
  normalizeIntensity,
  normalizeWeekKey,
  parseDateTimeInput,
  parseISODateOnly,
  sanitizeCustomPoints,
  weekKeyToDate
} from './features/workouts/runtime.mjs';

(function () {
  function ensureFitnessDefaults() {
    data.fitness = applyFitnessDefaults(data.fitness);
    const fitness = data.fitness;
    if (fitness.lastProcessedMonday) {
      const normalized = normalizeWeekKey(fitness.lastProcessedMonday);
      if (normalized) {
        fitness.lastProcessedMonday = normalized;
      }
    }
    if (fitness.weekendBoostUnlockedWeek) {
      const normalized = normalizeWeekKey(fitness.weekendBoostUnlockedWeek);
      if (normalized) {
        fitness.weekendBoostUnlockedWeek = normalized;
      }
    }
    if (fitness.pausedWeeks && typeof fitness.pausedWeeks === 'object') {
      const normalizedPaused = {};
      Object.keys(fitness.pausedWeeks).forEach((key) => {
        const normalizedKey = normalizeWeekKey(key);
        if (normalizedKey) {
          normalizedPaused[normalizedKey] = !!fitness.pausedWeeks[key];
        }
      });
      fitness.pausedWeeks = normalizedPaused;
    }
    if (
      fitness.lastWeekSummary &&
      typeof fitness.lastWeekSummary === 'object'
    ) {
      const summary = fitness.lastWeekSummary;
      if (summary.weekStart) {
        const normalizedStart = normalizeWeekKey(summary.weekStart);
        if (normalizedStart) summary.weekStart = normalizedStart;
      }
      if (summary.weekEnd) {
        const normalizedEnd = normalizeWeekKey(summary.weekEnd);
        if (normalizedEnd) summary.weekEnd = normalizedEnd;
      }
    }
    return fitness;
  }
  function ensureWorkoutData() {
    if (!data.workouts) {
      data.workouts = makeDefaultWorkouts();
    }
    data.workouts = applyWorkoutDefaults(data.workouts);
    return data.workouts;
  }
  const {
    collectWorkoutPoints,
    computeWorkoutPlanActualTotal,
    computeWorkoutPlanExpectedSlice,
    computeWorkoutPlanExpectedTotal,
    computeWorkoutPlanRequiredSlice,
    computeWorkoutWeekPlan,
    getIntensityPromptDefault,
    getIntensitySummary,
    getWorkoutPointPlan,
    migrateLegacyTodosToWorkouts
  } = createWorkoutRuntime({
    ensureFitnessDefaults: () => ensureFitnessDefaults(),
    ensureWorkoutData: () => ensureWorkoutData(),
    isWeekPaused: (weekKey) => isWeekPaused(weekKey),
    processWorkoutWeekIfNeeded: () => processWorkoutWeekIfNeeded(),
    applyStravaExertionOverrides,
    resolveStravaExertion: (activity) =>
      resolveStravaExertion(activity, cachedStravaScoreScale),
    getStravaActivities: () => window.stravaActivitiesCache || []
  });
  function isWeekPaused(weekKey) {
    const fitness = ensureFitnessDefaults();
    return !!(fitness.pausedWeeks && fitness.pausedWeeks[weekKey]);
  }
  function setWeekPaused(weekKey, paused) {
    const fitness = ensureFitnessDefaults();
    if (!fitness.pausedWeeks) fitness.pausedWeeks = {};
    const wasPaused = !!fitness.pausedWeeks[weekKey];
    if (paused) {
      if (!wasPaused) {
        fitness.pausedWeeks[weekKey] = true;
        saveData();
      }
    } else if (wasPaused) {
      delete fitness.pausedWeeks[weekKey];
      saveData();
    }
  }
  function ensureMonthlyRecurringPayments() {
    if (!Array.isArray(data.monthlyRecurringPayments)) {
      data.monthlyRecurringPayments = [];
    }
    data.monthlyRecurringPayments = data.monthlyRecurringPayments.map(
      (payment) => {
        const normalized =
          payment && typeof payment === 'object' ? payment : {};
        if (!normalized.id) normalized.id = uuid();
        normalized.name =
          typeof normalized.name === 'string' ? normalized.name : '';
        const amountNum = Number(normalized.amount);
        normalized.amount =
          Number.isFinite(amountNum) && amountNum >= 0 ? amountNum : 0;
        return normalized;
      }
    );
    return data.monthlyRecurringPayments;
  }
  function getMonthlyRecurringTotal(
    payments = ensureMonthlyRecurringPayments()
  ) {
    return payments.reduce((sum, payment) => {
      const amountNum = Number(payment && payment.amount);
      return (
        sum + (Number.isFinite(amountNum) && amountNum > 0 ? amountNum : 0)
      );
    }, 0);
  }
  function ensureWealthData() {
    let changed = false;
    if (!Array.isArray(data.wealthHistory) || !data.wealthHistory.length) {
      data.wealthHistory = getDefaultWealthHistory();
      changed = true;
    } else {
      const normalized = data.wealthHistory
        .map(normalizeWealthEntry)
        .filter((entry) => entry.date && Number.isFinite(entry.amount));
      if (normalized.length !== data.wealthHistory.length) changed = true;
      data.wealthHistory = normalized;
    }
    if (!data.wealthGoal || typeof data.wealthGoal !== 'object') {
      data.wealthGoal = makeDefaultWealthGoal();
      changed = true;
    } else {
      const amount = parseWealthAmount(data.wealthGoal.amount);
      const date =
        typeof data.wealthGoal.date === 'string' ? data.wealthGoal.date : '';
      if (amount !== data.wealthGoal.amount || date !== data.wealthGoal.date) {
        data.wealthGoal = { amount, date };
        changed = true;
      }
    }
    if (changed) saveData();
    return data.wealthHistory;
  }
  const scheduleRender =
    typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 0);
  let fitnessRenderQueued = false;
  let groceryRenderQueued = false;
  function ensureWorkoutPreset(name, intensity) {
    const workouts = ensureWorkoutData();
    const trimmedName = (name || '').trim();
    if (!trimmedName) return null;
    const normalized = normalizeIntensity(intensity);
    let preset = workouts.presets.find(
      (p) =>
        p.name === trimmedName && normalizeIntensity(p.intensity) === normalized
    );
    if (!preset) {
      preset = { id: uuid(), name: trimmedName, intensity: normalized };
      workouts.presets.push(preset);
    } else {
      preset.intensity = normalized;
      preset.name = trimmedName;
    }
    return preset;
  }
  function logWorkoutEntry({ name, intensity, timestamp, presetId } = {}) {
    const workouts = ensureWorkoutData();
    const trimmedName = (name || '').trim();
    if (!trimmedName) return null;
    const normalized = normalizeIntensity(intensity);
    let preset = null;
    if (presetId) {
      preset = workouts.presets.find((p) => p.id === presetId) || null;
    }
    if (
      !preset ||
      preset.name !== trimmedName ||
      normalizeIntensity(preset.intensity) !== normalized
    ) {
      preset = ensureWorkoutPreset(trimmedName, normalized);
    }
    const when = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(when)) return null;
    const entry = {
      id: uuid(),
      name: trimmedName,
      intensity: normalized,
      timestamp: when.toISOString(),
      presetId: preset ? preset.id : null
    };
    workouts.entries.push(entry);
    saveData();
    updateFitnessCards();
    updateTodoSection();
    return entry;
  }
  function updateEntriesForPreset(preset) {
    const workouts = ensureWorkoutData();
    if (!preset || !preset.id) return;
    workouts.entries.forEach((entry) => {
      if (entry.presetId === preset.id) {
        entry.name = preset.name;
        entry.intensity = preset.intensity;
      }
    });
  }
  function deleteWorkoutPreset(presetId) {
    const workouts = ensureWorkoutData();
    const idx = workouts.presets.findIndex((p) => p.id === presetId);
    if (idx >= 0) {
      workouts.presets.splice(idx, 1);
      workouts.entries.forEach((entry) => {
        if (entry.presetId === presetId) {
          entry.presetId = null;
        }
      });
    }
  }
  function updateWorkoutEntry(entryId, updates = {}) {
    const workouts = ensureWorkoutData();
    const entry = workouts.entries.find((e) => e.id === entryId);
    if (!entry) return null;
    const newName = updates.name !== undefined ? updates.name : entry.name;
    const trimmedName = (newName || '').trim();
    if (!trimmedName) return null;
    const newIntensity = normalizeIntensity(
      updates.intensity !== undefined ? updates.intensity : entry.intensity
    );
    let preset = ensureWorkoutPreset(trimmedName, newIntensity);
    entry.name = preset ? preset.name : trimmedName;
    entry.intensity = preset ? preset.intensity : newIntensity;
    entry.presetId = preset ? preset.id : null;
    if (updates.timestamp) {
      const dt = new Date(updates.timestamp);
      if (!isNaN(dt)) {
        entry.timestamp = dt.toISOString();
      }
    }
    saveData();
    updateFitnessCards();
    updateTodoSection();
    return entry;
  }
  function deleteWorkoutEntry(entryId) {
    const workouts = ensureWorkoutData();
    const idx = workouts.entries.findIndex((e) => e.id === entryId);
    if (idx >= 0) {
      workouts.entries.splice(idx, 1);
      saveData();
      updateFitnessCards();
      updateTodoSection();
    }
  }
  let wealthChartInstance = null;
  function addWealthHistoryEntry(dateStr, amountRaw, noteRaw = '') {
    const parsedDate = parseISODateOnly(dateStr);
    if (!parsedDate) return { ok: false, reason: 'date' };
    const amount = parseWealthAmount(amountRaw);
    if (!Number.isFinite(amount)) return { ok: false, reason: 'amount' };
    const entry = {
      id: uuid(),
      date: formatDateKey(parsedDate),
      amount,
      note: typeof noteRaw === 'string' ? noteRaw.trim() : ''
    };
    const wealthHistory = ensureWealthData();
    wealthHistory.push(entry);
    wealthHistory.sort((a, b) => new Date(a.date) - new Date(b.date));
    saveData();
    return { ok: true, entry };
  }
  function deleteWealthHistoryEntry(entryId) {
    const wealthHistory = ensureWealthData();
    const idx = wealthHistory.findIndex((e) => e.id === entryId);
    if (idx >= 0) {
      wealthHistory.splice(idx, 1);
      saveData();
    }
  }
  function renderWealthHistoryTable() {
    const body = document.getElementById('wealthHistoryBody');
    if (!body) return;
    const wealthHistory = ensureWealthData()
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    body.innerHTML = '';
    wealthHistory.forEach((entry) => {
      const row = document.createElement('tr');
      const dateCell = document.createElement('td');
      dateCell.textContent = entry.date || '';
      row.appendChild(dateCell);
      const amountCell = document.createElement('td');
      amountCell.textContent = formatCurrency(entry.amount, -1);
      row.appendChild(amountCell);
      const noteCell = document.createElement('td');
      noteCell.textContent = entry.note || '';
      row.appendChild(noteCell);
      const actionsCell = document.createElement('td');
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn danger';
      deleteBtn.style.padding = '0.25rem 0.5rem';
      deleteBtn.style.fontSize = '0.85rem';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        if (confirm('Delete this data point?')) {
          deleteWealthHistoryEntry(entry.id);
          updateWealthDashboard();
          renderWealthHistoryTable();
        }
      });
      actionsCell.appendChild(deleteBtn);
      row.appendChild(actionsCell);
      body.appendChild(row);
    });
  }
  function updateWealthDashboard() {
    const chartEl = document.getElementById('wealthChart');
    const summaryEl = document.getElementById('wealthProjectionSummary');
    const goalAmountInput = document.getElementById('wealthGoalAmount');
    const goalDateInput = document.getElementById('wealthGoalDate');
    if (!chartEl || !summaryEl) return;
    const msPerDay = 24 * 60 * 60 * 1000;
    const wealthHistory = ensureWealthData()
      .map((entry) => ({ ...entry, time: new Date(entry.date).getTime() }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((a, b) => a.time - b.time);
    if (!wealthHistory.length) return;
    const goal = data.wealthGoal || makeDefaultWealthGoal();
    if (goalAmountInput) goalAmountInput.value = goal.amount || '';
    if (goalDateInput) goalDateInput.value = goal.date || '';
    const projectionWindowMs = 540 * msPerDay; // 18 months window for a more realistic trend
    const windowStart =
      wealthHistory[wealthHistory.length - 1].time - projectionWindowMs;
    const regressionSource = wealthHistory.filter(
      (entry) => entry.time >= windowStart
    );
    const regressionBaseTime = regressionSource.length
      ? regressionSource[0].time
      : wealthHistory[0].time;
    const regressionInput = (
      regressionSource.length >= 2 ? regressionSource : wealthHistory
    ).map((entry) => ({
      x: (entry.time - regressionBaseTime) / msPerDay,
      y: entry.amount
    }));
    const chartPoints = wealthHistory.map((entry) => ({
      x: entry.time,
      y: entry.amount
    }));
    const regression = computeWealthRegression(regressionInput);
    const lastEntry = wealthHistory[wealthHistory.length - 1];
    const estimateAmountAtTime = (targetTime) => {
      if (!wealthHistory.length) return 0;
      if (targetTime <= wealthHistory[0].time) return wealthHistory[0].amount;
      if (targetTime >= lastEntry.time) return lastEntry.amount;
      for (let i = 0; i < wealthHistory.length - 1; i++) {
        const left = wealthHistory[i];
        const right = wealthHistory[i + 1];
        if (targetTime >= left.time && targetTime <= right.time) {
          const span = right.time - left.time;
          if (span <= 0) return right.amount;
          const ratio = (targetTime - left.time) / span;
          return left.amount + (right.amount - left.amount) * ratio;
        }
      }
      return lastEntry.amount;
    };
    const makeWindowPace = (months) => {
      const windowMs = months * 30 * msPerDay;
      const startTime = lastEntry.time - windowMs;
      const startAmount = estimateAmountAtTime(startTime);
      const elapsedDays = (lastEntry.time - startTime) / msPerDay;
      if (elapsedDays <= 0) return null;
      return {
        months,
        startTime,
        startAmount,
        slopePerDay: (lastEntry.amount - startAmount) / elapsedDays
      };
    };
    const getWindowProjectionFromLatest = (windowModel, targetDate) => {
      if (!windowModel) return lastEntry.amount;
      const daysFromLatest = (targetDate.getTime() - lastEntry.time) / msPerDay;
      return lastEntry.amount + windowModel.slopePerDay * daysFromLatest;
    };
    const regression6m = makeWindowPace(6);
    const regression12m = makeWindowPace(12);
    const lastDate = new Date(lastEntry.time);
    const formatWealth = (num, decimals = -1) => {
      const formatted = formatCurrency(num, decimals);
      return formatted ? formatted.replace(' kr', ' SEK') : '0 SEK';
    };
    const formatCompactWealth = (num) => {
      if (!isFinite(num)) return '';
      return new Intl.NumberFormat('sv-SE', {
        notation: 'compact',
        maximumFractionDigits: 1
      }).format(num);
    };
    const projectionHorizonDate = (() => {
      const goalDateParsed = parseLocalDateString(goal.date);
      if (goalDateParsed && goalDateParsed > lastDate) return goalDateParsed;
      const twelveMonths = new Date(lastDate);
      twelveMonths.setMonth(twelveMonths.getMonth() + 12);
      return twelveMonths;
    })();
    const projectionData = [];
    const upperBand = [];
    const lowerBand = [];
    const getPrediction = (targetDate) => {
      const x = (targetDate.getTime() - regressionBaseTime) / msPerDay;
      if (!regression) return { value: lastEntry.amount, band: 0 };
      const predicted = regression.intercept + regression.slope * x;
      const spread =
        regression.residualStd *
        Math.sqrt(
          1 +
            (regression.sumSqX > 0
              ? Math.pow(x - regression.meanX, 2) / regression.sumSqX
              : 0)
        );
      return { value: predicted, band: spread * 1.25 };
    };
    let cursor = new Date(lastDate);
    const stepDays = Math.max(
      14,
      Math.round(
        (projectionHorizonDate.getTime() - lastDate.getTime()) / msPerDay / 18
      )
    );
    const stepMs = stepDays * msPerDay;
    while (cursor.getTime() <= projectionHorizonDate.getTime()) {
      const { value, band } = getPrediction(cursor);
      const ts = cursor.getTime();
      projectionData.push({ x: ts, y: value });
      upperBand.push({ x: ts, y: value + band });
      lowerBand.push({ x: ts, y: Math.max(0, value - band) });
      cursor = new Date(cursor.getTime() + stepMs);
    }
    if (
      projectionData[projectionData.length - 1].x !==
      projectionHorizonDate.getTime()
    ) {
      const { value, band } = getPrediction(projectionHorizonDate);
      projectionData.push({ x: projectionHorizonDate.getTime(), y: value });
      upperBand.push({ x: projectionHorizonDate.getTime(), y: value + band });
      lowerBand.push({
        x: projectionHorizonDate.getTime(),
        y: Math.max(0, value - band)
      });
    }
    const datasets = [
      {
        label: 'Recorded wealth',
        data: chartPoints,
        borderColor: '#2563eb',
        backgroundColor: '#2563eb',
        tension: 0.2,
        pointRadius: 4,
        fill: false
      }
    ];
    if (projectionData.length) {
      const projection6mData = regression6m
        ? projectionData.map((p) => ({
            x: p.x,
            y: getWindowProjectionFromLatest(regression6m, new Date(p.x))
          }))
        : [];
      const projection12mData = regression12m
        ? projectionData.map((p) => ({
            x: p.x,
            y: getWindowProjectionFromLatest(regression12m, new Date(p.x))
          }))
        : [];
      datasets.push(
        {
          label: 'Projection band (± ~1σ)',
          data: lowerBand,
          borderColor: 'rgba(59,130,246,0.1)',
          backgroundColor: 'rgba(59,130,246,0.12)',
          pointRadius: 0,
          fill: '+1',
          tension: 0.2,
          borderWidth: 0
        },
        {
          label: 'Projection upper bound',
          data: upperBand,
          borderColor: 'rgba(59,130,246,0.1)',
          backgroundColor: 'rgba(59,130,246,0.12)',
          pointRadius: 0,
          fill: false,
          tension: 0.2,
          borderWidth: 0
        },
        {
          label: 'Projection (18m trend)',
          data: projectionData,
          borderColor: '#0ea5e9',
          backgroundColor: '#0ea5e9',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        }
      );
      if (projection6mData.length) {
        datasets.push({
          label: 'Projection (6m pace)',
          data: projection6mData,
          borderColor: '#f97316',
          backgroundColor: '#f97316',
          borderDash: [2, 5],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15
        });
      }
      if (projection12mData.length) {
        datasets.push({
          label: 'Projection (12m pace)',
          data: projection12mData,
          borderColor: '#a855f7',
          backgroundColor: '#a855f7',
          borderDash: [10, 4],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15
        });
      }
    }
    const goalDateParsed = parseLocalDateString(goal.date);
    const hasGoal =
      goal.amount > 0 &&
      goalDateParsed instanceof Date &&
      !isNaN(goalDateParsed);
    if (hasGoal) {
      datasets.push({
        label: 'Goal',
        data: [{ x: goalDateParsed.getTime(), y: goal.amount }],
        borderColor: '#16a34a',
        backgroundColor: '#16a34a',
        pointRadius: 6,
        pointStyle: 'triangle',
        showLine: false
      });
    }
    if (wealthChartInstance) wealthChartInstance.destroy();
    wealthChartInstance = new Chart(chartEl.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8, right: 12, bottom: 0, left: 4 } },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Date' },
            ticks: {
              maxRotation: 0,
              autoSkipPadding: 14,
              callback: (value) => {
                const date = new Date(value);
                return isNaN(date)
                  ? ''
                  : date.toLocaleDateString(undefined, {
                      month: 'short',
                      year: '2-digit'
                    });
              }
            }
          },
          y: {
            title: { display: true, text: 'Total wealth (SEK)' },
            grace: '12%',
            ticks: {
              callback: (val) => formatCompactWealth(val),
              padding: 8,
              maxTicksLimit: 7
            }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 22,
              usePointStyle: true,
              filter: (item) => item.text !== 'Projection upper bound'
            }
          },
          tooltip: {
            padding: 10,
            callbacks: {
              title: (items) => {
                const raw = items[0]?.parsed?.x;
                const date = new Date(raw);
                return isNaN(date) ? '' : date.toLocaleDateString();
              },
              label: (ctx) =>
                `${ctx.dataset.label}: ${formatWealth(ctx.parsed.y, -1)}`
            }
          }
        }
      }
    });
    const summaryParts = [];
    const monthlySlope = regression ? regression.slope * 30 : 0;
    const monthlySlope6m = regression6m ? regression6m.slopePerDay * 30 : null;
    const monthlySlope12m = regression12m
      ? regression12m.slopePerDay * 30
      : null;
    const horizonPoint = projectionData.length
      ? projectionData[projectionData.length - 1]
      : lastEntry;
    const horizonDate = new Date(horizonPoint.x || lastDate.getTime());
    const projection6mAtHorizon = regression6m
      ? getWindowProjectionFromLatest(regression6m, horizonDate)
      : null;
    const projection12mAtHorizon = regression12m
      ? getWindowProjectionFromLatest(regression12m, horizonDate)
      : null;
    summaryParts.push(
      `<strong>Last recorded:</strong> ${formatWealth(lastEntry.amount)} on ${lastDate.toLocaleDateString()}.`
    );
    summaryParts.push(
      `<strong>Projected outlook through ${projectionHorizonDate.toLocaleDateString()}:</strong> ${formatWealth(horizonPoint.y)} (${formatSignedCurrency(monthlySlope, -1)} per month trend).`
    );
    summaryParts.push(
      `<strong>Savings pace comparison:</strong> 6m ${formatSignedCurrency(monthlySlope6m || 0, -1)}/month, 12m ${formatSignedCurrency(monthlySlope12m || 0, -1)}/month, baseline 18m ${formatSignedCurrency(monthlySlope, -1)}/month.`
    );
    if (projection6mAtHorizon !== null && projection12mAtHorizon !== null) {
      summaryParts.push(
        `<strong>Projection comparison by ${projectionHorizonDate.toLocaleDateString()}:</strong> 6m pace ${formatWealth(projection6mAtHorizon)}, 12m pace ${formatWealth(projection12mAtHorizon)}, baseline ${formatWealth(horizonPoint.y)}.`
      );
    }
    summaryParts.push(
      '<span class="muted">Trend lines use rolling windows (6m, 12m, and 18m baseline) so you can compare recent acceleration vs longer-term pace.</span>'
    );
    if (hasGoal) {
      const daysToGoal = Math.round(
        (goalDateParsed.getTime() - lastDate.getTime()) / msPerDay
      );
      const goalProjection = getPrediction(goalDateParsed).value;
      const monthsToGoal = daysToGoal / 30;
      const requiredMonthlyTotal =
        monthsToGoal > 0
          ? (goal.amount - lastEntry.amount) / monthsToGoal
          : null;
      const monthlyDeltaNeeded =
        requiredMonthlyTotal !== null
          ? requiredMonthlyTotal - monthlySlope
          : null;
      if (daysToGoal <= 0) {
        summaryParts.push(
          `<strong>Goal:</strong> ${formatWealth(goal.amount)} on ${goalDateParsed.toLocaleDateString()} (date has passed).`
        );
      } else {
        const gap = goal.amount - goalProjection;
        if (daysToGoal < 7) {
          summaryParts.push(
            `<strong>Goal:</strong> ${formatWealth(goal.amount)} by ${goalDateParsed.toLocaleDateString()}. Expected trajectory hits ${formatWealth(goalProjection)} (${formatSignedCurrency(gap, -1)} gap).`
          );
          summaryParts.push(
            `<span class="muted">Goal date is too close for monthly adjustment calculations.</span>`
          );
        } else {
          summaryParts.push(
            `<strong>Goal:</strong> ${formatWealth(goal.amount)} by ${goalDateParsed.toLocaleDateString()}. Expected trajectory hits ${formatWealth(goalProjection)} (${formatSignedCurrency(gap, -1)} gap).`
          );
          summaryParts.push(
            `<span class="muted">To stay on track, aim for about ${formatWealth(requiredMonthlyTotal, -1)} per month in total. Current trend is ${formatSignedCurrency(monthlySlope, -1)} per month, so adjust by ${formatSignedCurrency(monthlyDeltaNeeded, -1)} each month.</span>`
          );
        }
      }
    } else {
      summaryParts.push(
        '<span class="muted">Set a goal amount and date to see what pace you need to stay on track.</span>'
      );
    }
    summaryEl.innerHTML = summaryParts
      .map((part) => `<div style="margin-bottom:0.35rem;">${part}</div>`)
      .join('');
  }
  function finalizeFitnessWeek(lastMonday, thisMonday) {
    const fitness = ensureFitnessDefaults();
    const lastMondayKey = getWeekKey(lastMonday);
    const thisMondayKey = getWeekKey(thisMonday);
    const defaults = makeDefaultFitness();
    const prevNextRaw =
      typeof fitness.nextMultiplier === 'number' &&
      isFinite(fitness.nextMultiplier)
        ? fitness.nextMultiplier
        : null;
    const prevCurrentRaw =
      typeof fitness.currentMultiplier === 'number' &&
      isFinite(fitness.currentMultiplier)
        ? fitness.currentMultiplier
        : null;
    const fallbackMultiplier = clampMultiplier(
      prevNextRaw !== null
        ? prevNextRaw
        : prevCurrentRaw !== null
          ? prevCurrentRaw
          : defaults.currentMultiplier
    );
    let resultingMultiplier = fallbackMultiplier;
    const pausedWeeks = fitness.pausedWeeks || {};
    const wasPaused = !!pausedWeeks[lastMondayKey];
    if (wasPaused) {
      delete pausedWeeks[lastMondayKey];
      fitness.pausedWeeks = pausedWeeks;
    }
    const plan = getWorkoutPointPlan(fitness);
    const boundedStart = lastMonday < plan.start ? plan.start : lastMonday;
    const boundedEnd =
      thisMonday > plan.endExclusive ? plan.endExclusive : thisMonday;
    const emptyWeekSummary = {
      totalPoints: 0,
      counts: { intense: 0, medium: 0, light: 0, custom: 0, strava: 0 },
      pointsByIntensity: {
        intense: 0,
        medium: 0,
        light: 0,
        custom: 0,
        strava: 0
      }
    };
    const weeklySummary =
      boundedEnd > boundedStart
        ? collectWorkoutPoints({ start: boundedStart, end: boundedEnd })
        : emptyWeekSummary;

    const expectedWeekPoints = computeWorkoutPlanExpectedSlice(
      plan,
      lastMonday,
      thisMonday
    );
    const actualBeforeWeek = computeWorkoutPlanActualTotal(plan, boundedStart);
    const expectedAtWeekEnd = computeWorkoutPlanExpectedTotal(plan, boundedEnd);
    const requiredPoints = wasPaused
      ? 0
      : computeWorkoutPlanRequiredSlice(
          plan,
          boundedStart,
          boundedEnd,
          actualBeforeWeek
        );
    const actualPoints = weeklySummary.totalPoints;
    const actualAtWeekEnd = actualBeforeWeek + actualPoints;
    const scheduleDeltaEnd = actualAtWeekEnd - expectedAtWeekEnd;

    const settings = fitness.pointSettings || {};
    const multiplierPerPoint = Number(settings.multiplierPerPoint);
    const creditsPerPoint = Number(settings.creditsPerPoint);
    const effectiveMultiplierPerPoint = Number.isFinite(multiplierPerPoint)
      ? multiplierPerPoint
      : 0;
    const effectiveCreditsPerPoint = Number.isFinite(creditsPerPoint)
      ? creditsPerPoint
      : 0;
    const improvementPoints = Math.max(0, actualPoints - expectedWeekPoints);
    const creditsEarned = improvementPoints * effectiveCreditsPerPoint;
    const currentCredits = Number.isFinite(fitness.wellnessCredits)
      ? fitness.wellnessCredits
      : defaults.wellnessCredits;
    const cap = Number.isFinite(fitness.creditsCap)
      ? fitness.creditsCap
      : defaults.creditsCap;
    const newCredits = Math.max(
      0,
      Math.min(cap, currentCredits + creditsEarned)
    );
    const metTarget = wasPaused ? true : actualAtWeekEnd >= expectedAtWeekEnd;
    const previousStreak = Number.isFinite(fitness.streakCount)
      ? fitness.streakCount
      : 0;
    const streakCount = metTarget ? previousStreak + 1 : 0;

    if (wasPaused) {
      resultingMultiplier = fallbackMultiplier;
      fitness.lastWeekSummary = {
        weekStart: lastMondayKey,
        weekEnd: formatDateKey(thisMonday),
        totalPoints: actualPoints,
        expectedWeekPoints,
        requiredPoints,
        scheduleDeltaEnd,
        multiplierDelta: 0,
        creditsEarned: 0,
        paused: true,
        counts: weeklySummary.counts,
        pointsByIntensity: weeklySummary.pointsByIntensity,
        lockedMultiplier: resultingMultiplier
      };
    } else {
      resultingMultiplier = clampMultiplier(
        1 + effectiveMultiplierPerPoint * scheduleDeltaEnd
      );
      fitness.wellnessCredits = newCredits;
      fitness.streakCount = streakCount;
      fitness.lastWeekSummary = {
        weekStart: lastMondayKey,
        weekEnd: formatDateKey(thisMonday),
        totalPoints: actualPoints,
        expectedWeekPoints,
        requiredPoints,
        scheduleDeltaEnd,
        multiplierDelta: resultingMultiplier - 1,
        creditsEarned,
        paused: false,
        counts: weeklySummary.counts,
        pointsByIntensity: weeklySummary.pointsByIntensity,
        lockedMultiplier: resultingMultiplier
      };
    }
    // Intentionally set both currentMultiplier and nextMultiplier to the same value here
    // to synchronize the multipliers at the end of the week. This ensures consistency
    // when starting a new week or after a pause/reset.
    fitness.currentMultiplier = resultingMultiplier;
    fitness.nextMultiplier = resultingMultiplier;
    fitness.weekendBoostUnlockedWeek = null;
    fitness.lastProcessedMonday = thisMondayKey;
  }
  function evaluateWeekendBoostUnlock() {
    const fitness = ensureFitnessDefaults();
    if (!fitness.weekendBoostEnabled) return false;
    const weekKey = getWeekKey(new Date());
    if (fitness.weekendBoostUnlockedWeek === weekKey) return true;
    const monday = getWeekStart(new Date());
    const fridayCutoff = new Date(monday);
    fridayCutoff.setDate(fridayCutoff.getDate() + 4);
    fridayCutoff.setHours(18, 0, 0, 0);
    const now = new Date();
    if (now < fridayCutoff) return false;
    const statsInfo = collectWorkoutPoints({
      start: monday,
      end: fridayCutoff
    });
    const plan = computeWorkoutWeekPlan({
      fitness,
      weekStart: monday,
      pointsInfo: { totalPoints: statsInfo.totalPoints }
    });
    if (
      plan.requiredPoints <= 0 ||
      statsInfo.totalPoints >= plan.requiredPoints
    ) {
      fitness.weekendBoostUnlockedWeek = weekKey;
      saveData();
      return true;
    }
    return false;
  }
  function isWeekendBoostActive() {
    const fitness = ensureFitnessDefaults();
    if (!fitness.weekendBoostEnabled) return false;
    const weekKey = getWeekKey(new Date());
    if (fitness.weekendBoostUnlockedWeek !== weekKey) {
      return evaluateWeekendBoostUnlock();
    }
    const now = new Date();
    const monday = getWeekStart(now);
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);
    friday.setHours(18, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return now >= friday && now <= sunday;
  }
  function _formatPercent(value, decimals = 1) {
    if (!isFinite(value)) return '0%';
    return (value * 100).toFixed(decimals) + '%';
  }
  function formatSignedCurrency(value, decimals = -1) {
    if (!isFinite(value) || value === 0) {
      return '0 SEK';
    }
    const formatted = formatCurrency(Math.abs(value), decimals).replace(
      ' kr',
      ''
    );
    return (value >= 0 ? '+' : '−') + formatted + ' SEK';
  }
  // Load and save data

  function normalizeProjectData(project) {
    const obj = project && typeof project === 'object' ? { ...project } : {};
    if (!obj.id) obj.id = uuid();
    if (!obj.createdAt) obj.createdAt = new Date().toISOString();
    const parsedStart = parseLocalDateString(obj.startDate || obj.createdAt);
    obj.startDate = parsedStart ? formatLocalDateString(parsedStart) : '';
    return obj;
  }

  function loadData() {
    const raw = localStorage.getItem('timekeeperDataPro');
    if (!raw) {
      return {
        projects: [],
        entries: [],
        todos: [],
        workouts: makeDefaultWorkouts(),
        monthlyRecurringPayments: [],
        groceries: [],
        groceryBudgetWeekly: 1000,
        groceryBudgetMonthly: 4000,
        groceryBudgetBiYearly: 20000,
        groceryBudgetWeeklyCarry: 0,
        groceryBudgetMonthlyCarry: 0,
        groceryBudgetBiYearlyCarry: 0,
        groceryBudgetWeeklyCarryBaseline: 0,
        groceryBudgetMonthlyCarryBaseline: 0,
        groceryBudgetBiYearlyCarryBaseline: 0,
        groceryBudgetStartDate: null,
        backupDirName: null,
        lastBackupAt: null,
        lastBackupFile: null,
        lastBackupSnapshotAt: null,
        backupRevision: 0,
        updatedAt: null,
        fitness: makeDefaultFitness(),
        wealthHistory: getDefaultWealthHistory(),
        wealthGoal: makeDefaultWealthGoal()
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map(normalizeProjectData)
          : [],
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        workouts: applyWorkoutDefaults(
          parsed.workouts || migrateLegacyTodosToWorkouts(parsed.todos)
        ),
        monthlyRecurringPayments: Array.isArray(parsed.monthlyRecurringPayments)
          ? parsed.monthlyRecurringPayments.map((p) => {
              const payment = p && typeof p === 'object' ? p : {};
              if (!payment.id) payment.id = uuid();
              payment.name =
                typeof payment.name === 'string' ? payment.name : '';
              const amountNum = Number(payment.amount);
              payment.amount =
                Number.isFinite(amountNum) && amountNum >= 0 ? amountNum : 0;
              return payment;
            })
          : [],
        // Grocery items: weekly/monthly shopping list with carryOver and purchasedCount.
        groceries: Array.isArray(parsed.groceries)
          ? parsed.groceries.map((g) => {
              // Migrate legacy properties to new structure. Each item should have a name and frequency.
              if (!g.name) g.name = '';
              if (!g.frequency) g.frequency = 'weekly';
              if (typeof g.frequency === 'string') {
                const freq = g.frequency.toLowerCase();
                if (
                  freq === 'weekly' ||
                  freq === 'monthly' ||
                  freq === 'biannual'
                ) {
                  g.frequency = freq;
                } else {
                  g.frequency = 'weekly';
                }
              } else {
                g.frequency = 'weekly';
              }
              // In the new structure, we track whether an item has been archived and when it was purchased. Default false/null.
              if (g.archived === undefined) g.archived = false;
              if (g.purchasedDate === undefined) g.purchasedDate = null;
              if (!g.category) g.category = 'standard';
              if (typeof g.cost === 'string') {
                const parsedCost = parseFloat(g.cost);
                if (!isNaN(parsedCost)) g.cost = parsedCost;
              }
              if (typeof g.originalCost === 'string') {
                const parsedOriginal = parseFloat(g.originalCost);
                if (!isNaN(parsedOriginal)) g.originalCost = parsedOriginal;
              }
              if (g.originalCost === undefined && typeof g.cost === 'number')
                g.originalCost = g.cost;
              if (g.appliedCredits === undefined) g.appliedCredits = 0;
              if (g.boostApplied === undefined) g.boostApplied = false;
              if (g.boostPercentApplied === undefined)
                g.boostPercentApplied = 0;
              // Remove legacy fields carryOver and purchasedCount if present
              if (Object.prototype.hasOwnProperty.call(g, 'carryOver'))
                delete g.carryOver;
              if (Object.prototype.hasOwnProperty.call(g, 'purchasedCount'))
                delete g.purchasedCount;
              return g;
            })
          : [],
        // Single-item purchase quotas have been removed. Now, budgets control overall spending rather than item counts.
        // As a result, carry-over counts for purchases are no longer tracked or persisted in the data structure.
        groceryBudgetWeekly:
          typeof parsed.groceryBudgetWeekly === 'number'
            ? parsed.groceryBudgetWeekly
            : 1000,
        groceryBudgetMonthly:
          typeof parsed.groceryBudgetMonthly === 'number'
            ? parsed.groceryBudgetMonthly
            : 4000,
        groceryBudgetBiYearly:
          typeof parsed.groceryBudgetBiYearly === 'number'
            ? parsed.groceryBudgetBiYearly
            : 20000,
        groceryBudgetWeeklyCarry:
          typeof parsed.groceryBudgetWeeklyCarry === 'number'
            ? parsed.groceryBudgetWeeklyCarry
            : 0,
        groceryBudgetMonthlyCarry:
          typeof parsed.groceryBudgetMonthlyCarry === 'number'
            ? parsed.groceryBudgetMonthlyCarry
            : 0,
        groceryBudgetBiYearlyCarry:
          typeof parsed.groceryBudgetBiYearlyCarry === 'number'
            ? parsed.groceryBudgetBiYearlyCarry
            : 0,
        groceryBudgetWeeklyCarryBaseline:
          typeof parsed.groceryBudgetWeeklyCarryBaseline === 'number'
            ? parsed.groceryBudgetWeeklyCarryBaseline
            : typeof parsed.groceryBudgetWeeklyCarry === 'number'
              ? parsed.groceryBudgetWeeklyCarry
              : 0,
        groceryBudgetMonthlyCarryBaseline:
          typeof parsed.groceryBudgetMonthlyCarryBaseline === 'number'
            ? parsed.groceryBudgetMonthlyCarryBaseline
            : typeof parsed.groceryBudgetMonthlyCarry === 'number'
              ? parsed.groceryBudgetMonthlyCarry
              : 0,
        groceryBudgetBiYearlyCarryBaseline:
          typeof parsed.groceryBudgetBiYearlyCarryBaseline === 'number'
            ? parsed.groceryBudgetBiYearlyCarryBaseline
            : typeof parsed.groceryBudgetBiYearlyCarry === 'number'
              ? parsed.groceryBudgetBiYearlyCarry
              : 0,
        // Start date for budgeting periods (YYYY-MM-DD); defaults to null to use current date on first run
        groceryBudgetStartDate: parsed.groceryBudgetStartDate || null,
        // Preserve additional persisted properties like backupDirName if present in saved data
        backupDirName: parsed.backupDirName || null,
        lastBackupAt: parsed.lastBackupAt || null,
        lastBackupFile: parsed.lastBackupFile || null,
        lastBackupSnapshotAt: parsed.lastBackupSnapshotAt || null,
        backupRevision:
          typeof parsed.backupRevision === 'number' ? parsed.backupRevision : 0,
        updatedAt: parsed.updatedAt || null,
        fitness: applyFitnessDefaults(parsed.fitness),
        wealthHistory: Array.isArray(parsed.wealthHistory)
          ? parsed.wealthHistory.map(normalizeWealthEntry)
          : getDefaultWealthHistory(),
        wealthGoal:
          parsed.wealthGoal && typeof parsed.wealthGoal === 'object'
            ? {
                amount: parseWealthAmount(parsed.wealthGoal.amount || 0) || 0,
                date:
                  typeof parsed.wealthGoal.date === 'string'
                    ? parsed.wealthGoal.date
                    : ''
              }
            : makeDefaultWealthGoal()
      };
    } catch (err) {
      return {
        projects: [],
        entries: [],
        todos: [],
        workouts: makeDefaultWorkouts(),
        monthlyRecurringPayments: [],
        groceries: [],
        groceryBudgetWeekly: 1000,
        groceryBudgetMonthly: 4000,
        groceryBudgetBiYearly: 20000,
        groceryBudgetWeeklyCarry: 0,
        groceryBudgetMonthlyCarry: 0,
        groceryBudgetBiYearlyCarry: 0,
        groceryBudgetWeeklyCarryBaseline: 0,
        groceryBudgetMonthlyCarryBaseline: 0,
        groceryBudgetBiYearlyCarryBaseline: 0,
        groceryBudgetStartDate: null,
        backupDirName: null,
        lastBackupAt: null,
        lastBackupFile: null,
        lastBackupSnapshotAt: null,
        backupRevision: 0,
        updatedAt: null,
        fitness: makeDefaultFitness(),
        wealthHistory: getDefaultWealthHistory(),
        wealthGoal: makeDefaultWealthGoal()
      };
    }
  }
  function persistDataToLocalStorage() {
    localStorage.setItem('timekeeperDataPro', JSON.stringify(data));
  }
  function saveData() {
    data.updatedAt = new Date().toISOString();
    data.backupRevision = (Number(data.backupRevision) || 0) + 1;
    persistDataToLocalStorage();
    // Mark data as needing backup
    needsBackup = true;
    scheduleBackupSoon();
  }

  // Compute concurrency factor based on the number of active timers.
  // Factor decreases as more timers run simultaneously: for example, 1 timer=1.0, 2 timers=0.75, 3 timers=0.6.
  function computeConcurrencyFactor(n) {
    if (n <= 1) return 1;
    return 1 / (1 + (n - 1) / 3);
  }
  // Focus model:
  // - 100% means you are actively focused on a project.
  // - 50% means an agent is working while you are not actively focused there.
  // - 150% means you and one agent are working together.
  // - 200% means you and two or more agents are working together.
  // - 25% means an agent is working while you are only half-engaged or not monitoring it.
  const FOCUS_FACTOR_OPTIONS = [
    { value: 2, label: '200% - you + 2+ agents' },
    { value: 1.5, label: '150% - you + agent' },
    { value: 1, label: '100% - you' },
    { value: 0.75, label: '75%' },
    { value: 0.5, label: '50% - agent' },
    { value: 0.25, label: '25% - unmonitored agent' }
  ];
  function formatFocusPercent(factor) {
    const parsed = Number(factor);
    const safeFactor = Number.isFinite(parsed) ? parsed : 1;
    return Math.round(safeFactor * 100) + '%';
  }
  function getEntryFocusFactor(entry, fallbackCount = 1) {
    const candidates = [
      entry && entry.focusFactor,
      entry && entry.manualFactor,
      entry && entry.factor,
      computeConcurrencyFactor(fallbackCount)
    ];
    const value = candidates.find(
      (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0
    );
    return Number.isFinite(Number(value)) ? Number(value) : 1;
  }
  function appendFocusFactorOptions(selectEl) {
    FOCUS_FACTOR_OPTIONS.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = String(option.value);
      opt.textContent = option.label;
      selectEl.appendChild(opt);
    });
  }
  const BACKUP_LATEST_FILENAME = 'timekeeper-data.json';
  const BACKUP_MANIFEST_FILENAME = 'timekeeper-manifest.json';
  const BACKUP_SNAPSHOT_DIR = 'timekeeper-snapshots';
  const BACKUP_SNAPSHOT_KEEP = 30;
  const AUTO_BACKUP_INTERVAL_MS = 60000;
  const BACKUP_DEBOUNCE_MS = 12000;
  // Initialize backup and sync flags before they are referenced in saveData().
  // needsBackup tracks whether the data has changed and needs to be exported.
  // autoSyncEnabled indicates whether automatic export is enabled.
  // backupDirHandle holds the selected directory for backups via the File System Access API.
  let needsBackup = false;
  let autoSyncEnabled = false;
  let backupDirHandle = null;
  let backupInFlight = null;
  let backupFlushTimer = null;
  // backupPermissionState tracks the permission status for writing backups using the File System Access API.
  // Possible states:
  //   'missing' - No backup directory has been selected yet.
  //   'prompt'  - A backup directory is selected, but permission to write has not been granted.
  //   'granted' - Permission to write to the backup directory has been granted.
  //   'denied'  - Permission to write to the backup directory has been denied.
  let backupPermissionState = 'missing';
  let backupWarningMessage = '';
  let data = loadData();
  ensureFitnessDefaults();
  ensureWorkoutData();
  ensureMonthlyRecurringPayments();
  ensureWealthData();
  // Flag to track whether to show all entries or only recent ones. If false,
  // entries older than approximately one month are hidden by default to keep
  // the list manageable. This can be toggled via a button in the Entries section.
  let showAllEntries = false;
  let entryProjectFilter = '';
  let entrySearchQuery = '';

  // -------------------------------------------------------------------------
  //  Haptic feedback and simple audio cues
  //
  //  provideHaptic() triggers vibration on devices that support the
  //  Vibration API. If a 'beep' type is requested, it plays a short tone via
  //  the Web Audio API. These feedback cues enhance the feeling of
  //  interaction when starting/stopping timers or adjusting entry durations.
  function provideHaptic(type) {
    // Trigger a short vibration where supported
    if (navigator && 'vibrate' in navigator) {
      if (type === 'long') navigator.vibrate([50, 50, 50]);
      else navigator.vibrate(40);
    }
    // Play a simple beep for auditory feedback
    if (type === 'beep') {
      try {
        if (!window._beepAudioCtx) {
          window._beepAudioCtx = new (
            window.AudioContext || window.webkitAudioContext
          )();
        }
        const ctx = window._beepAudioCtx;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 440;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.05);
      } catch (err) {
        // Audio may fail if the page is not interacted with yet
      }
    }
  }

  // -------------------------------------------------------------------------
  //  IndexedDB persistence for backup directory handle
  //
  //  Persisting the selected backup folder across sessions requires storing
  //  the FileSystemDirectoryHandle in IndexedDB. Handles are structured
  //  cloneable and can be retrieved on subsequent page loads. These
  //  functions abstract opening the database, saving the handle, and
  //  retrieving it when the page initializes.
  function openHandleDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('timekeeper-db', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles');
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }
  async function saveBackupDirHandle(handle) {
    try {
      const db = await openHandleDB();
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'backupDir');
      return tx.complete;
    } catch (err) {
      console.error('Error saving backup handle:', err);
    }
  }
  async function loadBackupDirHandle() {
    try {
      const db = await openHandleDB();
      return await new Promise((resolve) => {
        const tx = db.transaction('handles', 'readonly');
        const getReq = tx.objectStore('handles').get('backupDir');
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }
  async function getBackupPermissionState(handle) {
    if (!handle) return 'missing';
    if (!handle.queryPermission) return 'granted';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (err) {
      return 'denied';
    }
  }
  async function ensureBackupPermissionWithPrompt(handle) {
    if (!handle) {
      backupPermissionState = 'missing';
      return false;
    }
    if (!handle.queryPermission) {
      backupPermissionState = 'granted';
      return true;
    }
    try {
      let status = await handle.queryPermission({ mode: 'readwrite' });
      if (status === 'granted') {
        backupPermissionState = 'granted';
        return true;
      }
      if (status === 'prompt' && handle.requestPermission) {
        status = await handle.requestPermission({ mode: 'readwrite' });
        backupPermissionState = status;
        return status === 'granted';
      }
      backupPermissionState = status || 'denied';
      return false;
    } catch (err) {
      backupPermissionState = 'denied';
      return false;
    }
  }
  function disableAutoSyncWithWarning(message) {
    autoSyncEnabled = false;
    localStorage.setItem('autoSyncEnabledPro', 'false');
    const toggle = document.getElementById('autoSyncToggle');
    if (toggle) {
      toggle.checked = false;
    }
    if (message) {
      backupWarningMessage = message;
    }
    updateAutoSyncStatus();
  }
  function processWorkoutWeekIfNeeded() {
    const today = new Date();
    const currentMonday = getWeekStart(today);
    const currentMondayKey = getWeekKey(currentMonday);
    const fitness = ensureFitnessDefaults();
    const normalizedLastKey = normalizeWeekKey(fitness.lastProcessedMonday);
    if (
      normalizedLastKey &&
      normalizedLastKey !== fitness.lastProcessedMonday
    ) {
      fitness.lastProcessedMonday = normalizedLastKey;
    }
    if (normalizedLastKey === currentMondayKey) {
      return;
    }
    let lastMonday = normalizedLastKey
      ? weekKeyToDate(normalizedLastKey)
      : null;
    if (!lastMonday || lastMonday >= currentMonday) {
      lastMonday = new Date(currentMonday);
      lastMonday.setDate(lastMonday.getDate() - 7);
    }
    lastMonday.setHours(0, 0, 0, 0);
    const maxIterations = 12; // guard against extremely stale data
    let iterations = 0;
    while (lastMonday < currentMonday && iterations < maxIterations) {
      const nextMonday = new Date(lastMonday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      finalizeFitnessWeek(lastMonday, nextMonday);
      lastMonday = nextMonday;
      iterations += 1;
    }
    saveData();
  }
  // Process any outstanding weeks immediately on load
  processWorkoutWeekIfNeeded();
  const todoForm = document.getElementById('todoForm');
  if (todoForm) {
    const intensityInput = document.getElementById('todoIntensity');
    const customIntensityInput = document.getElementById('todoCustomIntensity');
    const updateCustomIntensityVisibility = () => {
      if (!intensityInput || !customIntensityInput) return;
      if (intensityInput.value === 'custom') {
        customIntensityInput.style.display = '';
      } else {
        customIntensityInput.style.display = 'none';
        customIntensityInput.value = '';
      }
    };
    if (intensityInput && customIntensityInput) {
      intensityInput.addEventListener(
        'change',
        updateCustomIntensityVisibility
      );
      updateCustomIntensityVisibility();
    }
    todoForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('todoName');
      const whenInput = document.getElementById('todoWhen');
      const name = nameInput ? nameInput.value : '';
      const whenValue = whenInput && whenInput.value ? whenInput.value : '';
      const whenDate = whenValue ? new Date(whenValue) : new Date();
      if (!name.trim()) {
        alert('Workout name is required.');
        return;
      }
      if (isNaN(whenDate)) {
        alert('Please provide a valid date and time.');
        return;
      }
      let intensityValue = intensityInput ? intensityInput.value : 'medium';
      let intensityToSave = intensityValue;
      if (intensityValue === 'custom') {
        const raw = customIntensityInput ? customIntensityInput.value : '';
        const customPoints = sanitizeCustomPoints(raw);
        if (customPoints === null) {
          alert(
            'Please enter a valid custom intensity (positive number of points).'
          );
          return;
        }
        intensityToSave = makeCustomIntensity(customPoints);
      }
      logWorkoutEntry({
        name,
        intensity: intensityToSave,
        timestamp: whenDate
      });
      if (nameInput) nameInput.value = '';
      if (whenInput) whenInput.value = '';
      if (intensityInput) {
        intensityInput.value = 'medium';
      }
      if (customIntensityInput) {
        customIntensityInput.value = '';
      }
      updateCustomIntensityVisibility();
    });
  }
  // Ensure every project has a color and that colors are unique when possible.
  (function assignProjectColors() {
    const used = new Set();
    let assigned = false;
    data.projects.forEach((p) => {
      // If project has a color but it has already been used by a previous project, treat as missing
      if (!p.color || used.has(p.color)) {
        p.color = getUniqueColor();
        assigned = true;
      }
      used.add(p.color);
    });
    if (assigned) {
      saveData();
    }
  })();
  // Global variables to track recommended projects (by id)
  let _currentRecommendedWeeklyId = null;
  let currentRecommendedMonthlyId = null;
  // Load persisted auto sync preference
  const autoSyncPref = localStorage.getItem('autoSyncEnabledPro');
  if (autoSyncPref !== null) {
    autoSyncEnabled = autoSyncPref === 'true';
  }

  // Attempt to restore the backup directory handle from IndexedDB on load. If
  // a handle exists, assign it to the global backupDirHandle so that auto
  // sync can operate without requiring the user to pick a folder each
  // time the page loads.
  loadBackupDirHandle().then(async (handle) => {
    if (handle) {
      backupDirHandle = handle;
      const permissionState = await getBackupPermissionState(handle);
      backupPermissionState = permissionState;
      if (permissionState === 'granted') {
        backupWarningMessage = '';
        if (handle.name && data.backupDirName !== handle.name) {
          data.backupDirName = handle.name;
          try {
            localStorage.setItem('timekeeperDataPro', JSON.stringify(data));
          } catch (err) {
            // Ignore storage write errors; UI will still reflect the folder name.
          }
        }
      } else if (permissionState === 'prompt') {
        if (autoSyncEnabled) {
          disableAutoSyncWithWarning(
            'Auto sync paused: confirm access to your backup folder to resume syncing.'
          );
        } else {
          backupWarningMessage =
            'Confirm access to your backup folder to resume auto sync.';
        }
      } else {
        if (autoSyncEnabled) {
          disableAutoSyncWithWarning(
            'Auto sync disabled: permission to the backup folder was denied.'
          );
        } else {
          backupWarningMessage =
            'Permission to the backup folder was denied. Select it again to restore auto sync.';
        }
      }
    } else {
      backupDirHandle = null;
      backupPermissionState = 'missing';
      if (autoSyncEnabled) {
        disableAutoSyncWithWarning(
          'Auto sync disabled: no backup folder configured.'
        );
      }
    }
    updateAutoSyncStatus();
    updateFocusBlocker();
  });

  // -------------------------------------------------------------------------
  //  Webhook support and Todo functionality
  //
  //  These constants define the webhook endpoints that should be called when
  //  timers start and stop. They are used to toggle focus modes on the user's
  //  Android and Windows devices. When the first timer starts, the start
  //  webhooks are invoked; when all timers stop, the stop webhooks are invoked.
  const START_WEBHOOKS = ['http://127.0.0.1:8766/focus/start'];
  const STOP_WEBHOOKS = ['http://127.0.0.1:8766/focus/stop'];
  const FOCUS_BLOCK_THRESHOLD = 0.5;
  const FOCUS_BLOCKED_WEBSITES = [
    'reddit.com',
    'www.reddit.com',
    'old.reddit.com',
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be'
  ];

  function buildFocusWebhookUrl(rawUrl, payload) {
    if (!payload) return rawUrl;
    try {
      const url = new URL(rawUrl, window.location.href);
      url.searchParams.set('action', payload.action);
      url.searchParams.set(
        'paidFocus',
        String(Math.round(payload.paidFocus * 100))
      );
      url.searchParams.set(
        'threshold',
        String(Math.round(FOCUS_BLOCK_THRESHOLD * 100))
      );
      url.searchParams.set('blockedSites', FOCUS_BLOCKED_WEBSITES.join(','));
      return url.toString();
    } catch (err) {
      return rawUrl;
    }
  }

  // Send a ping to each URL in the list. Uses navigator.sendBeacon where
  // available to avoid blocking the page; falls back to fetch otherwise.
  function triggerWebhooks(urls, payload = null) {
    urls.forEach((u) => {
      const url = buildFocusWebhookUrl(u, payload);
      try {
        fetch(url, { method: 'GET', mode: 'no-cors', keepalive: true }).catch(
          () => {
            if (navigator.sendBeacon) navigator.sendBeacon(url);
          }
        );
      } catch (err) {
        if (navigator.sendBeacon) navigator.sendBeacon(url);
      }
    });
  }

  // Convenience wrappers to trigger start/stop webhooks.
  function triggerFocusStart(paidFocus) {
    triggerWebhooks(START_WEBHOOKS, { action: 'start', paidFocus });
  }
  function triggerFocusStop(paidFocus) {
    triggerWebhooks(STOP_WEBHOOKS, { action: 'stop', paidFocus });
  }

  // Track whether the focus blocker (external MacroDroid/Windows scripts) is currently active.
  // The blocker should only be enabled when the sum of all running timer factors exceeds 0.5.
  let focusBlockerActive = false;
  function updateFocusBlocker() {
    // Sum the factors of all running timers, excluding unpaid projects.
    const running = getRunningEntries();
    let total = 0;
    running.forEach((e) => {
      const project = data.projects.find(
        (p) => String(p.id) === String(e.projectId)
      );
      const hourlyRate = project ? Number(project.hourlyRate) : NaN;
      const isUnpaid = Number.isFinite(hourlyRate) && hourlyRate <= 0;
      if (isUnpaid) return;
      const factor =
        e.manualFactor != null
          ? e.manualFactor
          : e.factor || computeConcurrencyFactor(running.length);
      total += factor;
    });
    // Activate blocker if we cross the 50% threshold, deactivate if we drop below or equal.
    // The webhook receives the paid focus total and the website block list so the local
    // blocker can deny distracting domains while focused paid work is active.
    if (!focusBlockerActive && total > FOCUS_BLOCK_THRESHOLD) {
      focusBlockerActive = true;
      triggerFocusStart(total);
    } else if (focusBlockerActive && total <= FOCUS_BLOCK_THRESHOLD) {
      focusBlockerActive = false;
      triggerFocusStop(total);
    }
  }

  // Update the Workout section UI based on saved presets and weekly entries.
  // Presets capture frequently logged workouts, while the entries list shows
  // everything recorded for the current week with options to edit or remove.
  function commitFitnessMutation(mutator) {
    const fitness = ensureFitnessDefaults();
    mutator(fitness);
    saveData();
    updateTodoSection();
    updateGrocerySection();
  }

  function updateFitnessCards(force = false) {
    if (!force) {
      if (fitnessRenderQueued) return;
      fitnessRenderQueued = true;
      scheduleRender(() => {
        fitnessRenderQueued = false;
        updateFitnessCards(true);
      });
      return;
    }
    const summaryEl = document.getElementById('fitnessSummaryContent');
    const settingsEl = document.getElementById('fitnessSettingsContent');
    const fitness = ensureFitnessDefaults();
    const pointsInfo = collectWorkoutPoints();
    const workoutPlan = computeWorkoutWeekPlan({ fitness, pointsInfo });
    const settings = fitness.pointSettings || {};
    const multiplierPerPoint = Number(settings.multiplierPerPoint);
    const creditsPerPoint = Number(settings.creditsPerPoint);
    const effectiveMultiplierPerPoint = Number.isFinite(multiplierPerPoint)
      ? multiplierPerPoint
      : 0;
    const effectiveCreditsPerPoint = Number.isFinite(creditsPerPoint)
      ? creditsPerPoint
      : 0;
    const improvementPoints = Math.max(0, workoutPlan.baselineDelta);
    const currentMultiplier = clampMultiplier(fitness.currentMultiplier || 1);
    const nextMultiplier = clampMultiplier(
      typeof fitness.nextMultiplier === 'number'
        ? fitness.nextMultiplier
        : currentMultiplier
    );
    const projectedMultiplier = clampMultiplier(
      1 + effectiveMultiplierPerPoint * workoutPlan.planScheduleDelta
    );
    const weeklyBaseBudget =
      (data.groceryBudgetWeekly || 0) + (data.groceryBudgetWeeklyCarry || 0);
    const currentBudget = weeklyBaseBudget * currentMultiplier;
    const projectedBudget = weeklyBaseBudget * projectedMultiplier;
    const nextBudget = weeklyBaseBudget * nextMultiplier;
    const projectedCredits = improvementPoints * effectiveCreditsPerPoint;
    const pausedThisWeek = isWeekPaused(getWeekKey(new Date()));
    const boostEnabled = fitness.weekendBoostEnabled;
    const boostActive = isWeekendBoostActive();
    const boostUnlocked =
      fitness.weekendBoostUnlockedWeek === getWeekKey(new Date());
    const boostPercent = Math.round((fitness.weekendBoostPercent || 0) * 100);
    const lastWeek = fitness.lastWeekSummary || null;
    const formatAmount = (num) => {
      const str = formatCurrency(num, -1);
      return str ? str.replace(' kr', ' SEK') : '0 SEK';
    };
    const formatSignedCredits = (value) => {
      if (!Number.isFinite(value) || value === 0) return '0 credits';
      const prefix = value >= 0 ? '+' : '−';
      return prefix + Math.abs(value).toFixed(0) + ' credits';
    };
    if (summaryEl) {
      const grid = document.createElement('div');
      grid.className = 'fitness-summary-grid';
      function createRow(label, value, subText) {
        const row = document.createElement('div');
        row.className = 'fitness-summary-row';
        const labelEl = document.createElement('div');
        labelEl.className = 'fitness-summary-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('div');
        valueEl.className = 'fitness-summary-value';
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        if (subText) {
          const sub = document.createElement('div');
          sub.className = 'fitness-summary-sub';
          sub.textContent = subText;
          row.appendChild(sub);
        }
        grid.appendChild(row);
      }
      createRow(
        'Current multiplier',
        currentMultiplier.toFixed(2) + '×',
        'Weekly budget ' + formatAmount(currentBudget)
      );
      const projectedDelta = projectedBudget - weeklyBaseBudget;
      createRow(
        'Projected (if week ended today)',
        projectedMultiplier.toFixed(2) + '×',
        `${formatSignedCurrency(projectedDelta)} • ${formatSignedCredits(projectedCredits)}`
      );
      const nextDelta = nextBudget - weeklyBaseBudget;
      let nextSub = formatSignedCurrency(nextDelta);
      if (lastWeek) {
        if (lastWeek.paused) {
          nextSub += ' • Last week paused';
        } else {
          const lastPoints = Number.isFinite(lastWeek.totalPoints)
            ? lastWeek.totalPoints
            : 0;
          const lastRequired = Number.isFinite(lastWeek.requiredPoints)
            ? lastWeek.requiredPoints
            : 0;
          const lastExpected = Number.isFinite(lastWeek.expectedWeekPoints)
            ? lastWeek.expectedWeekPoints
            : null;
          const scheduledLabel =
            lastRequired > 0
              ? `${formatPoints(lastPoints)} / ${formatPoints(lastRequired)} pts`
              : `${formatPoints(lastPoints)} pts`;
          nextSub += ` • Last week ${scheduledLabel} scheduled`;
          if (lastExpected !== null) {
            nextSub += ` (baseline ${formatPoints(lastExpected)} pts)`;
          }
          if (
            Number.isFinite(lastWeek.scheduleDeltaEnd) &&
            Math.abs(lastWeek.scheduleDeltaEnd) >= 1
          ) {
            nextSub +=
              lastWeek.scheduleDeltaEnd >= 0
                ? ` • Ahead by ${formatPoints(lastWeek.scheduleDeltaEnd)} pts overall`
                : ` • Behind by ${formatPoints(Math.abs(lastWeek.scheduleDeltaEnd))} pts overall`;
          }
          if (
            Number.isFinite(lastWeek.creditsEarned) &&
            lastWeek.creditsEarned !== 0
          ) {
            nextSub += ' • ' + formatSignedCredits(lastWeek.creditsEarned);
          }
        }
      }
      if (pausedThisWeek) {
        nextSub += ' • This week paused';
      }
      createRow('Next week (locked)', nextMultiplier.toFixed(2) + '×', nextSub);

      const planValue =
        workoutPlan.planTotalPoints > 0
          ? `${formatPoints(workoutPlan.planActualPoints)} / ${formatPoints(workoutPlan.planTotalPoints)} pts`
          : `${formatPoints(workoutPlan.planActualPoints)} pts`;
      const planSubParts = [];
      const planStartLabel = formatDateKey(workoutPlan.planStart);
      const planEndLabel = formatDateKey(workoutPlan.planEndInclusive);
      if (planStartLabel && planEndLabel) {
        planSubParts.push(`${planStartLabel} -> ${planEndLabel}`);
      }
      if (workoutPlan.planTotalPoints > 0) {
        planSubParts.push(
          `Expected ${formatPoints(workoutPlan.planExpectedPoints)} pts (${workoutPlan.planTimeProgress.toFixed(0)}% elapsed)`
        );
        if (workoutPlan.planScheduleDelta >= 1) {
          planSubParts.push(
            `Ahead by ${formatPoints(workoutPlan.planScheduleDelta)} pts`
          );
        } else if (workoutPlan.planScheduleDelta <= -1) {
          planSubParts.push(
            `Behind by ${formatPoints(Math.abs(workoutPlan.planScheduleDelta))} pts`
          );
        } else {
          planSubParts.push('On track');
        }
      }
      createRow('Workout plan', planValue, planSubParts.join(' • '));

      const scheduledPoints = workoutPlan.requiredPoints;
      const pointsValue =
        scheduledPoints > 0
          ? `${formatPoints(workoutPlan.actualPoints)} / ${formatPoints(scheduledPoints)} pts`
          : `${formatPoints(workoutPlan.actualPoints)} pts`;
      const pointsSubParts = [];
      if (pausedThisWeek) {
        pointsSubParts.push('Paused');
      } else {
        pointsSubParts.push(
          `Scheduled ${formatPoints(scheduledPoints)} pts (baseline ${formatPoints(workoutPlan.expectedWeekPoints)} pts)`
        );
        pointsSubParts.push(
          `Expected ${formatPoints(workoutPlan.expectedPoints)} pts (${workoutPlan.timeProgress.toFixed(0)}% of week)`
        );
        if (workoutPlan.scheduleDelta >= 1) {
          pointsSubParts.push(
            `Ahead by ${formatPoints(workoutPlan.scheduleDelta)} pts`
          );
        } else if (workoutPlan.scheduleDelta <= -1) {
          pointsSubParts.push(
            `Behind by ${formatPoints(Math.abs(workoutPlan.scheduleDelta))} pts`
          );
        } else {
          pointsSubParts.push('On track');
        }
      }
      if (Math.abs(projectedDelta) >= 1 || improvementPoints > 0) {
        const budgetGain = formatSignedCurrency(projectedDelta);
        const creditGain = formatSignedCredits(projectedCredits);
        pointsSubParts.push(`Potential ${budgetGain}, ${creditGain}`);
      }
      const pointsSub = pointsSubParts.join(' • ');
      createRow('Points this week', pointsValue, pointsSub);
      const intensityParts = [];
      [
        {
          key: 'strava',
          label: 'Strava',
          formatter: (pts) => formatPoints(pts)
        },
        {
          key: 'intense',
          label: 'Intense',
          formatter: (pts) => formatPoints(pts)
        },
        {
          key: 'medium',
          label: 'Medium',
          formatter: (pts) => formatPoints(pts)
        },
        { key: 'light', label: 'Light', formatter: (pts) => formatPoints(pts) },
        {
          key: 'custom',
          label: 'Custom',
          formatter: (pts) =>
            formatCustomIntensityValue(pts) || formatPoints(pts, 2)
        }
      ].forEach(({ key, label, formatter }) => {
        const count = pointsInfo.counts[key] || 0;
        if (count > 0) {
          const pts = pointsInfo.pointsByIntensity[key] || 0;
          intensityParts.push(`${label}: ${count} (${formatter(pts)} pts)`);
        }
      });
      createRow(
        'Activity mix',
        intensityParts.length
          ? intensityParts.join(' • ')
          : 'No activities logged yet',
        null
      );
      const creditsRow = document.createElement('div');
      creditsRow.className = 'fitness-pill-row';
      const creditsPill = document.createElement('span');
      creditsPill.className = 'fitness-pill';
      creditsPill.textContent =
        'Wellness Credits: ' +
        formatCurrency(fitness.wellnessCredits || 0, -1).replace(' kr', ' SEK');
      creditsRow.appendChild(creditsPill);
      if (fitness.creditsCap) {
        const capPill = document.createElement('span');
        capPill.className = 'fitness-pill muted';
        capPill.textContent =
          'Cap ' +
          formatCurrency(fitness.creditsCap, -1).replace(' kr', ' SEK');
        creditsRow.appendChild(capPill);
      }
      if (fitness.streakCount && fitness.streakCount > 0) {
        const streakPill = document.createElement('span');
        streakPill.className = 'fitness-pill warm';
        streakPill.textContent =
          '🔥 Streak ' +
          fitness.streakCount +
          ' week' +
          (fitness.streakCount === 1 ? '' : 's');
        creditsRow.appendChild(streakPill);
      }
      if (improvementPoints > 0) {
        const potentialPill = document.createElement('span');
        potentialPill.className = 'fitness-pill accent';
        potentialPill.textContent =
          'Projected ' + formatSignedCredits(projectedCredits);
        creditsRow.appendChild(potentialPill);
      }
      const fragment = document.createDocumentFragment();
      fragment.appendChild(grid);
      fragment.appendChild(creditsRow);
      const boostRow = document.createElement('div');
      boostRow.className = 'fitness-summary-row';
      const boostLabel = document.createElement('div');
      boostLabel.className = 'fitness-summary-label';
      boostLabel.textContent = 'Weekend boost';
      const boostValue = document.createElement('div');
      boostValue.className = 'fitness-summary-value';
      if (!boostEnabled) {
        boostValue.textContent = 'Disabled';
      } else if (boostActive) {
        boostValue.textContent = 'Unlocked: +' + boostPercent + '% on Treats';
      } else if (boostUnlocked) {
        boostValue.textContent =
          'Unlocked – waiting for weekend (+' + boostPercent + '%)';
      } else if (pausedThisWeek) {
        boostValue.textContent = 'Paused this week';
      } else {
        boostValue.textContent =
          'Reach the weekly point target by Friday to unlock (+' +
          boostPercent +
          '%)';
      }
      boostRow.appendChild(boostLabel);
      boostRow.appendChild(boostValue);
      fragment.appendChild(boostRow);
      summaryEl.replaceChildren(...fragment.childNodes);
    }
    if (settingsEl) {
      if (!settingsEl.dataset.initialized) {
        settingsEl.dataset.initialized = 'true';
        const settingsGrid = document.createElement('div');
        settingsGrid.className = 'fitness-settings-grid';
        const controls = {};
        function appendSetting(labelText, control) {
          const row = document.createElement('div');
          row.className = 'fitness-setting-row';
          const label = document.createElement('label');
          label.textContent = labelText;
          row.appendChild(label);
          row.appendChild(control);
          settingsGrid.appendChild(row);
        }
        function registerControl(key, control) {
          controls[key] = control;
          return control;
        }
        function createPointInput(key, labelText) {
          const input = registerControl(key, document.createElement('input'));
          input.type = 'number';
          input.step = '0.5';
          input.min = '0';
          input.addEventListener('change', () => {
            const val = parseFloat(input.value);
            const defaults = makeDefaultFitness().pointSettings;
            commitFitnessMutation((fit) => {
              if (!fit.pointSettings) fit.pointSettings = {};
              fit.pointSettings[key] = isNaN(val)
                ? defaults[key]
                : Math.max(0, val);
            });
          });
          appendSetting(labelText, input);
        }
        createPointInput('intense', 'Intense workout points');
        createPointInput('medium', 'Medium workout points');
        createPointInput('light', 'Light workout points');
        const planStartInput = registerControl(
          'planStartDate',
          document.createElement('input')
        );
        planStartInput.type = 'date';
        planStartInput.addEventListener('change', () => {
          const defaults = makeDefaultFitness().pointPlan;
          const parsed = parseLocalDateString(planStartInput.value);
          commitFitnessMutation((fit) => {
            if (!fit.pointPlan) fit.pointPlan = {};
            fit.pointPlan.startDate = parsed
              ? formatDateKey(parsed)
              : defaults.startDate;
          });
        });
        appendSetting('Workout plan start', planStartInput);
        const planEndInput = registerControl(
          'planEndDate',
          document.createElement('input')
        );
        planEndInput.type = 'date';
        planEndInput.addEventListener('change', () => {
          const defaults = makeDefaultFitness().pointPlan;
          const parsed = parseLocalDateString(planEndInput.value);
          commitFitnessMutation((fit) => {
            if (!fit.pointPlan) fit.pointPlan = {};
            fit.pointPlan.endDate = parsed
              ? formatDateKey(parsed)
              : defaults.endDate;
          });
        });
        appendSetting('Workout plan end', planEndInput);
        const planTotalInput = registerControl(
          'planTotalPoints',
          document.createElement('input')
        );
        planTotalInput.type = 'number';
        planTotalInput.step = '1';
        planTotalInput.min = '0';
        planTotalInput.addEventListener('change', () => {
          const val = parseFloat(planTotalInput.value);
          const defaults = makeDefaultFitness().pointPlan;
          commitFitnessMutation((fit) => {
            if (!fit.pointPlan) fit.pointPlan = {};
            fit.pointPlan.totalPoints = isNaN(val)
              ? defaults.totalPoints
              : Math.max(0, val);
          });
        });
        appendSetting('Workout plan budget (points)', planTotalInput);
        const multiplierInput = registerControl(
          'multiplierPerPoint',
          document.createElement('input')
        );
        multiplierInput.type = 'number';
        multiplierInput.step = '0.1';
        multiplierInput.min = '0';
        multiplierInput.addEventListener('change', () => {
          const val = parseFloat(multiplierInput.value);
          const defaults = makeDefaultFitness().pointSettings;
          commitFitnessMutation((fit) => {
            if (!fit.pointSettings) fit.pointSettings = {};
            const fallback = defaults.multiplierPerPoint || 0;
            fit.pointSettings.multiplierPerPoint = isNaN(val)
              ? fallback
              : Math.max(0, val) / 100;
          });
        });
        appendSetting('Budget change per point (%)', multiplierInput);
        const creditsPerPointInput = registerControl(
          'creditsPerPoint',
          document.createElement('input')
        );
        creditsPerPointInput.type = 'number';
        creditsPerPointInput.step = '1';
        creditsPerPointInput.min = '0';
        creditsPerPointInput.addEventListener('change', () => {
          const val = parseFloat(creditsPerPointInput.value);
          const defaults = makeDefaultFitness().pointSettings;
          commitFitnessMutation((fit) => {
            if (!fit.pointSettings) fit.pointSettings = {};
            fit.pointSettings.creditsPerPoint = isNaN(val)
              ? defaults.creditsPerPoint
              : Math.max(0, val);
          });
        });
        appendSetting('Credits per point', creditsPerPointInput);
        const creditsCapInput = registerControl(
          'creditsCap',
          document.createElement('input')
        );
        creditsCapInput.type = 'number';
        creditsCapInput.step = '1';
        creditsCapInput.min = '0';
        creditsCapInput.addEventListener('change', () => {
          const val = parseFloat(creditsCapInput.value);
          commitFitnessMutation((fit) => {
            fit.creditsCap = isNaN(val)
              ? makeDefaultFitness().creditsCap
              : Math.max(0, val);
          });
        });
        appendSetting('Credits cap', creditsCapInput);
        const boostToggle = registerControl(
          'boostToggle',
          document.createElement('input')
        );
        boostToggle.type = 'checkbox';
        boostToggle.addEventListener('change', () => {
          commitFitnessMutation((fit) => {
            fit.weekendBoostEnabled = boostToggle.checked;
          });
        });
        appendSetting('Enable weekend boost', boostToggle);
        const boostPercentInput = registerControl(
          'boostPercent',
          document.createElement('input')
        );
        boostPercentInput.type = 'number';
        boostPercentInput.step = '1';
        boostPercentInput.min = '0';
        boostPercentInput.addEventListener('change', () => {
          const val = parseFloat(boostPercentInput.value);
          commitFitnessMutation((fit) => {
            fit.weekendBoostPercent = isNaN(val)
              ? makeDefaultFitness().weekendBoostPercent
              : Math.max(0, val) / 100;
          });
        });
        appendSetting('Weekend boost percent', boostPercentInput);
        settingsEl.innerHTML = '';
        settingsEl.appendChild(settingsGrid);
        settingsEl._fitnessControls = controls;
      }
      const controls = settingsEl._fitnessControls || {};
      const liveFitness = ensureFitnessDefaults();
      const livePoints = liveFitness.pointSettings || {};
      if (controls.intense) {
        controls.intense.value = (Number(livePoints.intense) || 0).toString();
      }
      if (controls.medium) {
        controls.medium.value = (Number(livePoints.medium) || 0).toString();
      }
      if (controls.light) {
        controls.light.value = (Number(livePoints.light) || 0).toString();
      }
      const livePlan = liveFitness.pointPlan || {};
      if (controls.planStartDate) {
        controls.planStartDate.value =
          typeof livePlan.startDate === 'string' ? livePlan.startDate : '';
      }
      if (controls.planEndDate) {
        controls.planEndDate.value =
          typeof livePlan.endDate === 'string' ? livePlan.endDate : '';
      }
      if (controls.planTotalPoints) {
        controls.planTotalPoints.value = String(
          Math.max(0, Number(livePlan.totalPoints) || 0)
        );
      }
      if (controls.multiplierPerPoint) {
        const pct = Number(livePoints.multiplierPerPoint) || 0;
        controls.multiplierPerPoint.value = (pct * 100).toFixed(2);
      }
      if (controls.creditsPerPoint) {
        controls.creditsPerPoint.value = (
          Number(livePoints.creditsPerPoint) || 0
        ).toString();
      }
      if (controls.creditsCap) {
        const capVal =
          typeof liveFitness.creditsCap === 'number' &&
          isFinite(liveFitness.creditsCap)
            ? liveFitness.creditsCap
            : 0;
        controls.creditsCap.value = String(Math.max(0, capVal));
      }
      if (controls.boostToggle) {
        controls.boostToggle.checked = !!liveFitness.weekendBoostEnabled;
      }
      if (controls.boostPercent) {
        controls.boostPercent.value = (
          (liveFitness.weekendBoostPercent || 0) * 100
        ).toFixed(0);
      }
    }
  }

  function updateTodoSection() {
    const workouts = ensureWorkoutData();
    const fitnessData = ensureFitnessDefaults();
    const presetsContent = document.getElementById('workoutPresetsContent');
    const entriesContent = document.getElementById('workoutEntriesContent');
    const weekKey = getWeekKey(new Date());
    const pausedThisWeek = isWeekPaused(weekKey);
    const monday = getWeekStart(new Date());
    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);
    const weeklyPointsInfo = collectWorkoutPoints({
      start: monday,
      end: nextMonday
    });
    const weeklyEntries = workouts.entries
      .filter((entry) => {
        if (!entry || !entry.timestamp) return false;
        const dt = new Date(entry.timestamp);
        return !isNaN(dt) && dt >= monday && dt < nextMonday;
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const weeklyPlan = computeWorkoutWeekPlan({
      fitness: fitnessData,
      pointsInfo: weeklyPointsInfo,
      weekStart: monday,
      weekEnd: nextMonday
    });
    if (presetsContent) {
      presetsContent.innerHTML = '';
      const presets = workouts.presets
        .slice()
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );
      if (presets.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent =
          'Log a workout to create your first preset. Each unique name/intensity combination is saved automatically.';
        presetsContent.appendChild(empty);
      } else {
        presets.forEach((preset) => {
          const row = document.createElement('div');
          row.className = 'workout-preset-row';
          row.style.display = 'flex';
          row.style.justifyContent = 'space-between';
          row.style.alignItems = 'center';
          row.style.padding = '0.4rem 0';
          row.style.borderBottom = '1px solid #e2e8f0';
          const info = document.createElement('div');
          info.innerHTML = `<strong>${preset.name}</strong> • ${getIntensitySummary(preset.intensity)}`;
          row.appendChild(info);
          const actions = document.createElement('div');
          actions.style.display = 'flex';
          actions.style.gap = '0.4rem';
          const logBtn = document.createElement('button');
          logBtn.className = 'btn primary';
          logBtn.textContent = 'Log';
          logBtn.style.fontSize = '0.75rem';
          logBtn.addEventListener('click', () => {
            logWorkoutEntry({
              name: preset.name,
              intensity: preset.intensity,
              presetId: preset.id
            });
          });
          actions.appendChild(logBtn);
          const editBtn = document.createElement('button');
          editBtn.className = 'btn secondary';
          editBtn.textContent = 'Edit';
          editBtn.style.fontSize = '0.75rem';
          editBtn.addEventListener('click', () => {
            const newName = prompt('Preset name', preset.name || '');
            if (newName === null) return;
            const trimmed = newName.trim();
            if (!trimmed) {
              alert('Preset name cannot be empty.');
              return;
            }
            const newIntensity = prompt(
              'Intensity (intense / medium / light / custom points)',
              getIntensityPromptDefault(preset.intensity)
            );
            if (newIntensity === null) return;
            const normalized = normalizeIntensity(newIntensity);
            const existing = workouts.presets.find(
              (p) =>
                p.id !== preset.id &&
                p.name === trimmed &&
                normalizeIntensity(p.intensity) === normalized
            );
            if (existing) {
              workouts.entries.forEach((entry) => {
                if (entry.presetId === preset.id) {
                  entry.presetId = existing.id;
                  entry.name = existing.name;
                  entry.intensity = existing.intensity;
                }
              });
              deleteWorkoutPreset(preset.id);
            } else {
              preset.name = trimmed;
              preset.intensity = normalized;
              updateEntriesForPreset(preset);
            }
            saveData();
            updateFitnessCards();
            updateTodoSection();
          });
          actions.appendChild(editBtn);
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.fontSize = '0.75rem';
          deleteBtn.addEventListener('click', () => {
            if (!confirm('Delete this preset? Existing entries stay recorded.'))
              return;
            deleteWorkoutPreset(preset.id);
            saveData();
            updateFitnessCards();
            updateTodoSection();
          });
          actions.appendChild(deleteBtn);
          row.appendChild(actions);
          presetsContent.appendChild(row);
        });
      }
    }
    if (entriesContent) {
      entriesContent.innerHTML = '';
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.style.marginBottom = '0.5rem';
      const headerInfo = document.createElement('div');
      const totalWorkoutCount =
        weeklyEntries.length + (weeklyPointsInfo.counts.strava || 0);
      if (weeklyPlan.paused) {
        headerInfo.textContent = `This week: ${totalWorkoutCount} workout${totalWorkoutCount === 1 ? '' : 's'} • Week paused`;
      } else {
        headerInfo.textContent = `This week: ${totalWorkoutCount} workout${totalWorkoutCount === 1 ? '' : 's'} • ${formatPoints(weeklyPlan.actualPoints)} / ${formatPoints(weeklyPlan.requiredPoints)} pts scheduled`;
      }
      header.appendChild(headerInfo);
      const pauseLabel = document.createElement('label');
      pauseLabel.style.display = 'flex';
      pauseLabel.style.alignItems = 'center';
      pauseLabel.style.gap = '0.4rem';
      const pauseCheckbox = document.createElement('input');
      pauseCheckbox.type = 'checkbox';
      pauseCheckbox.checked = pausedThisWeek;
      pauseCheckbox.addEventListener('change', () => {
        setWeekPaused(weekKey, pauseCheckbox.checked);
        updateFitnessCards();
        updateTodoSection();
      });
      pauseLabel.appendChild(pauseCheckbox);
      const pauseText = document.createElement('span');
      pauseText.textContent = 'Pause this week';
      pauseLabel.appendChild(pauseText);
      header.appendChild(pauseLabel);
      entriesContent.appendChild(header);
      if (weeklyEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = pausedThisWeek
          ? 'Week paused – no workouts required.'
          : 'No workouts logged yet this week.';
        entriesContent.appendChild(empty);
      } else {
        weeklyEntries.forEach((entry) => {
          const row = document.createElement('div');
          row.className = 'workout-entry-row';
          row.style.display = 'flex';
          row.style.justifyContent = 'space-between';
          row.style.alignItems = 'center';
          row.style.borderBottom = '1px solid #e2e8f0';
          row.style.padding = '0.5rem 0';
          const info = document.createElement('div');
          info.innerHTML = `<strong>${entry.name}</strong> • ${getIntensitySummary(entry.intensity)} • ${formatWorkoutTimestamp(entry.timestamp)}`;
          row.appendChild(info);
          const actions = document.createElement('div');
          actions.style.display = 'flex';
          actions.style.gap = '0.4rem';
          const editBtn = document.createElement('button');
          editBtn.className = 'btn secondary';
          editBtn.textContent = 'Edit';
          editBtn.style.fontSize = '0.75rem';
          editBtn.addEventListener('click', () => {
            const newName = prompt('Workout name', entry.name || '');
            if (newName === null) return;
            const trimmed = newName.trim();
            if (!trimmed) {
              alert('Workout name cannot be empty.');
              return;
            }
            const newIntensity = prompt(
              'Intensity (intense / medium / light / custom points)',
              getIntensityPromptDefault(entry.intensity)
            );
            if (newIntensity === null) return;
            const timeDefault = formatTimestampForInput(
              entry.timestamp
            ).replace('T', ' ');
            const newTimeRaw = prompt(
              'When? (YYYY-MM-DD HH:MM, leave blank to keep current)',
              timeDefault
            );
            if (newTimeRaw === null) return;
            let newTimestamp = entry.timestamp;
            if (newTimeRaw.trim()) {
              const parsed = parseDateTimeInput(newTimeRaw);
              if (!parsed) {
                alert('Invalid date or time.');
                return;
              }
              newTimestamp = parsed.toISOString();
            }
            updateWorkoutEntry(entry.id, {
              name: trimmed,
              intensity: newIntensity,
              timestamp: newTimestamp
            });
          });
          actions.appendChild(editBtn);
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.fontSize = '0.75rem';
          deleteBtn.addEventListener('click', () => {
            if (!confirm('Delete this workout entry?')) return;
            deleteWorkoutEntry(entry.id);
          });
          actions.appendChild(deleteBtn);
          row.appendChild(actions);
          entriesContent.appendChild(row);
        });
      }
    }
  }
  function updateGrocerySection(force = false) {
    if (!force) {
      if (groceryRenderQueued) return;
      groceryRenderQueued = true;
      scheduleRender(() => {
        groceryRenderQueued = false;
        updateGrocerySection(true);
      });
      return;
    }
    resetGroceriesIfNeeded();
    const weeklyListEl = document.getElementById('weeklyGroceryList');
    const monthlyListEl = document.getElementById('monthlyGroceryList');
    const biannualListEl = document.getElementById('biannualGroceryList');
    const summaryContainer = document.getElementById('budgetSummaryContainer');
    const recurringListEl = document.getElementById('monthlyRecurringList');
    if (
      !weeklyListEl ||
      !monthlyListEl ||
      !biannualListEl ||
      !summaryContainer ||
      !recurringListEl
    )
      return;
    renderWealthHistoryTable();
    updateWealthDashboard();
    const groceries = Array.isArray(data.groceries) ? data.groceries : [];
    const recurringPayments = ensureMonthlyRecurringPayments();
    const recurringTotal = getMonthlyRecurringTotal(recurringPayments);
    let normalizedAny = false;
    const weeklyFragment = document.createDocumentFragment();
    const monthlyFragment = document.createDocumentFragment();
    const biannualFragment = document.createDocumentFragment();
    // Determine period boundaries for weekly, monthly and biannual budgets
    const now = new Date();
    // Weekly boundaries (Monday to next Monday) for spending
    const dayOfWeek = now.getDay();
    const diffToMon = (dayOfWeek + 6) % 7;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMon
    );
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Monthly boundaries (1st to next 1st) for spending
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    // Biannual boundaries based on start date
    let halfStart;
    let halfEnd;
    {
      // Determine budgeting start date; if not set, default to current date (start of month)
      let startDate = parseLocalDateString(data.groceryBudgetStartDate);
      if (!startDate) {
        // default to first day of current month
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        data.groceryBudgetStartDate = formatLocalDateString(startDate);
        // persist start date
        saveData();
      }
      startDate.setHours(0, 0, 0, 0);
      // Compute months difference between startDate and now
      const monthsDiff =
        (now.getFullYear() - startDate.getFullYear()) * 12 +
        (now.getMonth() - startDate.getMonth());
      const halfIndex = Math.floor(monthsDiff / 6);
      halfStart = new Date(
        startDate.getFullYear(),
        startDate.getMonth() + halfIndex * 6,
        startDate.getDate()
      );
      halfStart.setHours(0, 0, 0, 0);
      halfEnd = new Date(
        startDate.getFullYear(),
        startDate.getMonth() + (halfIndex + 1) * 6,
        startDate.getDate()
      );
      halfEnd.setHours(0, 0, 0, 0);
    }
    // Compute amount spent in each period
    let weeklySpent = 0;
    let monthlySpent = 0;
    let biannualSpent = 0;
    groceries.forEach((it) => {
      if (!it || !it.archived || !it.purchasedDate) return;
      const cost = Number(it.cost);
      if (!Number.isFinite(cost)) return;
      const freq =
        typeof it.frequency === 'string'
          ? it.frequency.toLowerCase()
          : 'weekly';
      if (it.frequency !== freq) {
        it.frequency = freq;
        normalizedAny = true;
      }
      const pd = new Date(it.purchasedDate);
      if (isNaN(pd)) return;
      if (freq === 'weekly' && pd >= weekStart && pd < weekEnd) {
        weeklySpent += cost;
      }
      if (freq === 'monthly' && pd >= monthStart && pd < monthEnd) {
        monthlySpent += cost;
      }
      if (freq === 'biannual' && pd >= halfStart && pd < halfEnd) {
        biannualSpent += cost;
      }
    });
    monthlySpent += recurringTotal;

    const recurringFragment = document.createDocumentFragment();
    if (recurringPayments.length === 0) {
      const empty = document.createElement('li');
      empty.style.fontSize = '0.8rem';
      empty.style.color = '#64748b';
      empty.textContent = 'No recurring payments added.';
      recurringFragment.appendChild(empty);
    } else {
      recurringPayments.forEach((payment) => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';
        li.style.padding = '0.5rem 0';
        li.style.borderBottom = '1px solid #f1f5f9';

        const info = document.createElement('span');
        info.style.fontWeight = '600';
        const amountLabel = formatCurrency(payment.amount || 0, -1).replace(
          ' kr',
          ' SEK'
        );
        info.textContent = `${payment.name || 'Recurring payment'} – ${amountLabel}`;
        li.appendChild(info);

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '0.4rem';

        const editBtn = document.createElement('button');
        editBtn.className = 'btn secondary';
        editBtn.style.fontSize = '0.7rem';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => {
          const newName = prompt('Payment name', payment.name || '');
          if (newName === null) return;
          const trimmedName = newName.trim();
          if (!trimmedName) {
            alert('Payment name cannot be empty.');
            return;
          }
          const newAmountStr = prompt(
            'Monthly amount (SEK)',
            String(payment.amount || 0)
          );
          if (newAmountStr === null) return;
          const newAmount = parseFloat(newAmountStr);
          if (!Number.isFinite(newAmount) || newAmount < 0) {
            alert('Enter a valid amount.');
            return;
          }
          payment.name = trimmedName;
          payment.amount = newAmount;
          saveData();
          updateGrocerySection();
        });
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn danger';
        deleteBtn.style.fontSize = '0.7rem';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          if (!confirm('Remove this recurring payment?')) return;
          data.monthlyRecurringPayments = data.monthlyRecurringPayments.filter(
            (p) => p.id !== payment.id
          );
          saveData();
          updateGrocerySection();
        });
        actions.appendChild(deleteBtn);

        li.appendChild(actions);
        recurringFragment.appendChild(li);
      });
    }
    recurringListEl.replaceChildren(...recurringFragment.childNodes);

    // After rendering active items, render archived purchases with ability to edit cost
    const archivedListEl = document.getElementById('archivedGroceryList');
    if (archivedListEl) {
      const archivedFragment = document.createDocumentFragment();
      groceries.forEach((archItem, archIndex) => {
        if (!archItem.archived) return;
        const liArch = document.createElement('li');
        liArch.style.display = 'flex';
        liArch.style.flexDirection = 'column';
        liArch.style.gap = '0.3rem';
        liArch.style.padding = '0.5rem 0';
        liArch.style.borderBottom = '1px solid #f1f5f9';
        // Row containing details and action buttons
        const rowArch = document.createElement('div');
        rowArch.style.display = 'flex';
        rowArch.style.justifyContent = 'space-between';
        rowArch.style.alignItems = 'center';
        // Details span: name – cost – frequency – purchase date
        const detailsSpan = document.createElement('span');
        let dateStr = '';
        const freq =
          typeof archItem.frequency === 'string'
            ? archItem.frequency.toLowerCase()
            : 'weekly';
        if (archItem.frequency !== freq) {
          archItem.frequency = freq;
          normalizedAny = true;
        }
        if (archItem.purchasedDate) {
          const dt = new Date(archItem.purchasedDate);
          dateStr = dt.toLocaleDateString();
        }
        const costNum = Number(archItem.cost);
        const costString = Number.isFinite(costNum)
          ? formatCurrency(costNum, -1).replace(' kr', ' SEK')
          : '0 SEK';
        const parts = [`${archItem.name}`, costString];
        const originalCostNum = Number(archItem.originalCost);
        if (Number.isFinite(originalCostNum) && originalCostNum !== costNum) {
          const originalString = formatCurrency(originalCostNum, -1).replace(
            ' kr',
            ' SEK'
          );
          let creditNote = `original ${originalString}`;
          const appliedCreditsNum = Number(archItem.appliedCredits);
          if (Number.isFinite(appliedCreditsNum) && appliedCreditsNum > 0) {
            creditNote += `, credits −${formatCurrency(appliedCreditsNum, -1).replace(' kr', ' SEK')}`;
          }
          parts.push(creditNote);
        }
        const freqLabel = freq.charAt(0).toUpperCase() + freq.slice(1);
        parts.push(freqLabel);
        if (dateStr) parts.push(dateStr);
        detailsSpan.textContent = parts.join(' – ');
        rowArch.appendChild(detailsSpan);
        if (archItem.boostApplied && archItem.boostPercentApplied) {
          const boostNote = document.createElement('div');
          boostNote.className = 'treat-note archived';
          boostNote.textContent =
            'Weekend Boost covered ' +
            Math.round(
              (archItem.boostPercentApplied ||
                (typeof fitness !== 'undefined' && fitness.weekendBoostPercent
                  ? fitness.weekendBoostPercent
                  : 0)) * 100
            ) +
            '%';
          liArch.appendChild(boostNote);
        }
        // Action buttons for archived items
        const btnGroupArch = document.createElement('div');
        // Edit archived item: allows editing cost
        const editArchBtn = document.createElement('button');
        editArchBtn.className = 'btn secondary';
        editArchBtn.textContent = 'Edit';
        editArchBtn.style.fontSize = '0.7rem';
        editArchBtn.addEventListener('click', () => {
          // Prompt for new cost
          let newCostStr = prompt(
            'Edit cost of this item (SEK)',
            String(archItem.cost || 0)
          );
          if (newCostStr === null) return;
          let newCostVal = parseFloat(newCostStr);
          if (isNaN(newCostVal)) newCostVal = 0;
          archItem.cost = newCostVal;
          // Update purchase date to now if none exists
          if (!archItem.purchasedDate) {
            archItem.purchasedDate = new Date().toISOString();
          }
          saveData();
          updateGrocerySection();
          if (typeof provideHaptic === 'function') {
            provideHaptic('beep');
          }
        });
        btnGroupArch.appendChild(editArchBtn);
        // Delete archived item
        const deleteArchBtn = document.createElement('button');
        deleteArchBtn.className = 'btn danger';
        deleteArchBtn.textContent = 'Delete';
        deleteArchBtn.style.fontSize = '0.7rem';
        deleteArchBtn.addEventListener('click', () => {
          data.groceries.splice(archIndex, 1);
          saveData();
          updateGrocerySection();
        });
        btnGroupArch.appendChild(deleteArchBtn);
        rowArch.appendChild(btnGroupArch);
        liArch.appendChild(rowArch);
        archivedFragment.appendChild(liArch);
      });
      archivedListEl.replaceChildren(...archivedFragment.childNodes);
    }
    // Dynamic budgets = base + carry
    const fitness = ensureFitnessDefaults();
    const currentMultiplier = clampMultiplier(fitness.currentMultiplier || 1);
    const nextMultiplier = clampMultiplier(
      typeof fitness.nextMultiplier === 'number'
        ? fitness.nextMultiplier
        : currentMultiplier
    );
    const weeklyBaseBudget = data.groceryBudgetWeekly || 0;
    const monthlyBaseBudget = data.groceryBudgetMonthly || 0;
    const biBaseBudget = data.groceryBudgetBiYearly || 0;
    const weeklyBaseWithCarry =
      weeklyBaseBudget + (data.groceryBudgetWeeklyCarry || 0);
    const monthlyDynamicBudget =
      monthlyBaseBudget + (data.groceryBudgetMonthlyCarry || 0);
    const biDynamicBudget =
      biBaseBudget + (data.groceryBudgetBiYearlyCarry || 0);
    const weeklyDynamicBudget = weeklyBaseWithCarry * currentMultiplier;
    const nextWeekBudget = weeklyBaseWithCarry * nextMultiplier;
    // Time progress for budgets (fraction of period elapsed)
    const weekTimeProgress = clampUnitInterval(
      (now - weekStart) / (weekEnd - weekStart)
    );
    const monthTimeProgress = clampUnitInterval(
      (now - monthStart) / (monthEnd - monthStart)
    );
    const halfTimeProgress = clampUnitInterval(
      (now - halfStart) / (halfEnd - halfStart)
    );
    // Expected spending so far
    const weeklyExpectedSpent = weeklyDynamicBudget * weekTimeProgress;
    const monthlyExpectedSpent = monthlyDynamicBudget * monthTimeProgress;
    const biExpectedSpent = biDynamicBudget * halfTimeProgress;
    // Build budget summary card
    const summaryCard = document.createElement('div');
    summaryCard.className = 'card';
    summaryCard.style.marginBottom = '1rem';
    const summaryTitle = document.createElement('h3');
    summaryTitle.style.margin = '0 0 0.5rem 0';
    summaryTitle.style.fontSize = '1.1rem';
    summaryTitle.style.fontWeight = '600';
    summaryTitle.textContent = 'Budget Summary';
    summaryCard.appendChild(summaryTitle);
    function addBudgetLine(label, spent, budget, expected) {
      const line = document.createElement('div');
      line.style.fontSize = '0.85rem';
      line.style.marginBottom = '0.25rem';
      // Format currency to nearest ten (use existing formatCurrency)
      const spentStr = formatCurrency(spent || 0, -1);
      const budgetStr = formatCurrency(budget || 0, -1);
      const expectedStr = formatCurrency(expected || 0, -1);
      line.textContent = `${label}: ${spentStr} / ${budgetStr} SEK (expected ${expectedStr} SEK)`;
      summaryCard.appendChild(line);
      // Create multi progress bar for budgets
      const pb = document.createElement('div');
      pb.className = 'progress-bar multi';
      pb.style.marginBottom = '0.4rem';
      // Expected fill (black)
      const expectedFill = document.createElement('div');
      expectedFill.className = 'expected-fill';
      expectedFill.style.width =
        budget > 0
          ? Math.min(100, (expected / budget) * 100).toFixed(1) + '%'
          : '0%';
      pb.appendChild(expectedFill);
      // Actual fill (blue)
      const actualFill = document.createElement('div');
      actualFill.className = 'hours-fill';
      actualFill.style.width =
        budget > 0
          ? Math.min(100, (spent / budget) * 100).toFixed(1) + '%'
          : '0%';
      pb.appendChild(actualFill);
      summaryCard.appendChild(pb);
    }
    addBudgetLine(
      'Weekly',
      weeklySpent,
      weeklyDynamicBudget,
      weeklyExpectedSpent
    );
    const multiplierLine = document.createElement('div');
    multiplierLine.className = 'fitness-summary-sub';
    multiplierLine.textContent =
      'Fitness Multiplier next week: ' +
      nextMultiplier.toFixed(2) +
      '× (' +
      formatSignedCurrency(nextWeekBudget - weeklyBaseWithCarry) +
      ')';
    summaryCard.appendChild(multiplierLine);
    const creditsLine = document.createElement('div');
    creditsLine.className = 'fitness-summary-sub';
    creditsLine.textContent =
      'Wellness Credits: ' +
      formatCurrency(fitness.wellnessCredits || 0, -1).replace(' kr', ' SEK') +
      ' (auto-applied)';
    summaryCard.appendChild(creditsLine);
    addBudgetLine(
      'Monthly',
      monthlySpent,
      monthlyDynamicBudget,
      monthlyExpectedSpent
    );
    if (recurringTotal > 0) {
      const recurringLine = document.createElement('div');
      recurringLine.className = 'fitness-summary-sub';
      recurringLine.textContent =
        'Recurring payments this month: ' +
        formatCurrency(recurringTotal, -1).replace(' kr', ' SEK');
      summaryCard.appendChild(recurringLine);
    }
    addBudgetLine('Biannual', biannualSpent, biDynamicBudget, biExpectedSpent);
    // Add edit buttons for budgets and start date
    const controlsDiv = document.createElement('div');
    controlsDiv.style.display = 'flex';
    controlsDiv.style.gap = '0.5rem';
    controlsDiv.style.marginTop = '0.5rem';
    // Edit budgets button
    const editBudgetsBtn = document.createElement('button');
    editBudgetsBtn.className = 'btn secondary';
    editBudgetsBtn.style.fontSize = '0.75rem';
    editBudgetsBtn.textContent = 'Edit Budgets';
    editBudgetsBtn.addEventListener('click', () => {
      const w = prompt(
        'Weekly budget (SEK)',
        String(data.groceryBudgetWeekly || 0)
      );
      const m = prompt(
        'Monthly budget (SEK)',
        String(data.groceryBudgetMonthly || 0)
      );
      const b = prompt(
        'Biannual budget (SEK)',
        String(data.groceryBudgetBiYearly || 0)
      );
      if (w !== null) {
        const val = parseFloat(w);
        if (!isNaN(val)) data.groceryBudgetWeekly = val;
      }
      if (m !== null) {
        const val = parseFloat(m);
        if (!isNaN(val)) data.groceryBudgetMonthly = val;
      }
      if (b !== null) {
        const val = parseFloat(b);
        if (!isNaN(val)) data.groceryBudgetBiYearly = val;
      }
      saveData();
      updateGrocerySection();
    });
    controlsDiv.appendChild(editBudgetsBtn);
    // Edit start date button
    const editStartBtn = document.createElement('button');
    editStartBtn.className = 'btn secondary';
    editStartBtn.style.fontSize = '0.75rem';
    editStartBtn.textContent = 'Set Start Date';
    editStartBtn.addEventListener('click', () => {
      const d = prompt(
        'Start date for biannual budget periods (YYYY-MM-DD)',
        data.groceryBudgetStartDate || ''
      );
      if (!d) return;
      const parsed = parseLocalDateString(d);
      if (!parsed) return;
      const normalized = formatLocalDateString(parsed);
      if (data.groceryBudgetStartDate !== normalized) {
        data.groceryBudgetStartDate = normalized;
        saveData();
      }
      updateGrocerySection();
    });
    controlsDiv.appendChild(editStartBtn);
    summaryCard.appendChild(controlsDiv);
    if (summaryCard instanceof DocumentFragment) {
      summaryContainer.replaceChildren(...summaryCard.childNodes);
    } else {
      summaryContainer.replaceChildren(summaryCard);
    }
    // ------------------------------------------------------------
    // In budget-only mode we do not limit the number of items that can be
    // purchased in a period.  We therefore do not compute or display
    // purchase quotas, and buy buttons remain enabled regardless of
    // how many items have been purchased.
    // Render unarchived items
    const boostEnabled = fitness.weekendBoostEnabled;
    const boostActive = isWeekendBoostActive();
    const boostUnlocked =
      fitness.weekendBoostUnlockedWeek === getWeekKey(new Date());
    const boostPercentDisplay = Math.round(
      (fitness.weekendBoostPercent || 0) * 100
    );
    groceries.forEach((item, index) => {
      if (item.archived) return;
      const freq =
        typeof item.frequency === 'string'
          ? item.frequency.toLowerCase()
          : 'weekly';
      if (item.frequency !== freq) {
        item.frequency = freq;
        normalizedAny = true;
      }
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.flexDirection = 'column';
      li.style.gap = '0.3rem';
      li.style.padding = '0.5rem 0';
      li.style.borderBottom = '1px solid #f1f5f9';
      // Row: name and actions
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.name;
      nameSpan.style.fontWeight = '600';
      if (item.category === 'treat') {
        const tag = document.createElement('span');
        tag.className = 'treat-tag';
        tag.textContent = 'Treat';
        tag.style.marginLeft = '0.35rem';
        nameSpan.appendChild(tag);
      } else if (item.category === 'essential') {
        const tag = document.createElement('span');
        tag.className = 'treat-tag muted';
        tag.textContent = 'Essential';
        tag.style.marginLeft = '0.35rem';
        nameSpan.appendChild(tag);
      }
      row.appendChild(nameSpan);
      const btnGroup = document.createElement('div');
      // Buy button (log purchase with cost). In budget-only mode there is
      // no limit on the number of purchases per period, so the button
      // is always enabled.
      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn';
      buyBtn.textContent = 'Buy';
      buyBtn.style.fontSize = '0.7rem';
      buyBtn.addEventListener('click', () => {
        // Prompt for cost
        let costStr = prompt('Enter cost of this item (SEK)', '0');
        if (costStr === null) return;
        let costVal = parseFloat(costStr);
        if (isNaN(costVal)) costVal = 0;
        const fitnessData = ensureFitnessDefaults();
        let originalCost = costVal;
        let creditsUsed = 0;
        let boostCreditsUsed = 0;
        let boostPercentApplied = 0;
        const itemFrequency =
          typeof item.frequency === 'string'
            ? item.frequency.toLowerCase()
            : 'weekly';
        if (itemFrequency === 'weekly') {
          const availableCredits = fitnessData.wellnessCredits || 0;
          let remainingCredits = availableCredits;
          if (
            fitnessData.weekendBoostEnabled &&
            item.category === 'treat' &&
            isWeekendBoostActive()
          ) {
            const boostPct = Math.max(0, fitnessData.weekendBoostPercent || 0);
            if (boostPct > 0) {
              const discount = originalCost * boostPct;
              boostCreditsUsed = Math.min(discount, remainingCredits);
              creditsUsed += boostCreditsUsed;
              remainingCredits -= boostCreditsUsed;
              boostPercentApplied = boostPct;
            }
          }
          const additionalCredits = Math.min(
            remainingCredits,
            Math.max(0, originalCost - creditsUsed)
          );
          creditsUsed += additionalCredits;
          fitnessData.wellnessCredits = Math.max(
            0,
            (fitnessData.wellnessCredits || 0) - creditsUsed
          );
          costVal = Math.max(0, originalCost - creditsUsed);
        }
        item.originalCost = originalCost;
        item.cost = costVal;
        item.appliedCredits = creditsUsed;
        item.boostApplied = boostCreditsUsed > 0;
        item.boostPercentApplied = boostPercentApplied;
        item.archived = true;
        item.purchasedDate = new Date().toISOString();
        saveData();
        updateGrocerySection();
        if (typeof updateTodoSection === 'function') {
          updateTodoSection();
        }
        if (typeof provideHaptic === 'function') {
          provideHaptic('beep');
        }
      });
      btnGroup.appendChild(buyBtn);
      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'btn secondary';
      editBtn.textContent = 'Edit';
      editBtn.style.fontSize = '0.7rem';
      editBtn.addEventListener('click', () => {
        const newName = prompt('Edit item name', item.name);
        if (newName !== null) {
          item.name = newName.trim();
        }
        const newFreq = prompt(
          'Frequency (weekly/monthly/biannual)',
          item.frequency
        );
        if (newFreq !== null) {
          const cleanedFreq = newFreq.trim().toLowerCase();
          if (
            cleanedFreq === 'weekly' ||
            cleanedFreq === 'monthly' ||
            cleanedFreq === 'biannual'
          ) {
            item.frequency = cleanedFreq;
          }
        }
        const newCategory = prompt(
          'Category (standard/treat/essential)',
          item.category || 'standard'
        );
        if (newCategory) {
          const cleaned = newCategory.toLowerCase();
          if (
            cleaned === 'standard' ||
            cleaned === 'treat' ||
            cleaned === 'essential'
          ) {
            item.category = cleaned;
          }
        }
        saveData();
        updateGrocerySection();
      });
      btnGroup.appendChild(editBtn);
      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = 'Delete';
      delBtn.style.fontSize = '0.7rem';
      delBtn.addEventListener('click', () => {
        data.groceries.splice(index, 1);
        saveData();
        updateGrocerySection();
      });
      btnGroup.appendChild(delBtn);
      row.appendChild(btnGroup);
      li.appendChild(row);
      if (item.category === 'treat') {
        const note = document.createElement('div');
        note.className = 'treat-note';
        if (!boostEnabled) {
          note.textContent = 'Treat item';
        } else if (boostActive) {
          note.textContent =
            'Weekend Boost applied: −' + boostPercentDisplay + '% from credits';
        } else if (boostUnlocked) {
          note.textContent =
            'Weekend Boost unlocked: +' +
            boostPercentDisplay +
            '% on Treats this weekend';
        } else {
          note.textContent =
            'Treat item – unlock +' + boostPercentDisplay + '% by Friday 18:00';
        }
        li.appendChild(note);
      }
      // Append to appropriate list
      if (freq === 'monthly') {
        monthlyFragment.appendChild(li);
      } else if (freq === 'biannual') {
        biannualFragment.appendChild(li);
      } else {
        weeklyFragment.appendChild(li);
      }
    });
    weeklyListEl.replaceChildren(...weeklyFragment.childNodes);
    monthlyListEl.replaceChildren(...monthlyFragment.childNodes);
    biannualListEl.replaceChildren(...biannualFragment.childNodes);
    updateFitnessCards();
    if (normalizedAny) {
      saveData();
    }
  }

  // Reset grocery budgets for weekly, monthly, and biannual periods. Carry-overs are recalculated
  // whenever we cross a boundary or when archived purchases are edited retroactively.
  function resetGroceriesIfNeeded() {
    const now = new Date();
    let dataChanged = false;
    const budgetStartDate = parseLocalDateString(data.groceryBudgetStartDate);
    if (budgetStartDate) {
      budgetStartDate.setHours(0, 0, 0, 0);
    }
    // Determine the start of this week (Monday at 00:00)
    const dow = now.getDay();
    const diffToMonday = (dow + 6) % 7;
    const thisMonday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMonday
    );
    thisMonday.setHours(0, 0, 0, 0);
    const mondayStr = thisMonday.toDateString();
    const prevMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekReset = localStorage.getItem('groceryWeeklyResetPro');
    const hasWeekReset =
      typeof lastWeekReset === 'string' && lastWeekReset.length > 0;
    let weeklySpentPrev = 0;
    if (Array.isArray(data.groceries)) {
      data.groceries.forEach((item) => {
        if (!item || !item.archived) return;
        const freq =
          typeof item.frequency === 'string'
            ? item.frequency.toLowerCase()
            : 'weekly';
        if (item.frequency !== freq) item.frequency = freq;
        if (freq !== 'weekly') return;
        const cost = Number(item.cost);
        if (!Number.isFinite(cost)) return;
        if (item.purchasedDate) {
          const pd = new Date(item.purchasedDate);
          if (pd >= prevMonday && pd < thisMonday) {
            weeklySpentPrev += cost;
          }
        } else {
          // Exclude legacy purchases without a recorded purchase date from budget calculations.
          // Optionally, assign a neutral date for consistency:
          item.purchasedDate = null;
          // Do not count their cost in weeklySpentPrev.
        }
      });
    }
    const baseBudget =
      typeof data.groceryBudgetWeekly === 'number'
        ? data.groceryBudgetWeekly
        : 0;
    const storedCarry =
      typeof data.groceryBudgetWeeklyCarry === 'number'
        ? data.groceryBudgetWeeklyCarry
        : 0;
    if (hasWeekReset) {
      const baselineCarry =
        lastWeekReset === mondayStr &&
        typeof data.groceryBudgetWeeklyCarryBaseline === 'number'
          ? data.groceryBudgetWeeklyCarryBaseline
          : storedCarry;
      const dynamicPrevBudget = baseBudget + baselineCarry;
      const newWeeklyCarry = dynamicPrevBudget - weeklySpentPrev;
      if (
        lastWeekReset !== mondayStr ||
        data.groceryBudgetWeeklyCarry !== newWeeklyCarry ||
        data.groceryBudgetWeeklyCarryBaseline !== baselineCarry
      ) {
        data.groceryBudgetWeeklyCarry = newWeeklyCarry;
        data.groceryBudgetWeeklyCarryBaseline = baselineCarry;
        localStorage.setItem('groceryWeeklyResetPro', mondayStr);
        dataChanged = true;
      }
    } else {
      localStorage.setItem('groceryWeeklyResetPro', mondayStr);
      if (data.groceryBudgetWeeklyCarry !== storedCarry) {
        data.groceryBudgetWeeklyCarry = storedCarry;
        dataChanged = true;
      }
      if (data.groceryBudgetWeeklyCarryBaseline !== storedCarry) {
        data.groceryBudgetWeeklyCarryBaseline = storedCarry;
        dataChanged = true;
      }
    }
    // Monthly carry-over recalculation
    const year = now.getFullYear();
    const month = now.getMonth();
    const thisMonthStart = new Date(year, month, 1);
    thisMonthStart.setHours(0, 0, 0, 0);
    const monthKey = year + '-' + month;
    const lastMonthReset = localStorage.getItem('groceryMonthlyResetPro');
    const hasMonthReset =
      typeof lastMonthReset === 'string' && lastMonthReset.length > 0;
    const prevMonthStart = new Date(year, month - 1, 1);
    const prevMonthEnd = new Date(year, month, 1);
    let monthlySpentPrev = 0;
    if (Array.isArray(data.groceries)) {
      data.groceries.forEach((item) => {
        if (!item || !item.archived) return;
        const freq =
          typeof item.frequency === 'string'
            ? item.frequency.toLowerCase()
            : 'weekly';
        if (item.frequency !== freq) item.frequency = freq;
        if (freq !== 'monthly') return;
        const cost = Number(item.cost);
        if (!Number.isFinite(cost)) return;
        if (item.purchasedDate) {
          const pd = new Date(item.purchasedDate);
          if (pd >= prevMonthStart && pd < prevMonthEnd) {
            monthlySpentPrev += cost;
          }
        } else {
          // Legacy monthly item without a purchasedDate: skip from monthlySpentPrev calculation.
          // Optionally, flag for user review or log a warning here.
          // No changes to item or monthlySpentPrev.
        }
      });
    }
    monthlySpentPrev += getMonthlyRecurringTotal();
    const baseBudgetM =
      typeof data.groceryBudgetMonthly === 'number'
        ? data.groceryBudgetMonthly
        : 0;
    const storedCarryM =
      typeof data.groceryBudgetMonthlyCarry === 'number'
        ? data.groceryBudgetMonthlyCarry
        : 0;
    const skipMonthlyCarry = !!(
      budgetStartDate && prevMonthEnd <= budgetStartDate
    );
    if (hasMonthReset && !skipMonthlyCarry) {
      const baselineCarryM =
        lastMonthReset === monthKey &&
        typeof data.groceryBudgetMonthlyCarryBaseline === 'number'
          ? data.groceryBudgetMonthlyCarryBaseline
          : storedCarryM;
      const dynamicPrevBudgetM = baseBudgetM + baselineCarryM;
      const newMonthlyCarry = dynamicPrevBudgetM - monthlySpentPrev;
      if (
        lastMonthReset !== monthKey ||
        data.groceryBudgetMonthlyCarry !== newMonthlyCarry ||
        data.groceryBudgetMonthlyCarryBaseline !== baselineCarryM
      ) {
        data.groceryBudgetMonthlyCarry = newMonthlyCarry;
        data.groceryBudgetMonthlyCarryBaseline = baselineCarryM;
        localStorage.setItem('groceryMonthlyResetPro', monthKey);
        dataChanged = true;
      }
    } else {
      const fallbackCarryM =
        typeof data.groceryBudgetMonthlyCarryBaseline === 'number'
          ? data.groceryBudgetMonthlyCarryBaseline
          : storedCarryM;
      localStorage.setItem('groceryMonthlyResetPro', monthKey);
      if (data.groceryBudgetMonthlyCarry !== fallbackCarryM) {
        data.groceryBudgetMonthlyCarry = fallbackCarryM;
        dataChanged = true;
      }
      if (data.groceryBudgetMonthlyCarryBaseline !== fallbackCarryM) {
        data.groceryBudgetMonthlyCarryBaseline = fallbackCarryM;
        dataChanged = true;
      }
    }
    // Biannual carry-over recalculation
    let startDate = budgetStartDate
      ? new Date(budgetStartDate.getTime())
      : null;
    if (!startDate) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    startDate.setHours(0, 0, 0, 0);
    const monthsDiff =
      (now.getFullYear() - startDate.getFullYear()) * 12 +
      (now.getMonth() - startDate.getMonth());
    const currentHalfIndex = Math.floor(monthsDiff / 6);
    const lastHalfReset = localStorage.getItem('groceryBiResetPro');
    const hasHalfReset =
      typeof lastHalfReset === 'string' && lastHalfReset.length > 0;
    const halfKey = String(currentHalfIndex);
    const prevHalfStart = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + (currentHalfIndex - 1) * 6,
      startDate.getDate()
    );
    const prevHalfEnd = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + currentHalfIndex * 6,
      startDate.getDate()
    );
    let biSpentPrevTotal = 0;
    if (Array.isArray(data.groceries)) {
      data.groceries.forEach((item) => {
        if (!item || !item.archived) return;
        const freq =
          typeof item.frequency === 'string'
            ? item.frequency.toLowerCase()
            : 'weekly';
        if (item.frequency !== freq) item.frequency = freq;
        if (freq !== 'biannual') return;
        const cost = Number(item.cost);
        if (!Number.isFinite(cost)) return;
        if (item.purchasedDate) {
          const pd = new Date(item.purchasedDate);
          if (pd >= prevHalfStart && pd < prevHalfEnd) {
            biSpentPrevTotal += cost;
          }
        } else {
          // Undated legacy biannual purchase: exclude from carry-over calculation.
          // Optionally, flag for review:
          item.needsDateAssignment = true;
        }
      });
    }
    const baseBudgetBi =
      typeof data.groceryBudgetBiYearly === 'number'
        ? data.groceryBudgetBiYearly
        : 0;
    const storedCarryBi =
      typeof data.groceryBudgetBiYearlyCarry === 'number'
        ? data.groceryBudgetBiYearlyCarry
        : 0;
    const skipBiCarry = !!(budgetStartDate && prevHalfEnd <= budgetStartDate);
    if (hasHalfReset && !skipBiCarry) {
      const baselineCarryBi =
        lastHalfReset === halfKey &&
        typeof data.groceryBudgetBiYearlyCarryBaseline === 'number'
          ? data.groceryBudgetBiYearlyCarryBaseline
          : storedCarryBi;
      const dynamicPrevBudgetBi = baseBudgetBi + baselineCarryBi;
      const newBiCarry = dynamicPrevBudgetBi - biSpentPrevTotal;
      if (
        lastHalfReset !== halfKey ||
        data.groceryBudgetBiYearlyCarry !== newBiCarry ||
        data.groceryBudgetBiYearlyCarryBaseline !== baselineCarryBi
      ) {
        data.groceryBudgetBiYearlyCarry = newBiCarry;
        data.groceryBudgetBiYearlyCarryBaseline = baselineCarryBi;
        localStorage.setItem('groceryBiResetPro', halfKey);
        dataChanged = true;
      }
    } else {
      const fallbackCarryBi =
        typeof data.groceryBudgetBiYearlyCarryBaseline === 'number'
          ? data.groceryBudgetBiYearlyCarryBaseline
          : storedCarryBi;
      localStorage.setItem('groceryBiResetPro', halfKey);
      if (data.groceryBudgetBiYearlyCarry !== fallbackCarryBi) {
        data.groceryBudgetBiYearlyCarry = fallbackCarryBi;
        dataChanged = true;
      }
      if (data.groceryBudgetBiYearlyCarryBaseline !== fallbackCarryBi) {
        data.groceryBudgetBiYearlyCarryBaseline = fallbackCarryBi;
        dataChanged = true;
      }
    }
    if (dataChanged) {
      saveData();
    }
  }

  // Render reports section including monthly heatmap and per-project burndown charts. This
  // function is called whenever navigating to the Reports section or when data is
  // updated (e.g., after modifying entries). It recomputes the heatmap for the
  // current month and builds burndown charts for each project using Chart.js.
  let burndownCharts = {};
  function updateAnalyticsSection() {
    const heatmapContainer = document.getElementById('heatmapContainer');
    const burndownContainer = document.getElementById('burndownContainer');
    if (!heatmapContainer || !burndownContainer) return;
    const isMobile =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 640px)').matches;
    const truncateLabel = (label, maxLen = 18) => {
      const text = String(label ?? '');
      if (text.length <= maxLen) return text;
      if (maxLen <= 3) return text.slice(0, Math.max(0, maxLen));
      return text.slice(0, maxLen - 3) + '...';
    };
    // On mobile, give charts a minimum width and allow horizontal scrolling to avoid
    // squished/stretched plots when there are many labels.
    const wrapChartForMobile = (canvas, minWidth = 680) => {
      if (!isMobile) return canvas;
      const scroll = document.createElement('div');
      scroll.style.overflowX = 'auto';
      scroll.style.webkitOverflowScrolling = 'touch';
      const inner = document.createElement('div');
      inner.style.minWidth = minWidth + 'px';
      inner.appendChild(canvas);
      scroll.appendChild(inner);
      return scroll;
    };
    // Clear previous contents
    heatmapContainer.innerHTML = '';
    burndownContainer.innerHTML = '';
    // ---------- Build monthly heatmap ----------
    // Determine the start and end of the current month
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    // Accumulate hours per day
    const hoursPerDay = {};
    // Initialize to zero for each day of month
    for (let d = 1; d <= daysInMonth; d++) {
      hoursPerDay[d] = 0;
    }
    data.entries.forEach((entry) => {
      if (entry.isRunning || !entry.duration) return;
      const start = new Date(entry.startTime);
      if (start.getFullYear() === year && start.getMonth() === month) {
        const day = start.getDate();
        hoursPerDay[day] = (hoursPerDay[day] || 0) + entry.duration / 3600;
      }
    });
    // Compute maximum hours for scaling colors
    let maxHours = 0;
    Object.values(hoursPerDay).forEach((h) => {
      if (h > maxHours) maxHours = h;
    });
    // Build a 7-column table starting on Monday (0=Monday). We will map JS getDay (0=Sunday) to Monday start.
    const heatmapTable = document.createElement('table');
    heatmapTable.style.width = '100%';
    heatmapTable.style.borderCollapse = 'collapse';
    const headerRow = document.createElement('tr');
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((dName) => {
      const th = document.createElement('th');
      th.textContent = dName;
      th.style.textAlign = 'center';
      th.style.padding = '0.25rem';
      th.style.fontSize = '0.75rem';
      headerRow.appendChild(th);
    });
    heatmapTable.appendChild(headerRow);
    // Determine the weekday index of the first day (0=Monday, 6=Sunday)
    const firstDow = (firstDay.getDay() + 6) % 7;
    let currentDay = 1;
    // We'll build up to 6 rows to cover all days
    for (let week = 0; week < 6; week++) {
      const tr = document.createElement('tr');
      for (let dow = 0; dow < 7; dow++) {
        const td = document.createElement('td');
        td.style.border = '1px solid #e2e8f0';
        td.style.height = '1.5rem';
        td.style.textAlign = 'center';
        td.style.fontSize = '0.7rem';
        // Determine if this cell corresponds to a valid day
        const cellIndex = week * 7 + dow;
        if (cellIndex >= firstDow && currentDay <= daysInMonth) {
          const dayNum = currentDay;
          const hours = hoursPerDay[dayNum] || 0;
          // Colour intensity based on hours
          let alpha;
          if (maxHours > 0) {
            alpha = 0.1 + 0.8 * (hours / maxHours);
          } else {
            alpha = 0;
          }
          td.style.backgroundColor = `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
          // Display day number and hours (optional)
          const spanDay = document.createElement('div');
          spanDay.textContent = dayNum.toString();
          spanDay.style.fontWeight = '600';
          const spanHrs = document.createElement('div');
          spanHrs.textContent = hours > 0 ? hours.toFixed(1) + 'h' : '';
          spanHrs.style.fontSize = '0.6rem';
          td.appendChild(spanDay);
          td.appendChild(spanHrs);
          currentDay++;
        } else {
          td.textContent = '';
        }
        tr.appendChild(td);
      }
      heatmapTable.appendChild(tr);
      if (currentDay > daysInMonth) break;
    }
    heatmapContainer.appendChild(heatmapTable);
    // ---------- Build hours by project bar chart ----------
    // Compute total hours worked per project in the current month
    const monthByProject = data.projects
      .map((project) => {
        const sp = computeProjectStats(project);
        const worked = sp.monthlyHours || 0;
        const target = sp.monthlyTargetConst || 0;
        return {
          name: project.name,
          worked,
          target,
          deficit: target - worked
        };
      })
      .filter((row) => row.worked > 0 || row.target > 0);
    monthByProject.sort(
      (a, b) => b.deficit - a.deficit || a.name.localeCompare(b.name)
    );
    const barLabels = monthByProject.map((row) => row.name);
    const barHours = monthByProject.map((row) => row.worked);
    const barTargets = monthByProject.map((row) => row.target);
    if (barLabels.length > 0) {
      const barCard = document.createElement('div');
      barCard.style.marginBottom = '1rem';
      const barTitle = document.createElement('h3');
      barTitle.style.margin = '0 0 0.5rem 0';
      barTitle.style.fontSize = '1.1rem';
      barTitle.style.fontWeight = '600';
      barTitle.textContent = 'Hours by Project (This Month)';
      barCard.appendChild(barTitle);
      const barCanvas = document.createElement('canvas');
      barCanvas.height = isMobile ? Math.max(220, barLabels.length * 28) : 200;
      barCard.appendChild(wrapChartForMobile(barCanvas));
      heatmapContainer.appendChild(barCard);
      const ctxBar = barCanvas.getContext('2d');
      const displayBarLabels = isMobile
        ? barLabels.map((label) => truncateLabel(label, 18))
        : barLabels;
      new Chart(ctxBar, {
        type: 'bar',
        data: {
          labels: displayBarLabels,
          datasets: [
            {
              label: 'Hours Worked',
              data: barHours,
              backgroundColor: '#3b82f6',
              borderColor: '#3b82f6',
              borderWidth: 1
            },
            {
              label: 'Target Hours',
              data: barTargets,
              backgroundColor: '#94a3b8',
              borderColor: '#94a3b8',
              borderWidth: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: isMobile ? 'y' : 'x',
          layout: { padding: { left: 0, right: 0, top: 0, bottom: 0 } },
          scales: isMobile
            ? {
                x: {
                  beginAtZero: true,
                  title: { display: true, text: 'Hours' }
                },
                y: {
                  title: { display: false },
                  ticks: { autoSkip: false, font: { size: 10 } }
                }
              }
            : {
                x: { title: { display: false }, ticks: { autoSkip: false } },
                y: {
                  beginAtZero: true,
                  title: { display: true, text: 'Hours' }
                }
              },
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: isMobile
                ? { boxWidth: 10, font: { size: 10 } }
                : undefined
            }
          }
        }
      });
    }

    // ---------- Build daily hours line chart for the current month ----------
    // This chart shows how many hours were worked each day of the current month and compares to the
    // average daily target (monthlyTargetConst / daysInMonth) aggregated across all projects.
    // Compute daily hours across all projects
    const dailyLabels = [];
    const dailyHoursData = [];
    const dailyTargetData = [];
    const monthTargetTotal = monthByProject.reduce(
      (sum, row) => sum + (row.target || 0),
      0
    );
    const dayTarget = daysInMonth > 0 ? monthTargetTotal / daysInMonth : 0;
    for (let d = 1; d <= daysInMonth; d++) {
      dailyLabels.push(d.toString());
      dailyHoursData.push(hoursPerDay[d] || 0);
      dailyTargetData.push(dayTarget);
    }
    // Only render chart if there is at least one project
    if (dailyLabels.length > 0 && data.projects.length > 0) {
      const lineCard = document.createElement('div');
      lineCard.style.marginBottom = '1rem';
      const lineTitle = document.createElement('h3');
      lineTitle.style.margin = '0 0 0.5rem 0';
      lineTitle.style.fontSize = '1.1rem';
      lineTitle.style.fontWeight = '600';
      lineTitle.textContent = 'Daily Hours Trend (This Month)';
      lineCard.appendChild(lineTitle);
      const lineCanvas = document.createElement('canvas');
      lineCanvas.height = isMobile ? 260 : 200;
      lineCard.appendChild(wrapChartForMobile(lineCanvas));
      heatmapContainer.appendChild(lineCard);
      const ctxLine = lineCanvas.getContext('2d');
      new Chart(ctxLine, {
        type: 'line',
        data: {
          labels: dailyLabels,
          datasets: [
            {
              label: 'Hours Worked',
              data: dailyHoursData,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.3)',
              fill: false,
              tension: 0.1
            },
            {
              label: 'Daily Target (avg)',
              data: dailyTargetData,
              borderColor: '#999999',
              backgroundColor: 'rgba(153,153,153,0.3)',
              borderDash: [5, 5],
              fill: false,
              tension: 0.1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              title: { display: true, text: 'Day of Month' },
              ticks: isMobile
                ? {
                    autoSkip: true,
                    maxTicksLimit: 8,
                    maxRotation: 0,
                    minRotation: 0
                  }
                : { autoSkip: false }
            },
            y: { beginAtZero: true, title: { display: true, text: 'Hours' } }
          },
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: isMobile
                ? { boxWidth: 10, font: { size: 10 } }
                : undefined
            },
            tooltip: { mode: 'index', intersect: false }
          }
        }
      });
    }
    // ---------- Build per-project burndown charts ----------
    // Destroy existing charts to prevent memory leaks
    Object.values(burndownCharts).forEach((ch) => {
      if (ch && typeof ch.destroy === 'function') ch.destroy();
    });
    burndownCharts = {};
    data.projects.forEach((project) => {
      // Compute daily cumulative hours from project creation to now
      const createdAt = getProjectStartDate(project);
      const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
      if (!deadlineEndExclusive) return;
      const now = new Date();
      const todayEndExclusive = addLocalDays(
        new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        1
      );
      // Show progress up to today. Expected values still respect the full schedule to the deadline.
      const totalDaysShown = diffCalendarDays(createdAt, todayEndExclusive);
      if (totalDaysShown <= 0) return;
      // Build date labels and cumulative actual hours and expected hours arrays
      const labels = [];
      const actualData = [];
      const expectedData = [];
      const totalProjectDays = Math.max(
        1,
        diffCalendarDays(createdAt, deadlineEndExclusive)
      );
      // Create a map of cumulative hours keyed by date string
      const dailyHoursMap = {};
      data.entries.forEach((entry) => {
        if (entry.isRunning || !entry.duration) return;
        if (entry.projectId !== project.id) return;
        const start = new Date(entry.startTime);
        const dateKey = formatLocalDateString(start);
        dailyHoursMap[dateKey] =
          (dailyHoursMap[dateKey] || 0) + entry.duration / 3600;
      });
      let cumulative = 0;
      for (let i = 0; i < totalDaysShown; i++) {
        const date = addLocalDays(createdAt, i);
        const dateKey = formatLocalDateString(date);
        labels.push(dateKey);
        cumulative += dailyHoursMap[dateKey] || 0;
        actualData.push(cumulative);
        // Expected cumulative: linear burn-up to the full budget by the deadline.
        const ratio =
          totalProjectDays > 0 ? Math.min((i + 1) / totalProjectDays, 1) : 0;
        expectedData.push(project.budgetHours * ratio);
      }
      // Build canvas
      const projectCard = document.createElement('div');
      projectCard.style.marginBottom = '1rem';
      const h4 = document.createElement('h4');
      h4.style.margin = '0 0 0.5rem 0';
      h4.style.fontSize = '1rem';
      h4.style.fontWeight = '600';
      h4.textContent = project.name;
      projectCard.appendChild(h4);

      const usedHoursNow = actualData.length
        ? actualData[actualData.length - 1]
        : 0;
      const expectedHoursNow = expectedData.length
        ? expectedData[expectedData.length - 1]
        : 0;
      const scheduleDelta = expectedHoursNow - usedHoursNow;
      const meta = document.createElement('div');
      meta.style.margin = '0 0 0.5rem 0';
      meta.style.fontSize = '0.85rem';
      meta.style.color = '#475569';
      meta.textContent = `Used ${usedHoursNow.toFixed(1)}h / ${project.budgetHours.toFixed(1)}h • Expected by now ${expectedHoursNow.toFixed(1)}h • ${scheduleDelta >= 0 ? 'Behind' : 'Ahead'} ${Math.abs(scheduleDelta).toFixed(1)}h`;
      projectCard.appendChild(meta);

      const canvas = document.createElement('canvas');
      canvas.height = isMobile ? 240 : 150;
      projectCard.appendChild(wrapChartForMobile(canvas));
      burndownContainer.appendChild(projectCard);
      // Create Chart.js line chart
      const ctx = canvas.getContext('2d');
      burndownCharts[project.id] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Cumulative Hours',
              data: actualData,
              borderColor: project.color || '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.3)',
              fill: false,
              tension: 0.1
            },
            {
              label: 'Expected Hours',
              data: expectedData,
              borderColor: '#999999',
              backgroundColor: 'rgba(153,153,153,0.3)',
              fill: false,
              borderDash: [5, 5],
              tension: 0.1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              title: { display: true, text: 'Date' },
              ticks: isMobile
                ? {
                    autoSkip: true,
                    maxTicksLimit: 6,
                    maxRotation: 0,
                    minRotation: 0
                  }
                : { maxRotation: 90, minRotation: 45 }
            },
            y: {
              title: { display: true, text: 'Hours' },
              beginAtZero: true
            }
          },
          plugins: {
            legend: { display: true },
            tooltip: { enabled: true }
          }
        }
      });
    });

    // ---------- Build Hours by Project bar chart ----------
    const hoursCanvas = document.getElementById('hoursByProjectChart');
    if (hoursCanvas) {
      if (isMobile) {
        const parent = hoursCanvas.parentElement;
        const alreadyWrapped =
          parent &&
          parent.classList &&
          parent.classList.contains('chart-scroll-inner');
        if (parent && !alreadyWrapped) {
          const scroll = document.createElement('div');
          scroll.className = 'chart-scroll';
          scroll.style.overflowX = 'auto';
          scroll.style.webkitOverflowScrolling = 'touch';
          const inner = document.createElement('div');
          inner.className = 'chart-scroll-inner';
          inner.style.minWidth = '680px';
          // Replace the canvas in-place with the scroll wrapper, then move the canvas inside.
          parent.replaceChild(scroll, hoursCanvas);
          inner.appendChild(hoursCanvas);
          scroll.appendChild(inner);
        }
      }
      // Destroy existing chart if present
      if (window.hoursByProjectChart) {
        try {
          window.hoursByProjectChart.destroy();
        } catch (err) {}
      }
      const labels = monthByProject.map((row) => row.name);
      const workedData = monthByProject.map((row) => row.worked);
      const remainingData = monthByProject.map((row) =>
        Math.max(0, (row.target || 0) - (row.worked || 0))
      );
      hoursCanvas.height = isMobile ? Math.max(220, labels.length * 28) : 200;
      const displayLabels = isMobile
        ? labels.map((label) => truncateLabel(label, 18))
        : labels;
      const ctxHours = hoursCanvas.getContext('2d');
      window.hoursByProjectChart = new Chart(ctxHours, {
        type: 'bar',
        data: {
          labels: displayLabels,
          datasets: [
            {
              label: 'Worked',
              data: workedData,
              backgroundColor: 'rgba(59,130,246,0.6)',
              borderColor: '#3b82f6',
              borderWidth: 1,
              stack: 'hours'
            },
            {
              label: 'Remaining (to target)',
              data: remainingData,
              backgroundColor: 'rgba(203,213,224,0.6)',
              borderColor: '#94a3b8',
              borderWidth: 1,
              stack: 'hours'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: isMobile ? 'y' : 'x',
          layout: { padding: { left: 0, right: 0, top: 0, bottom: 0 } },
          scales: isMobile
            ? {
                x: {
                  title: { display: true, text: 'Hours' },
                  beginAtZero: true,
                  stacked: true
                },
                y: {
                  title: { display: true, text: 'Project' },
                  ticks: { autoSkip: false, font: { size: 10 } },
                  stacked: true
                }
              }
            : {
                x: { title: { display: true, text: 'Project' }, stacked: true },
                y: {
                  title: { display: true, text: 'Hours' },
                  beginAtZero: true,
                  stacked: true
                }
              },
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: isMobile
                ? { boxWidth: 10, font: { size: 10 } }
                : undefined
            },
            tooltip: { enabled: true }
          }
        }
      });
    }
  }

  // Download the current data to a JSON file. Uses the same filename
  // each time so the browser can overwrite older backups.
  function downloadData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'timekeeper-offline-data.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function makeBackupSnapshotName(timestamp = new Date()) {
    return (
      'timekeeper-data-' +
      timestamp.toISOString().replace(/[:.]/g, '-') +
      '.json'
    );
  }

  async function writeTextFile(directoryHandle, fileName, text) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, {
      create: true
    });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  async function readTextFile(directoryHandle, fileName) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, {
      create: false
    });
    const file = await fileHandle.getFile();
    return file.text();
  }

  async function pruneBackupSnapshots(snapshotDirHandle) {
    if (!snapshotDirHandle || !snapshotDirHandle.entries) return;
    const files = [];
    for await (const [name, handle] of snapshotDirHandle.entries()) {
      if (
        handle.kind === 'file' &&
        /^timekeeper-data-\d{4}-\d{2}-\d{2}T.*\.json$/.test(name)
      ) {
        files.push(name);
      }
    }
    files.sort().reverse();
    const staleFiles = files.slice(BACKUP_SNAPSHOT_KEEP);
    await Promise.all(
      staleFiles.map((name) =>
        snapshotDirHandle.removeEntry(name).catch(() => {})
      )
    );
  }

  function buildBackupManifest(snapshotFileName, timestampIso) {
    return {
      app: 'TimeKeeper',
      schemaVersion: 2,
      latestFile: BACKUP_LATEST_FILENAME,
      snapshotDirectory: BACKUP_SNAPSHOT_DIR,
      latestSnapshotFile: snapshotFileName,
      writtenAt: timestampIso,
      dataUpdatedAt: data.updatedAt || null,
      backupRevision: Number(data.backupRevision) || 0,
      projects: Array.isArray(data.projects) ? data.projects.length : 0,
      entries: Array.isArray(data.entries) ? data.entries.length : 0
    };
  }

  function scheduleBackupSoon() {
    if (!autoSyncEnabled || !backupDirHandle) return;
    if (backupFlushTimer) clearTimeout(backupFlushTimer);
    backupFlushTimer = setTimeout(() => {
      backupFlushTimer = null;
      if (autoSyncEnabled && needsBackup) {
        saveBackupToDir().catch((err) => {
          console.error('Auto backup failed:', err);
        });
      }
    }, BACKUP_DEBOUNCE_MS);
  }

  async function flushBackupNow() {
    if (!autoSyncEnabled || !backupDirHandle || !needsBackup) return;
    if (backupFlushTimer) {
      clearTimeout(backupFlushTimer);
      backupFlushTimer = null;
    }
    await saveBackupToDir();
  }

  // Save the current data to the user-selected backup directory. Each backup writes:
  // - timekeeper-data.json for the latest state
  // - timekeeper-manifest.json for quick inspection
  // - a timestamped snapshot under timekeeper-snapshots/
  async function saveBackupToDir() {
    if (backupInFlight) return backupInFlight;
    backupInFlight = (async () => {
      try {
        if (!backupDirHandle) {
          backupPermissionState = 'missing';
          disableAutoSyncWithWarning(
            'Auto sync paused: select a backup folder to resume syncing.'
          );
          return false;
        }
        const permissionState = await getBackupPermissionState(backupDirHandle);
        backupPermissionState = permissionState;
        if (permissionState !== 'granted') {
          const message =
            permissionState === 'prompt'
              ? 'Auto sync paused: confirm access to your backup folder to resume syncing.'
              : 'Auto sync disabled: permission to the backup folder was revoked.';
          disableAutoSyncWithWarning(message);
          return false;
        }
        const backupTime = new Date();
        const backupTimeIso = backupTime.toISOString();
        const snapshotFileName = makeBackupSnapshotName(backupTime);
        data.lastBackupAt = backupTimeIso;
        data.lastBackupFile = BACKUP_LATEST_FILENAME;
        data.lastBackupSnapshotAt = backupTimeIso;
        const snapshotDirHandle = await backupDirHandle.getDirectoryHandle(
          BACKUP_SNAPSHOT_DIR,
          { create: true }
        );
        const backupJson = JSON.stringify(data, null, 2);
        await writeTextFile(
          backupDirHandle,
          BACKUP_LATEST_FILENAME,
          backupJson
        );
        await writeTextFile(snapshotDirHandle, snapshotFileName, backupJson);
        await writeTextFile(
          backupDirHandle,
          BACKUP_MANIFEST_FILENAME,
          JSON.stringify(
            buildBackupManifest(snapshotFileName, backupTimeIso),
            null,
            2
          )
        );
        await pruneBackupSnapshots(snapshotDirHandle);
        persistDataToLocalStorage();
        needsBackup = false;
        backupWarningMessage = '';
        updateAutoSyncStatus();
        return true;
      } catch (err) {
        console.error('Saving backup failed:', err);
        backupWarningMessage =
          'Auto backup failed. Check the backup folder and try again.';
        updateAutoSyncStatus();
        return false;
      } finally {
        backupInFlight = null;
      }
    })();
    return backupInFlight;
  }

  // Prompt the user to choose a backup directory using the File System Access API. When
  // the directory is selected, set it as the backupDirHandle and enable auto sync.
  async function chooseBackupDir(options = {}) {
    const { activateSync = false } = options;
    if (!window.showDirectoryPicker) {
      backupWarningMessage =
        'Auto sync unavailable: your browser does not support choosing folders.';
      updateAutoSyncStatus();
      return false;
    }
    try {
      const dirHandle = await window.showDirectoryPicker();
      const permissionGranted =
        await ensureBackupPermissionWithPrompt(dirHandle);
      if (!permissionGranted) {
        backupWarningMessage =
          'Permission to access the selected backup folder was not granted. Auto sync unchanged.';
        updateAutoSyncStatus();
        return false;
      }
      backupDirHandle = dirHandle;
      backupPermissionState = 'granted';
      await saveBackupDirHandle(dirHandle);
      data.backupDirName = dirHandle.name || null;
      saveData();
      if (activateSync) {
        autoSyncEnabled = true;
        localStorage.setItem('autoSyncEnabledPro', 'true');
        const toggle = document.getElementById('autoSyncToggle');
        if (toggle) toggle.checked = true;
      }
      backupWarningMessage = '';
      updateAutoSyncStatus();
      if (autoSyncEnabled || activateSync) {
        await saveBackupToDir();
      }
      return true;
    } catch (err) {
      console.error('Backup folder not selected:', err);
      backupWarningMessage = 'Backup folder not selected. Auto sync unchanged.';
      updateAutoSyncStatus();
      return false;
    }
  }

  // Periodically export data if there have been changes. saveData() also
  // schedules a short debounce, and pagehide/visibilitychange flush before exit.
  setInterval(() => {
    // Only perform automatic backups when auto sync is enabled. When a backup directory
    // is selected, data will be written to the file; otherwise, nothing happens.
    if (autoSyncEnabled && needsBackup) {
      saveBackupToDir().catch((err) => {
        console.error('Auto backup failed:', err);
      });
    }
  }, AUTO_BACKUP_INTERVAL_MS);
  window.addEventListener('pagehide', () => {
    flushBackupNow().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushBackupNow().catch(() => {});
    }
  });

  // Navigation
  const navList = document.getElementById('navList');
  navList.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      navList
        .querySelectorAll('li')
        .forEach((item) => item.classList.remove('active'));
      li.classList.add('active');
      const sectionId = li.getAttribute('data-section');
      document.querySelectorAll('.section').forEach((sec) => {
        sec.style.display = 'none';
      });
      document.getElementById(sectionId).style.display = 'block';
      // update content if needed
      if (sectionId === 'dashboard') {
        updateDashboard();
      } else if (sectionId === 'projects') {
        updateProjectsPage();
      } else if (sectionId === 'entries') {
        updateEntriesTable();
      } else if (sectionId === 'timer') {
        updateTimerSection();
      } else if (sectionId === 'todo') {
        updateTodoSection();
      } else if (sectionId === 'grocery') {
        updateGrocerySection();
      } else if (sectionId === 'analytics') {
        updateAnalyticsSection();
      }
    });
  });

  // Shared runtime helpers imported from ./shared/runtime-helpers.mjs.
  let cachedStravaActivities = [];
  let cachedStravaScoreScale = STRAVA_SCORE_DEFAULT_SCALE;

  function getStravaExertionOverrides() {
    try {
      const raw = localStorage.getItem('stravaExertionOverrides');
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object') return {};
      const normalized = {};
      Object.keys(parsed).forEach((key) => {
        const record = normalizeStravaOverrideRecord(parsed[key]);
        if (record) {
          normalized[key] = record;
        }
      });
      return normalized;
    } catch (error) {
      return {};
    }
  }

  function normalizeStravaOverrideRecord(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = {};
      const exertion = parseExertionValue(value.exertion);
      if (exertion !== null) {
        record.exertion = exertion;
      }
      if (value.faulty === true) {
        record.faulty = true;
      }
      return Object.keys(record).length ? record : null;
    }
    const exertion = parseExertionValue(value);
    return exertion === null ? null : { exertion };
  }

  function saveStravaActivityOverride(activityId, updates = {}) {
    const overrides = getStravaExertionOverrides();
    const key = String(activityId);
    const next = Object.assign({}, overrides[key] || {});
    if (Object.prototype.hasOwnProperty.call(updates, 'exertion')) {
      const exertion = updates.exertion;
      if (exertion === null || exertion === undefined) {
        delete next.exertion;
      } else {
        const parsed = parseExertionValue(exertion);
        if (parsed === null) {
          delete next.exertion;
        } else {
          next.exertion = parsed;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'faulty')) {
      if (updates.faulty) {
        next.faulty = true;
      } else {
        delete next.faulty;
      }
    }
    if (!Object.keys(next).length) {
      delete overrides[key];
    } else {
      overrides[key] = next;
    }
    localStorage.setItem('stravaExertionOverrides', JSON.stringify(overrides));
  }

  function saveStravaExertionOverride(activityId, value) {
    saveStravaActivityOverride(activityId, { exertion: value });
  }

  function setStravaActivityFaulty(activityId, faulty) {
    saveStravaActivityOverride(activityId, { faulty });
  }

  function applyStravaExertionOverrides(activities) {
    const overrides = getStravaExertionOverrides();
    return activities.map((activity) => {
      const override = overrides[String(activity.id)];
      if (override === undefined) {
        return activity;
      }
      const result = { ...activity };
      if (Object.prototype.hasOwnProperty.call(override, 'exertion')) {
        result.local_exertion = override.exertion;
      }
      if (override.faulty === true) {
        result.local_faulty = true;
      }
      return result;
    });
  }

  function refreshStravaScoreScale(activities) {
    const result = computeStravaScoreScale(activities);
    cachedStravaScoreScale = result.scale;
    return result;
  }

  function renderStravaActivities(activities) {
    const list = document.getElementById('stravaFeedList');
    if (!list) return;
    list.innerHTML = '';
    activities.forEach((activity) => {
      const item = document.createElement('li');
      const header = document.createElement('div');
      const title = document.createElement(activity.url ? 'a' : 'span');
      title.className = 'strava-title';
      title.textContent = activity.name || 'Untitled activity';
      if (activity.url) {
        title.href = activity.url;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
      }
      header.appendChild(title);
      const dateLine = document.createElement('div');
      dateLine.className = 'strava-date';
      const startDate = activity.start_date
        ? new Date(activity.start_date)
        : null;
      if (startDate && !isNaN(startDate)) {
        dateLine.textContent = startDate.toLocaleString();
      }
      item.appendChild(header);
      if (dateLine.textContent) {
        item.appendChild(dateLine);
      }
      const meta = document.createElement('div');
      meta.className = 'strava-meta';
      const metaParts = [];
      if (
        activity.elapsed_time_min !== null &&
        activity.elapsed_time_min !== undefined
      ) {
        const elapsed = Number(activity.elapsed_time_min);
        if (Number.isFinite(elapsed)) {
          metaParts.push(`Elapsed ${Math.round(elapsed * 10) / 10} min`);
        }
      }
      if (activity.avg_hr !== null && activity.avg_hr !== undefined) {
        const avgHr = Number(activity.avg_hr);
        if (Number.isFinite(avgHr)) {
          metaParts.push(`Avg HR ${Math.round(avgHr)}`);
        }
      }
      if (activity.max_hr !== null && activity.max_hr !== undefined) {
        const maxHr = Number(activity.max_hr);
        if (Number.isFinite(maxHr)) {
          metaParts.push(`Max HR ${Math.round(maxHr)}`);
        }
      }
      if (
        activity.reported_exertion !== null &&
        activity.reported_exertion !== undefined
      ) {
        metaParts.push(
          `Reported Score ${formatExertion(activity.reported_exertion)}`
        );
      }
      const estimatedExertion = estimateStravaExertion(
        activity,
        cachedStravaScoreScale
      );
      const displayEstimate = estimatedExertion ?? activity.estimated_exertion;
      if (displayEstimate !== null && displayEstimate !== undefined) {
        metaParts.push(`Estimated Score ${formatExertion(displayEstimate)}`);
      }
      const actualExertion =
        activity.local_exertion !== undefined
          ? activity.local_exertion
          : activity.exertion;
      if (actualExertion !== null && actualExertion !== undefined) {
        metaParts.push(`Actual Score ${formatExertion(actualExertion)}`);
      }
      if (isStravaActivityFaulty(activity)) {
        metaParts.push('Faulty HR excluded from fit');
      }
      if (metaParts.length > 0) {
        metaParts.forEach((part) => {
          const pill = document.createElement('span');
          pill.className = 'strava-pill';
          pill.textContent = part;
          meta.appendChild(pill);
        });
        item.appendChild(meta);
      }
      const exertionRow = document.createElement('div');
      exertionRow.className = 'strava-exertion';
      const exertionLabel = document.createElement('span');
      exertionLabel.className = 'strava-exertion-label';
      exertionLabel.textContent = 'Workout score';
      const exertionValue = document.createElement('input');
      exertionValue.type = 'number';
      exertionValue.min = '0';
      exertionValue.step = '0.1';
      exertionValue.inputMode = 'decimal';
      exertionValue.className = 'strava-exertion-value';
      const exertionRange = document.createElement('input');
      exertionRange.type = 'range';
      exertionRange.min = '0';
      exertionRange.step = '0.1';
      exertionRange.className = 'strava-exertion-range';
      const ensureRangeUpperBound = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return;
        const currentMax = Number.parseFloat(exertionRange.max);
        const baseline =
          Number.isFinite(currentMax) && currentMax > 0 ? currentMax : 10;
        const nextMax = Math.max(baseline, Math.ceil(numeric + 1));
        exertionRange.max = String(nextMax);
      };
      const fallbackExertion =
        actualExertion ?? activity.reported_exertion ?? displayEstimate;
      const startingValue = Number.isFinite(Number(fallbackExertion))
        ? Number(fallbackExertion)
        : 0;
      ensureRangeUpperBound(startingValue);
      exertionValue.value = formatExertion(startingValue);
      exertionRange.value = String(startingValue);
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'btn secondary';
      saveButton.textContent = 'Save';
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'btn secondary';
      clearButton.textContent = 'Clear';
      const faultyButton = document.createElement('button');
      faultyButton.type = 'button';
      faultyButton.textContent = 'Faulty';
      const syncFaultyButton = (faulty) => {
        faultyButton.className = faulty ? 'btn danger' : 'btn secondary';
        faultyButton.setAttribute('aria-pressed', faulty ? 'true' : 'false');
        faultyButton.title = faulty
          ? 'This workout is excluded from the HR-to-score fit.'
          : 'Exclude this workout from the HR-to-score fit.';
      };
      syncFaultyButton(isStravaActivityFaulty(activity));

      const syncFromValue = () => {
        const parsed = parseExertionValue(exertionValue.value);
        if (parsed === null) return null;
        exertionValue.value = formatExertion(parsed);
        ensureRangeUpperBound(parsed);
        exertionRange.value = String(parsed);
        return parsed;
      };

      const syncFromRange = () => {
        const parsed = parseExertionValue(exertionRange.value);
        if (parsed === null) return null;
        exertionValue.value = formatExertion(parsed);
        return parsed;
      };

      exertionValue.addEventListener('input', () => {
        syncFromValue();
      });
      exertionRange.addEventListener('input', () => {
        syncFromRange();
      });
      saveButton.addEventListener('click', () => {
        const parsed = syncFromValue();
        if (parsed === null) {
          alert('Enter a value of 0 or higher.');
          return;
        }
        saveStravaExertionOverride(activity.id, parsed);
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
      });
      clearButton.addEventListener('click', () => {
        saveStravaExertionOverride(activity.id, null);
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
      });
      faultyButton.addEventListener('click', () => {
        setStravaActivityFaulty(activity.id, !isStravaActivityFaulty(activity));
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
      });

      exertionRow.appendChild(exertionLabel);
      exertionRow.appendChild(exertionRange);
      exertionRow.appendChild(exertionValue);
      exertionRow.appendChild(saveButton);
      exertionRow.appendChild(clearButton);
      exertionRow.appendChild(faultyButton);
      item.appendChild(exertionRow);
      list.appendChild(item);
    });
  }

  async function loadStravaFeed() {
    const status = document.getElementById('stravaFeedStatus');
    const list = document.getElementById('stravaFeedList');
    if (!status || !list) return;
    status.textContent = 'Loading latest activities...';
    list.innerHTML = '';
    try {
      const response = await fetch('assets/strava.json', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load Strava feed.');
      }
      const data = await response.json();
      if (data.error) {
        status.textContent = data.error;
        return;
      }
      const activities = Array.isArray(data.activities) ? data.activities : [];
      if (activities.length === 0) {
        status.textContent = 'No activities available yet.';
        return;
      }
      status.textContent = data.updated_utc
        ? `Updated ${formatRelativeTime(data.updated_utc)}`
        : 'Latest activities';
      cachedStravaActivities = activities;
      window.stravaActivitiesCache = activities;
      const updatedActivities = applyStravaExertionOverrides(activities);
      refreshStravaScoreScale(updatedActivities);
      renderStravaActivities(updatedActivities);
      updateFitnessCards();
    } catch (error) {
      status.textContent =
        'Strava feed not available yet. Run the GitHub Action to publish activities.';
    }
  }

  // Compute statistics per project
  function computeProjectStats(project) {
    const now = new Date();
    const entries = data.entries.filter(
      (e) => e.projectId === project.id && !e.isRunning
    );
    const totalHours = sumEntryHours(entries);
    const remainingHours = project.budgetHours - totalHours;
    const created = getProjectStartDate(project);
    const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
    const todayEndExclusive = addLocalDays(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      1
    );
    const todayStart = startOfLocalDay(now);
    const projectNotStarted = now < created;
    const totalProjectDays = deadlineEndExclusive
      ? Math.max(1, diffCalendarDays(created, deadlineEndExclusive))
      : 1;
    let daysPassed = projectNotStarted
      ? 0
      : diffCalendarDays(created, todayEndExclusive);
    if (!Number.isFinite(daysPassed) || daysPassed < 0) daysPassed = 0;
    if (daysPassed > totalProjectDays) daysPassed = totalProjectDays;
    const daysLeft = Math.max(0, totalProjectDays - daysPassed);
    const avgDailyBurn = totalHours / Math.max(1, daysPassed);
    const daysToExhaust =
      avgDailyBurn > 0 ? remainingHours / avgDailyBurn : Infinity;
    // Determine a more descriptive status for the project based on budget consumption and schedule
    // Calculate expected used hours based on how far through the project we are
    const expectedUsed =
      totalProjectDays > 0
        ? project.budgetHours * (daysPassed / totalProjectDays)
        : totalHours;
    const totalExpectedToDate = projectNotStarted ? 0 : expectedUsed;
    const totalScheduleDeficit = totalExpectedToDate - totalHours;
    let status = 'on-track';
    let statusColor = 'green';
    let reason = '';
    // If total hours already exceed expected usage at this point in the schedule, mark as over budget
    if (totalHours > expectedUsed) {
      status = 'over-budget';
      statusColor = 'red';
      reason = 'Projected to exceed budget before deadline.';
      // If days to exhaust at current burn rate is less than days left, the project will finish late (behind schedule)
    } else if (daysToExhaust < daysLeft) {
      status = 'behind-schedule';
      statusColor = 'red';
      reason = 'Not enough days left at current pace.';
      // If days to exhaust and days left are very close (within three days), label as tight schedule
    } else if (Math.abs(daysToExhaust - daysLeft) <= 3) {
      status = 'tight';
      statusColor = 'amber';
      reason = 'On track but very little margin.';
    } else {
      status = 'on-track';
      statusColor = 'green';
      reason = 'On track.';
    }
    // Weekly and monthly expected hours
    let weeklyExpected = 0;
    let monthlyExpected = 0;
    // Calculate expected (target) hours to date for this week and this month.
    // We base the daily budget on the total calendar days between project creation and deadline.
    // This yields a more realistic expected-to-date value than strictly using working days, which can
    // produce very small denominators when projects span long periods.
    const totalDays = totalProjectDays || 1;
    const dailyBudget = project.budgetHours / totalDays;
    // Determine the start of the current week (Monday) and the start of the current month
    const startOfWeek = new Date(now);
    const dow = startOfWeek.getDay();
    const diffToMonday = (dow + 6) % 7;
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    // Compute calendar day counts relative to project creation date
    const daysTillNow = Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
    const daysTillStartOfWeekCal = Math.max(
      0,
      (startOfWeek - created) / (1000 * 60 * 60 * 24)
    );
    const daysTillStartOfMonthCal = Math.max(
      0,
      (startOfMonth - created) / (1000 * 60 * 60 * 24)
    );
    // Include fractional day for weekly expected by using floating point difference (time-of-day) rather than rounded days.
    weeklyExpected = Math.max(
      0,
      dailyBudget * (daysTillNow - daysTillStartOfWeekCal)
    );
    monthlyExpected = Math.max(
      0,
      dailyBudget * (daysTillNow - daysTillStartOfMonthCal)
    );
    if (projectNotStarted) {
      weeklyExpected = 0;
      monthlyExpected = 0;
    }
    // Clamp expected values so they do not exceed the project's total budget hours
    if (weeklyExpected > project.budgetHours)
      weeklyExpected = project.budgetHours;
    if (monthlyExpected > project.budgetHours)
      monthlyExpected = project.budgetHours;
    // Weekly and last week hours
    // Determine the start of the current week (Monday 00:00). We calculate how many
    // days have passed since Monday and subtract that from today's date. This ensures
    // weekly statistics reset at the beginning of each week.
    const dayOfWeek = now.getDay();
    const diffToMondayWeek = (dayOfWeek + 6) % 7;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMondayWeek
    );
    weekStart.setHours(0, 0, 0, 0);
    const startNextWeek = addLocalDays(weekStart, 7);
    // Last week spans the 7 days prior to weekStart
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);
    const weeklyHours = sumEntryHours(entries, weekStart);
    const lastWeekHours = sumEntryHours(entries, lastWeekStart, lastWeekEnd);
    // Monthly hours and last month hours
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const startNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = monthStart;
    const monthlyHours = sumEntryHours(entries, monthStart);
    const lastMonthHours = sumEntryHours(entries, lastMonthStart, lastMonthEnd);
    const rollingBounds = getRollingWindowBounds(now);
    const rolling30Hours = sumEntryHours(
      entries,
      rollingBounds.start,
      rollingBounds.endExclusive
    );
    // Revenue
    const revenue = totalHours * project.hourlyRate;
    const weeklyRevenue = weeklyHours * project.hourlyRate;
    const lastWeekRevenue = lastWeekHours * project.hourlyRate;
    const monthlyRevenue = monthlyHours * project.hourlyRate;
    const lastMonthRevenue = lastMonthHours * project.hourlyRate;
    // Planning targets are snapshot-based so they stay stable inside the
    // current week/month instead of shifting whenever the calendar flips.
    let weeklyTargetConst = getProjectPlannedHoursForPeriod(
      project,
      entries,
      weekStart,
      startNextWeek
    );
    let monthlyTargetConst = getProjectPlannedHoursForPeriod(
      project,
      entries,
      monthStart,
      startNextMonth
    );
    const todayPlanningSnapshot = getProjectPlanningSnapshot(
      project,
      entries,
      todayStart
    );
    const rollingTargetStart = maxDate(rollingBounds.start, created);
    const rollingWorkdays = rollingTargetStart
      ? countWorkdays(rollingTargetStart, rollingBounds.endExclusive)
      : 0;
    const rolling30TargetConst =
      todayPlanningSnapshot.dailyRate * rollingWorkdays;
    const rolling30SurplusHours =
      rolling30TargetConst > 0
        ? Math.max(0, rolling30Hours - rolling30TargetConst)
        : 0;
    const weeklyTargetBeforeRollingCredit = weeklyTargetConst;
    weeklyTargetConst = Math.max(0, weeklyTargetConst - rolling30SurplusHours);
    if (projectNotStarted) {
      monthlyTargetConst = 0;
      weeklyTargetConst = 0;
      return {
        totalHours,
        totalExpectedToDate,
        totalScheduleDeficit,
        remainingHours,
        usedPct:
          project.budgetHours > 0
            ? (totalHours / project.budgetHours) * 100
            : 0,
        daysLeft,
        daysPassed,
        status,
        statusColor,
        reason,
        weeklyExpected,
        monthlyExpected,
        weeklyHours,
        lastWeekHours,
        monthlyHours,
        lastMonthHours,
        rolling30Hours: 0,
        rolling30TargetConst: 0,
        revenue,
        weeklyRevenue,
        lastWeekRevenue,
        monthlyRevenue,
        lastMonthRevenue,
        weeklyTargetConst: 0,
        weeklyTargetBeforeRollingCredit: 0,
        rolling30SurplusHours: 0,
        monthlyTargetConst: 0
      };
    }
    return {
      totalHours,
      totalExpectedToDate,
      totalScheduleDeficit,
      remainingHours,
      usedPct:
        project.budgetHours > 0 ? (totalHours / project.budgetHours) * 100 : 0,
      daysLeft,
      daysPassed,
      status,
      statusColor,
      reason,
      weeklyExpected,
      monthlyExpected,
      weeklyHours,
      lastWeekHours,
      monthlyHours,
      lastMonthHours,
      rolling30Hours,
      rolling30TargetConst,
      revenue,
      weeklyRevenue,
      lastWeekRevenue,
      monthlyRevenue,
      lastMonthRevenue,
      weeklyTargetConst,
      weeklyTargetBeforeRollingCredit,
      rolling30SurplusHours,
      monthlyTargetConst
    };
  }

  function getCurrentWeekPlanningContext(referenceDate = new Date()) {
    const now = referenceDate instanceof Date ? referenceDate : new Date();
    const todayStart = startOfLocalDay(now);
    const todayEnd = addLocalDays(todayStart, 1);
    const dayOfWeek = now.getDay();
    const diffToMonday = (dayOfWeek + 6) % 7;
    const startWeek = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMonday
    );
    startWeek.setHours(0, 0, 0, 0);
    const startNextWeek = addLocalDays(startWeek, 7);
    let weeklyTimeProgress;
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      weeklyTimeProgress = 100;
    } else {
      const diffMs = now - startWeek;
      const totalMs = 5 * 24 * 60 * 60 * 1000;
      weeklyTimeProgress = Math.min((diffMs / totalMs) * 100, 100);
    }
    return {
      now,
      todayStart,
      todayEnd,
      startWeek,
      startNextWeek,
      weeklyTimeProgress,
      workDaysLeftInWeek: countWorkdays(todayStart, startNextWeek)
    };
  }

  function getProjectCompletedHoursForPeriod(projectId, start, end) {
    const projectEntries = data.entries.filter(
      (entry) => entry.projectId === projectId && !entry.isRunning
    );
    return sumEntryHours(projectEntries, start, end);
  }

  function getProjectDailyPlan(project, stats, context) {
    const weekContext = context || getCurrentWeekPlanningContext();
    const projectStats = stats || computeProjectStats(project);
    const todayHours = getProjectCompletedHoursForPeriod(
      project.id,
      weekContext.todayStart,
      weekContext.todayEnd
    );
    const weekHoursBeforeToday = getProjectCompletedHoursForPeriod(
      project.id,
      weekContext.startWeek,
      weekContext.todayStart
    );
    const weeklyTarget = Math.max(
      0,
      Number(projectStats.weeklyTargetConst) || 0
    );
    const remainingAtStartOfDay = Math.max(
      0,
      weeklyTarget - weekHoursBeforeToday
    );
    const dailyTarget =
      weekContext.workDaysLeftInWeek > 0
        ? remainingAtStartOfDay / weekContext.workDaysLeftInWeek
        : 0;
    return {
      todayHours,
      dailyTarget,
      remainingToday: Math.max(0, dailyTarget - todayHours),
      weeklyRemaining: Math.max(
        0,
        weeklyTarget - weekHoursBeforeToday - todayHours
      )
    };
  }

  function getRecommendedProjectEntry(perProjectStats, dailyPlanByProjectId) {
    let recommendedProjectEntry = null;
    let maxDailyRemaining = 0;
    let bestTieBreaker = -Infinity;
    perProjectStats.forEach((item) => {
      const dailyPlan =
        dailyPlanByProjectId &&
        dailyPlanByProjectId.get(String(item.project.id));
      const remainingToday = dailyPlan
        ? dailyPlan.remainingToday
        : getProjectDailyPlan(item.project, item.stats).remainingToday;
      const tieBreaker = Number.isFinite(item.stats.totalScheduleDeficit)
        ? item.stats.totalScheduleDeficit
        : 0;
      if (
        remainingToday > maxDailyRemaining + 0.01 ||
        (Math.abs(remainingToday - maxDailyRemaining) <= 0.01 &&
          remainingToday > 0 &&
          tieBreaker > bestTieBreaker)
      ) {
        maxDailyRemaining = remainingToday;
        bestTieBreaker = tieBreaker;
        recommendedProjectEntry = item;
      }
    });
    return recommendedProjectEntry;
  }

  function formatRecommendationHours(hours) {
    return Math.max(0, Number(hours) || 0).toFixed(1);
  }

  // Compute global statistics
  function computeGlobalStats() {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const yesterdayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1
    );
    // Start of this week (Monday 00:00) – the weekly period resets on Mondays. We calculate
    // the date of Monday in the current week and use it to accumulate weekly hours
    // and revenue. If today is Monday, weekStart will be today; if today is Tuesday,
    // weekStart will be yesterday, and so on.
    const day = now.getDay();
    const diffToMonday = (day + 6) % 7;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMonday
    );
    weekStart.setHours(0, 0, 0, 0);
    // Define last week's date range for revenue calculation (the week before the current week).
    // We subtract 7 days from weekStart to get the start of the previous week and use weekStart
    // itself as the end of last week.
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = monthStart;
    let todaySeconds = 0;
    let yesterdaySeconds = 0;
    let weekSeconds = 0;
    // Track weekly seconds accrued before today so the daily target can be
    // calculated based on the week's remaining hours at the start of the day.
    let weekSecondsStartOfDay = 0;
    let monthSeconds = 0;
    let rollingSeconds = 0;
    let totalRevenue = 0;
    let monthlyRevenue = 0;
    let lastMonthRevenue = 0;
    let rollingRevenue = 0;
    // Revenue totals for today and this week (across all projects)
    let todayRevenue = 0;
    let yesterdayRevenue = 0;
    let weekRevenue = 0;
    let lastWeekRevenue = 0;
    // Dynamic weekly and monthly targets for all projects. We recalculate each project's
    // weekly and monthly targets based on remaining hours and remaining time until
    // deadline. The sum of these per‑project targets represents the number of hours
    // you should aim to work this week and this month across all projects.
    let weeklyTarget = 0;
    let monthTarget = 0;
    let rollingTarget = 0;
    // We'll compute dailyTarget based on remaining monthly hours later
    let dailyTarget = 0;
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project, now)
    );
    activeProjects.forEach((project) => {
      const sp = computeProjectStats(project);
      weeklyTarget += sp.weeklyTargetConst || 0;
      monthTarget += sp.monthlyTargetConst || 0;
      rollingTarget += sp.rolling30TargetConst || 0;
    });
    const rollingBounds = getRollingWindowBounds(now);
    // Daily target will be computed later once monthHours is known.
    data.entries.forEach((entry) => {
      if (entry.isRunning || !entry.duration) return;
      const start = new Date(entry.startTime);
      const project = getEntryProject(entry);
      const hours = entry.duration / 3600;
      if (!project) return;
      if (start >= todayStart) {
        todaySeconds += entry.duration;
        todayRevenue += hours * project.hourlyRate;
      }
      if (start >= yesterdayStart && start < todayStart) {
        yesterdaySeconds += entry.duration;
        yesterdayRevenue += hours * project.hourlyRate;
      }
      if (start >= weekStart) {
        weekSeconds += entry.duration;
        weekRevenue += hours * project.hourlyRate;
        // Count weekly seconds before today separately for computing the daily target.
        if (start < todayStart) {
          weekSecondsStartOfDay += entry.duration;
        }
      }
      if (start >= monthStart) {
        monthSeconds += entry.duration;
        monthlyRevenue += hours * project.hourlyRate;
      } else if (start >= lastMonthStart && start < lastMonthEnd) {
        lastMonthRevenue += hours * project.hourlyRate;
      }
      if (start >= rollingBounds.start && start < rollingBounds.endExclusive) {
        rollingSeconds += entry.duration;
        rollingRevenue += hours * project.hourlyRate;
      }
      totalRevenue += hours * project.hourlyRate;
      // Accumulate revenue for last week (previous 7 days before the current week)
      if (start >= lastWeekStart && start < lastWeekEnd) {
        lastWeekRevenue += hours * project.hourlyRate;
      }
    });
    const todayHours = todaySeconds / 3600;
    const yesterdayHours = yesterdaySeconds / 3600;
    const weekHours = weekSeconds / 3600;
    const monthHours = monthSeconds / 3600;
    const rollingHours = rollingSeconds / 3600;
    const weeklyProgress =
      weeklyTarget > 0
        ? (weekHours / weeklyTarget) * 100
        : weekHours > 0
          ? 100
          : 0;
    const rollingProgress =
      rollingTarget > 0
        ? (rollingHours / rollingTarget) * 100
        : rollingHours > 0
          ? 100
          : 0;
    const revenueChange =
      lastMonthRevenue > 0
        ? ((monthlyRevenue - lastMonthRevenue) / lastMonthRevenue) * 100
        : null;
    const todayChange =
      yesterdayHours > 0
        ? ((todayHours - yesterdayHours) / yesterdayHours) * 100
        : null;
    const activeProjectsCount = activeProjects.length;
    const dueThisWeek = activeProjects.filter((p) => {
      const deadlineDay = getProjectDeadlineDay(p);
      if (!deadlineDay) return false;
      const diffDays = diffCalendarDays(todayStart, deadlineDay);
      return diffDays >= 0 && diffDays <= 7;
    }).length;
    const monthProgress =
      monthTarget > 0
        ? (monthHours / monthTarget) * 100
        : monthHours > 0
          ? 100
          : 0;
    // Weekly revenue change relative to last week. lastWeekRevenue was
    // accumulated in the main entry loop above using the lastWeekStart
    // and lastWeekEnd constants defined earlier in this function.
    const weekRevenueChange =
      lastWeekRevenue > 0
        ? ((weekRevenue - lastWeekRevenue) / lastWeekRevenue) * 100
        : null;
    const todayRevenueChange =
      yesterdayRevenue > 0
        ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100
        : null;

    // --- Daily Target Calculation ---
    // We want the daily target to remain constant throughout a given day. To accomplish this,
    // we base it on the weekly target and hours remaining at the *start* of the day. The weekly
    // target itself changes as you work, since monthly remaining hours shrink. If we used the
    // current weekly target, the daily target would shrink during the day as you record more
    // hours, which is confusing. Instead, we compute a weekly target snapshot for the start
    // of the day using monthly remaining hours at the start of the day.
    const weekHoursStartOfDay = weekSecondsStartOfDay / 3600;
    // Use the weekly target snapshot (computed from each project's week-start plan) so the
    // daily target aligns with the "This Week" card and does not drop to zero mid‑week.
    const weeklyTargetStartOfDay = weeklyTarget;
    // The weekly remaining hours at the start of the day is the difference between this snapshot
    // weekly target and the hours already worked this week before today.
    const weeklyRemainingStart = weeklyTargetStartOfDay - weekHoursStartOfDay;
    // Determine the start of next week (Monday at 00:00) by adding 7 days to the current weekStart.
    const startNextWeekDT = new Date(
      weekStart.getTime() + 7 * 24 * 60 * 60 * 1000
    );
    // Count working days remaining in this week (including today) by using todayStart. Using
    // todayStart ensures that partial days are counted as a full day for the target distribution.
    const workDaysLeftInWeekDT = countWorkdays(todayStart, startNextWeekDT);
    let computedDailyTarget = 0;
    if (weeklyRemainingStart > 0 && workDaysLeftInWeekDT > 0) {
      computedDailyTarget = weeklyRemainingStart / workDaysLeftInWeekDT;
    }
    dailyTarget = computedDailyTarget;
    return {
      todayHours,
      yesterdayHours,
      weekHours,
      weekTarget: weeklyTarget,
      weeklyProgress,
      monthHours,
      monthTarget,
      monthProgress,
      monthRevenue: monthlyRevenue,
      rollingHours,
      rollingTarget,
      rollingProgress,
      rollingRevenue,
      lastMonthRevenue,
      revenueChange,
      todayChange,
      // revenue today and this week
      todayRevenue,
      weekRevenue,
      todayRevenueChange,
      weekRevenueChange,
      activeProjects: activeProjectsCount,
      dueThisWeek,
      totalRevenue,
      dailyTarget
    };
  }

  // Dashboard rendering
  function updateDashboard() {
    const stats = computeGlobalStats();
    const nowTime = new Date();
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project, nowTime)
    );
    // Precompute per-project stats once for use in cards and recommendations. This avoids
    // recalculating computeProjectStats multiple times during rendering.
    const perProjectStats = activeProjects.map((p) => {
      return { project: p, stats: computeProjectStats(p) };
    });
    const weekContext = getCurrentWeekPlanningContext(nowTime);
    const dailyPlanByProjectId = new Map(
      perProjectStats.map((item) => [
        String(item.project.id),
        getProjectDailyPlan(item.project, item.stats, weekContext)
      ])
    );
    const recommendedProjectEntry = getRecommendedProjectEntry(
      perProjectStats,
      dailyPlanByProjectId
    );
    // Update global identifiers so other sections know which project is recommended
    _currentRecommendedWeeklyId = recommendedProjectEntry
      ? recommendedProjectEntry.project.id
      : null;
    currentRecommendedMonthlyId = recommendedProjectEntry
      ? recommendedProjectEntry.project.id
      : null;
    // Calculate time progress for the current week and month. Instead of using only
    // whole working days, include the fraction of the day that has elapsed. For
    // weekly progress, Monday 00:00 marks the start and Friday 23:59 marks the
    // end (5 days). For monthly progress, the first day of the month marks
    // the start and the first day of the following month marks the end.
    // Weekly time progress: compute fraction of the 5-day work week that has elapsed.
    const weeklyTimeProgress = weekContext.weeklyTimeProgress;
    // Monthly time progress: compute fraction of working days elapsed in the current month. We count
    // only Monday–Friday as working days. Use countWorkdays() to determine the total number of
    // working days in the month and how many have elapsed so far. Weekends contribute nothing.
    // Determine schedule status for weekly and monthly progress by comparing hours progress
    // to time progress. If the hours progress (worked/target) exceeds time progress, the user is ahead.
    const weekHoursProgress =
      stats.weekTarget > 0 ? (stats.weekHours / stats.weekTarget) * 100 : 0;
    const weekScheduleDiff = weekHoursProgress - weeklyTimeProgress;
    const weekScheduleLabel =
      weekScheduleDiff > 5
        ? 'Ahead of schedule'
        : weekScheduleDiff < -5
          ? 'Behind schedule'
          : 'On schedule';
    const workoutPlan = computeWorkoutWeekPlan();
    const workoutScheduled = workoutPlan.requiredPoints;
    const workoutValue =
      workoutScheduled > 0
        ? `${formatPoints(workoutPlan.actualPoints)} / ${formatPoints(workoutScheduled)} pts`
        : `${formatPoints(workoutPlan.actualPoints)} pts`;
    const workoutProgressPercent = workoutPlan.paused
      ? 0
      : Math.min(100, Math.max(0, workoutPlan.progressPercent));
    const workoutTimeProgress = workoutPlan.paused
      ? 0
      : Math.min(100, Math.max(0, workoutPlan.timeProgress));
    const workoutProgressLabel = workoutPlan.paused
      ? 'Week paused – no workouts required'
      : `${workoutProgressPercent.toFixed(1)}% of weekly schedule in ${workoutTimeProgress.toFixed(1)}% of the week`;
    let workoutScheduleLabel = workoutPlan.paused ? 'Week paused' : 'On track';
    if (!workoutPlan.paused) {
      if (workoutPlan.scheduleDelta >= 1) {
        workoutScheduleLabel = `Ahead by ${formatPoints(workoutPlan.scheduleDelta)} pts`;
      } else if (workoutPlan.scheduleDelta <= -1) {
        workoutScheduleLabel = `Behind by ${formatPoints(Math.abs(workoutPlan.scheduleDelta))} pts`;
      }
    }
    const workoutMetaLabel = workoutPlan.paused
      ? 'Week paused'
      : `Scheduled ${formatPoints(workoutScheduled)} pts (baseline ${formatPoints(workoutPlan.expectedWeekPoints)} pts)`;

    // Stats cards data; integrate recommendations and revenue into relevant cards. Cards with
    // progress also include timeProgress and scheduleLabel for additional context.
    // Build the dashboard cards. We merge revenue into the relevant cards rather than
    // using a separate Revenue card. A multi progress bar visualises both how far
    // through the period we are (expected progress) and how much of the target has
    // been worked. The expected progress (timeProgress) will be rendered as a dark
    // overlay and the actual hours progress as the blue overlay. No textual
    // schedule label is displayed; instead the bar visualises whether you are ahead
    // or behind schedule.
    // Build the dashboard cards. Each card includes a value, progress bar(s), and labels.
    // For the weekly and monthly cards we include both the percentage of target worked and the percentage of the period elapsed.
    const cards = [
      {
        title: "Today's Hours",
        // Show today's hours against the daily target
        value:
          stats.todayHours.toFixed(1) +
          ' / ' +
          (stats.dailyTarget ? stats.dailyTarget.toFixed(1) : '0') +
          'h',
        // Remove change label and comparison to yesterday per user request
        icon: '⏱',
        // Revenue for today shown on this card
        revenue: stats.todayRevenue || 0
      },
      {
        title: 'This Week',
        value:
          stats.weekHours.toFixed(1) +
          ' / ' +
          (stats.weekTarget ? stats.weekTarget.toFixed(1) : '0') +
          'h',
        progress: stats.weeklyProgress,
        // Expected progress based on working days in the week
        timeProgress: weeklyTimeProgress,
        icon: '📅',
        // Progress label expresses hours progress relative to target and time progress relative to the week
        progressLabel:
          (stats.weeklyProgress || 0).toFixed(1) +
          '% of weekly target in ' +
          weeklyTimeProgress.toFixed(1) +
          '% of the week',
        // Schedule label indicates whether the user is ahead, behind, or on schedule this week
        scheduleLabel: weekScheduleLabel,
        // Show revenue earned this week on the same card
        revenue: stats.weekRevenue || 0
      },
      {
        title: 'Rolling 30 Days',
        value:
          stats.rollingHours.toFixed(1) +
          ' / ' +
          (stats.rollingTarget ? stats.rollingTarget.toFixed(1) : '0') +
          'h',
        progress: stats.rollingProgress,
        icon: '30',
        progressLabel:
          (stats.rollingProgress || 0).toFixed(1) + '% of required 30-day pace',
        revenue: stats.rollingRevenue || 0
      },
      {
        title: 'Workout Progress',
        value: workoutValue,
        progress: workoutProgressPercent,
        timeProgress: workoutTimeProgress,
        icon: '💪',
        progressLabel: workoutProgressLabel,
        scheduleLabel: workoutScheduleLabel,
        metaLabel: workoutMetaLabel
      }
    ]; // Active Projects card removed per user request
    const statsGrid = document.getElementById('statsGrid');
    statsGrid.innerHTML = '';
    cards.forEach((card) => {
      const div = document.createElement('div');
      div.className = 'stat-card';
      // icon
      const iconDiv = document.createElement('div');
      iconDiv.className = 'stat-icon';
      iconDiv.textContent = card.icon;
      div.appendChild(iconDiv);
      // title
      const titleDiv = document.createElement('div');
      titleDiv.className = 'stat-title';
      titleDiv.textContent = card.title;
      div.appendChild(titleDiv);
      // value
      const valueDiv = document.createElement('div');
      valueDiv.className = 'stat-value';
      valueDiv.textContent = card.value;
      div.appendChild(valueDiv);
      // progress or change
      if (card.progress !== undefined) {
        // Use a multi progress bar if timeProgress is provided, otherwise fallback to a single bar.
        if (card.timeProgress !== undefined) {
          // Create a container for two stacked progress bars: one for expected progress (black) and one for actual hours (blue).
          const barContainer = document.createElement('div');
          barContainer.style.display = 'flex';
          barContainer.style.flexDirection = 'column';
          barContainer.style.gap = '0.2rem';
          // Actual hours worked bar (blue) shown on top
          const hoursBar = document.createElement('div');
          hoursBar.className = 'progress-bar';
          const hoursFill = document.createElement('div');
          hoursFill.className = 'fill';
          hoursFill.style.width = Math.min(100, card.progress).toFixed(1) + '%';
          hoursBar.appendChild(hoursFill);
          barContainer.appendChild(hoursBar);
          // Expected progress bar (black) shown beneath
          const expectedBar = document.createElement('div');
          expectedBar.className = 'progress-bar';
          const expectedFill = document.createElement('div');
          expectedFill.className = 'fill';
          // Override background color to black for expected progress
          expectedFill.style.backgroundColor = '#000000';
          expectedFill.style.width =
            Math.min(100, card.timeProgress).toFixed(1) + '%';
          expectedBar.appendChild(expectedFill);
          barContainer.appendChild(expectedBar);
          div.appendChild(barContainer);
        } else {
          const progressBar = document.createElement('div');
          progressBar.className = 'progress-bar';
          const fill = document.createElement('div');
          fill.className = 'fill';
          fill.style.width = Math.min(100, card.progress).toFixed(1) + '%';
          progressBar.appendChild(fill);
          div.appendChild(progressBar);
        }
        // Label describing work progress relative to target and time progress
        const pLabel = document.createElement('div');
        pLabel.className = 'stat-change';
        pLabel.textContent = card.progressLabel || '';
        pLabel.style.color = '#475569';
        div.appendChild(pLabel);
        // If the card contains a schedule label (ahead/behind/on), add a second line with colour coding
        if (card.scheduleLabel) {
          const sched = document.createElement('div');
          sched.className = 'stat-change';
          sched.textContent = card.scheduleLabel;
          // Colour code the schedule: green for ahead, red for behind, amber for on schedule
          const text = card.scheduleLabel.toLowerCase();
          if (text.includes('ahead')) sched.style.color = '#15803d';
          else if (text.includes('behind')) sched.style.color = '#b91c1c';
          else sched.style.color = '#92400e';
          div.appendChild(sched);
        }
        if (card.metaLabel) {
          const meta = document.createElement('div');
          meta.className = 'stat-change';
          meta.textContent = card.metaLabel;
          meta.style.color = '#475569';
          div.appendChild(meta);
        }
      } else {
        // Change or change label for cards without progress
        const changeDiv = document.createElement('div');
        changeDiv.className = 'stat-change';
        if (card.change === null || card.change === undefined) {
          changeDiv.textContent = card.changeLabel || '';
          changeDiv.style.color = '#475569';
        } else {
          const change = card.change;
          const prefix = change >= 0 ? '+' : '';
          changeDiv.textContent =
            prefix + change.toFixed(0) + '% ' + card.changeLabel;
          changeDiv.classList.add(change >= 0 ? 'positive' : 'negative');
        }
        div.appendChild(changeDiv);
      }
      // Append revenue information if provided on the card
      if (card.revenue !== undefined) {
        const revenueDiv = document.createElement('div');
        revenueDiv.className = 'stat-change';
        // Round revenue to the nearest 10 (use decimals = -1) for dashboard display
        revenueDiv.textContent = 'Revenue: ' + formatCurrency(card.revenue, -1);
        revenueDiv.style.color = '#475569';
        div.appendChild(revenueDiv);
      }
      // Append per‑project breakdowns underneath each card. For Today, display today's hours
      // against the recommended daily hours for each project. For Week and Month, display
      // actual versus target hours and colour code based on whether the project is ahead
      // (green) or behind (red) relative to the expected progress so far.
      if (
        card.title === "Today's Hours" ||
        card.title === 'This Week' ||
        card.title === 'Rolling 30 Days'
      ) {
        const list = document.createElement('div');
        list.style.marginTop = '0.5rem';
        perProjectStats.forEach((item) => {
          const row = document.createElement('div');
          row.style.fontSize = '0.75rem';
          const projectDailyPlan =
            dailyPlanByProjectId.get(String(item.project.id)) ||
            getProjectDailyPlan(item.project, item.stats, weekContext);
          const projectTodayHours = projectDailyPlan.todayHours;
          const projectDailyTarget = projectDailyPlan.dailyTarget;
          // For weekly expected to date, compute expected hours based on time progress
          const expectedWeekSoFar =
            item.stats.weeklyTargetConst * (weeklyTimeProgress / 100);
          if (card.title === "Today's Hours") {
            // For daily: show hours worked and daily target, colour green if on or ahead, else red
            row.textContent = `${item.project.name}: ${projectTodayHours.toFixed(1)} / ${projectDailyTarget.toFixed(1)}h`;
            row.style.color =
              projectTodayHours >= projectDailyTarget ? '#15803d' : '#b91c1c';
          } else if (card.title === 'This Week') {
            row.textContent = `${item.project.name}: ${item.stats.weeklyHours.toFixed(1)} / ${item.stats.weeklyTargetConst.toFixed(1)}h`;
            // Colour code: green if actual hours exceed expected progress so far, red otherwise
            const onTrack = item.stats.weeklyHours >= expectedWeekSoFar - 0.01; // small tolerance
            row.style.color = onTrack ? '#15803d' : '#b91c1c';
          } else {
            row.textContent = `${item.project.name}: ${item.stats.rolling30Hours.toFixed(1)} / ${item.stats.rolling30TargetConst.toFixed(1)}h`;
            const onTrack =
              item.stats.rolling30Hours >=
              item.stats.rolling30TargetConst - 0.01;
            row.style.color = onTrack ? '#15803d' : '#b91c1c';
          }
          list.appendChild(row);
        });
        div.appendChild(list);
      }
      statsGrid.appendChild(div);
    });
    // Project status overview and detailed breakdown
    renderProjectOverview();
    renderDetailedBreakdown();
    // Render daily hours heatmap and update burndown chart
    renderHeatmap();
    updateBurndownSelect();
    // Previously there was a separate Recommendations card here. It has been removed in favor of integrating suggestions directly into other sections.

    // Prepare data for weekly and monthly scatter charts
    const weeklyDatasets = [];
    const monthlyDatasets = [];
    // Track the maximum expected/actual values to draw an ideal x=y line
    let maxWeeklyVal = 0;
    let maxMonthlyVal = 0;
    activeProjects.forEach((project) => {
      const statsP = computeProjectStats(project);
      const color = project.color || '#3b82f6';
      weeklyDatasets.push({
        label: project.name,
        data: [{ x: statsP.weeklyExpected, y: statsP.weeklyHours }],
        // Use project color for point appearance
        pointBackgroundColor: color,
        pointBorderColor: color,
        backgroundColor: color,
        borderColor: color,
        pointRadius: 5,
        pointHoverRadius: 7,
        showLine: false
      });
      monthlyDatasets.push({
        label: project.name,
        data: [{ x: statsP.monthlyExpected, y: statsP.monthlyHours }],
        // Use project color for point appearance
        pointBackgroundColor: color,
        pointBorderColor: color,
        backgroundColor: color,
        borderColor: color,
        pointRadius: 5,
        pointHoverRadius: 7,
        showLine: false
      });
      // Update max values for diagonal line
      maxWeeklyVal = Math.max(
        maxWeeklyVal,
        statsP.weeklyExpected,
        statsP.weeklyHours
      );
      maxMonthlyVal = Math.max(
        maxMonthlyVal,
        statsP.monthlyExpected,
        statsP.monthlyHours
      );
    });
    // Add diagonal x=y guide line datasets to both charts
    if (weeklyDatasets.length > 0) {
      weeklyDatasets.unshift({
        label: 'Ideal (x=y)',
        data: [
          { x: 0, y: 0 },
          { x: maxWeeklyVal, y: maxWeeklyVal }
        ],
        borderColor: '#94a3b8',
        borderDash: [5, 5],
        showLine: true,
        fill: false,
        pointRadius: 0
      });
    }
    if (monthlyDatasets.length > 0) {
      monthlyDatasets.unshift({
        label: 'Ideal (x=y)',
        data: [
          { x: 0, y: 0 },
          { x: maxMonthlyVal, y: maxMonthlyVal }
        ],
        borderColor: '#94a3b8',
        borderDash: [5, 5],
        showLine: true,
        fill: false,
        pointRadius: 0
      });
    }
    // Weekly scatter chart
    const weeklyCanvas = document.getElementById('weeklyScatter');
    if (weeklyCanvas) {
      if (!weeklyScatterChart) {
        const ctx = weeklyCanvas.getContext('2d');
        weeklyScatterChart = new Chart(ctx, {
          type: 'scatter',
          data: { datasets: weeklyDatasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: true,
                position: 'bottom',
                labels: { boxWidth: 12 }
              },
              tooltip: {
                callbacks: {
                  label: function (context) {
                    const label = context.dataset.label || '';
                    const xVal = context.parsed.x;
                    const yVal = context.parsed.y;
                    return (
                      label +
                      ': Expected ' +
                      xVal.toFixed(1) +
                      'h, Actual ' +
                      yVal.toFixed(1) +
                      'h'
                    );
                  }
                }
              },
              title: { display: false }
            },
            scales: {
              x: {
                title: { display: true, text: 'Expected Hours' },
                beginAtZero: true
              },
              y: {
                title: { display: true, text: 'Actual Hours' },
                beginAtZero: true
              }
            }
          }
        });
      } else {
        weeklyScatterChart.data.datasets = weeklyDatasets;
        weeklyScatterChart.update();
      }
    }
    // Monthly scatter chart
    const monthlyCanvas = document.getElementById('monthlyScatter');
    if (monthlyCanvas) {
      if (!monthlyScatterChart) {
        const ctx2 = monthlyCanvas.getContext('2d');
        monthlyScatterChart = new Chart(ctx2, {
          type: 'scatter',
          data: { datasets: monthlyDatasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: true,
                position: 'bottom',
                labels: { boxWidth: 12 }
              },
              tooltip: {
                callbacks: {
                  label: function (context) {
                    const label = context.dataset.label || '';
                    const xVal = context.parsed.x;
                    const yVal = context.parsed.y;
                    return (
                      label +
                      ': Expected ' +
                      xVal.toFixed(1) +
                      'h, Actual ' +
                      yVal.toFixed(1) +
                      'h'
                    );
                  }
                }
              },
              title: { display: false }
            },
            scales: {
              x: {
                title: { display: true, text: 'Expected Hours' },
                beginAtZero: true
              },
              y: {
                title: { display: true, text: 'Actual Hours' },
                beginAtZero: true
              }
            }
          }
        });
      } else {
        monthlyScatterChart.data.datasets = monthlyDatasets;
        monthlyScatterChart.update();
      }
    }
  }

  // Render project overview list
  function renderProjectOverview() {
    const container = document.getElementById('projectOverview');
    container.innerHTML = '';
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project)
    );
    if (activeProjects.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'project-list';
    const header = document.createElement('div');
    header.className = 'project-list-header';
    header.textContent = 'Project Status Overview';
    wrapper.appendChild(header);
    activeProjects.forEach((project) => {
      const stats = computeProjectStats(project);
      const item = document.createElement('div');
      item.className = 'project-item';
      // info section
      const info = document.createElement('div');
      info.className = 'project-info';
      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.style.backgroundColor = project.color || '#3b82f6';
      info.appendChild(dot);
      const nameDiv = document.createElement('div');
      nameDiv.style.fontWeight = '600';
      nameDiv.style.fontSize = '0.9rem';
      nameDiv.textContent = project.name;
      // Add a star marker for the project that most needs attention right now.
      if (project.id === currentRecommendedMonthlyId) {
        const starM = document.createElement('span');
        starM.textContent = '★';
        starM.style.color = '#f97316';
        starM.style.marginLeft = '0.25rem';
        starM.title = 'Recommended pace project';
        nameDiv.appendChild(starM);
      }
      info.appendChild(nameDiv);
      const hoursDiv = document.createElement('div');
      hoursDiv.style.fontSize = '0.8rem';
      hoursDiv.style.color = '#64748b';
      hoursDiv.textContent =
        stats.totalHours.toFixed(1) +
        'h / ' +
        project.budgetHours.toFixed(1) +
        'h';
      info.appendChild(hoursDiv);
      item.appendChild(info);
      // progress bar container showing expected progress (black) and hours worked (blue) as two stacked bars
      const progressContainer = document.createElement('div');
      progressContainer.style.flex = '1';
      progressContainer.style.margin = '0 1rem';
      progressContainer.style.display = 'flex';
      progressContainer.style.flexDirection = 'column';
      progressContainer.style.gap = '0.2rem';
      // Calculate expected progress through the project (days passed / total days)
      const totalProjectDaysProg = stats.daysPassed + stats.daysLeft;
      const timeProg =
        totalProjectDaysProg > 0
          ? (stats.daysPassed / totalProjectDaysProg) * 100
          : 0;
      const usedProg = stats.usedPct;
      // Hours worked progress bar (blue) shown on top
      const hoursBar = document.createElement('div');
      hoursBar.className = 'progress-bar';
      const hoursFill = document.createElement('div');
      hoursFill.className = 'fill';
      hoursFill.style.width = Math.min(100, usedProg).toFixed(1) + '%';
      hoursBar.appendChild(hoursFill);
      progressContainer.appendChild(hoursBar);
      // Expected progress bar (black) shown beneath
      const expectedBar = document.createElement('div');
      expectedBar.className = 'progress-bar';
      const expectedFill = document.createElement('div');
      expectedFill.className = 'fill';
      expectedFill.style.backgroundColor = '#000000';
      expectedFill.style.width = Math.min(100, timeProg).toFixed(1) + '%';
      expectedBar.appendChild(expectedFill);
      progressContainer.appendChild(expectedBar);
      // Determine schedule status for this project by comparing used percent to time progress
      const scheduleDiffProj = usedProg - timeProg;
      let scheduleTextProj;
      if (scheduleDiffProj > 5) scheduleTextProj = 'Ahead of schedule';
      else if (scheduleDiffProj < -5) scheduleTextProj = 'Behind schedule';
      else scheduleTextProj = 'On schedule';
      // Create a small label below the bars to indicate schedule status
      const schedDivProj = document.createElement('div');
      schedDivProj.style.fontSize = '0.7rem';
      schedDivProj.style.marginTop = '0.25rem';
      // Colour code: green ahead, red behind, amber for on schedule
      if (scheduleDiffProj > 5) schedDivProj.style.color = '#15803d';
      else if (scheduleDiffProj < -5) schedDivProj.style.color = '#b91c1c';
      else schedDivProj.style.color = '#92400e';
      schedDivProj.textContent = scheduleTextProj;
      progressContainer.appendChild(schedDivProj);
      item.appendChild(progressContainer);
      // Add schedule text comment after bars
      // Note: status badge with descriptive text and tooltip will still be appended below
      // status badge with descriptive text and tooltip
      const status = document.createElement('span');
      status.className = 'status-badge ' + (stats.statusColor || 'green');
      // Determine human-friendly label
      let statusLabel;
      if (stats.status === 'over-budget') statusLabel = 'Over Budget';
      else if (stats.status === 'behind-schedule')
        statusLabel = 'Behind Schedule';
      else if (stats.status === 'tight') statusLabel = 'Tight';
      else statusLabel = 'On Track';
      status.textContent = statusLabel;
      // Tooltip explaining the reason
      if (stats.reason) {
        status.title = stats.reason;
      }
      item.appendChild(status);
      wrapper.appendChild(item);
    });
    container.appendChild(wrapper);
  }

  // Render detailed project breakdown table
  function renderDetailedBreakdown() {
    const container = document.getElementById('detailedBreakdown');
    container.innerHTML = '';
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project)
    );
    if (activeProjects.length === 0) return;
    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = 'Detailed Project Breakdown';
    heading.style.margin = '0 0 0.5rem 0';
    heading.style.fontSize = '1.1rem';
    heading.style.fontWeight = '600';
    card.appendChild(heading);
    const table = document.createElement('table');
    // Add responsive-table class for mobile-friendly styling
    table.classList.add('responsive-table');
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th>Project</th><th>Client</th><th>Hours</th><th>Budget</th><th>Status</th><th>This Week</th><th>Last Week</th><th>30-Day Pace</th><th>Revenue</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    activeProjects.forEach((project) => {
      const stats = computeProjectStats(project);
      const isRecommendedMonthly = project.id === currentRecommendedMonthlyId;
      const tr = document.createElement('tr');
      // Determine human-friendly label and color for status
      let statusLabel;
      if (stats.status === 'over-budget') statusLabel = 'Over Budget';
      else if (stats.status === 'behind-schedule')
        statusLabel = 'Behind Schedule';
      else if (stats.status === 'tight') statusLabel = 'Tight';
      else statusLabel = 'On Track';
      tr.innerHTML = `
              <td data-label="Project">${project.name}</td>
              <td data-label="Client">${project.client || '-'}</td>
              <td data-label="Hours">${stats.totalHours.toFixed(1)}h</td>
              <td data-label="Budget">${project.budgetHours.toFixed(1)}h</td>
              <td data-label="Status"><span class="status-badge ${stats.statusColor}"${stats.reason ? ` title="${stats.reason}"` : ''}>${statusLabel}</span></td>
              <td data-label="This Week">${stats.weeklyHours.toFixed(1)} / ${stats.weeklyTargetConst.toFixed(1)}h (target)</td>
              <td data-label="Last Week">${stats.lastWeekHours.toFixed(1)}h</td>
              <td data-label="30-Day Pace">${stats.rolling30Hours.toFixed(1)} / ${stats.rolling30TargetConst.toFixed(1)}h${isRecommendedMonthly ? ' (Recommended)' : ''} (pace)</td>
              <td data-label="Revenue">${formatCurrency(stats.revenue)}</td>
            `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    // Wrap table in a scroll container to improve mobile usability
    const wrapper = document.createElement('div');
    wrapper.style.overflowX = 'auto';
    wrapper.appendChild(table);
    card.appendChild(wrapper);
    container.appendChild(card);
  }

  // Render a heatmap of hours per day for the current month. Each cell's color intensity
  // corresponds to the number of hours worked on that day. Darker colors represent more
  // hours. The heatmap table is created dynamically within the #heatmap div.
  function renderHeatmap() {
    const heatmapDiv = document.getElementById('heatmap');
    if (!heatmapDiv) return;
    heatmapDiv.innerHTML = '';
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Accumulate hours for each day of this month
    const dailyHours = {};
    data.entries.forEach((entry) => {
      if (!entry.duration) return;
      if (entry.isRunning) return;
      const dt = new Date(entry.startTime);
      if (dt.getFullYear() === year && dt.getMonth() === month) {
        const day = dt.getDate();
        dailyHours[day] = (dailyHours[day] || 0) + entry.duration / 3600;
      }
    });
    // Determine the maximum hours to scale colors
    let maxHours = 0;
    Object.values(dailyHours).forEach((val) => {
      if (val > maxHours) maxHours = val;
    });
    // Define function to interpolate between two colors based on a factor (0 to 1)
    function interpolateColor(color1, color2, factor) {
      const c1 = parseInt(color1.slice(1), 16);
      const c2 = parseInt(color2.slice(1), 16);
      const r1 = (c1 >> 16) & 0xff;
      const g1 = (c1 >> 8) & 0xff;
      const b1 = c1 & 0xff;
      const r2 = (c2 >> 16) & 0xff;
      const g2 = (c2 >> 8) & 0xff;
      const b2 = c2 & 0xff;
      const r = Math.round(r1 + (r2 - r1) * factor);
      const g = Math.round(g1 + (g2 - g1) * factor);
      const b = Math.round(b1 + (b2 - b1) * factor);
      const hex = (r << 16) | (g << 8) | b;
      return '#' + hex.toString(16).padStart(6, '0');
    }
    // Colors for low and high values
    const lowColor = '#e0e7ff';
    const highColor = '#1e40af';
    // Create table element
    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    const headerRow = document.createElement('tr');
    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    daysOfWeek.forEach((dow) => {
      const th = document.createElement('th');
      th.textContent = dow;
      th.style.fontSize = '0.8rem';
      th.style.padding = '0.25rem';
      headerRow.appendChild(th);
    });
    table.appendChild(headerRow);
    // Determine how many blank cells before the first day (Monday=0) adjusting for Sunday=6
    // In this implementation, Monday is first column; getDay() returns 0 for Sunday so convert
    let startWeekday = firstDay.getDay();
    startWeekday = (startWeekday + 6) % 7; // convert so Monday=0, Sunday=6
    let currentDay = 1;
    // Build rows until all days placed
    while (currentDay <= daysInMonth) {
      const row = document.createElement('tr');
      for (let i = 0; i < 7; i++) {
        const cell = document.createElement('td');
        cell.style.width = '14.28%';
        cell.style.height = '2rem';
        cell.style.border = '1px solid #f1f5f9';
        cell.style.textAlign = 'center';
        cell.style.fontSize = '0.75rem';
        if (
          (currentDay === 1 && i < startWeekday) ||
          currentDay > daysInMonth
        ) {
          // empty cell
          cell.textContent = '';
          cell.style.backgroundColor = '#f8fafc';
        } else {
          const hours = dailyHours[currentDay] || 0;
          // compute color intensity
          let color;
          if (hours <= 0 || maxHours === 0) {
            color = '#f8fafc';
          } else {
            const factor = Math.min(hours / maxHours, 1);
            color = interpolateColor(lowColor, highColor, factor);
          }
          cell.style.backgroundColor = color;
          cell.textContent = currentDay;
          if (hours > 0) {
            const hoursSpan = document.createElement('div');
            hoursSpan.textContent = hours.toFixed(1) + 'h';
            hoursSpan.style.fontSize = '0.6rem';
            hoursSpan.style.color = '#0f172a';
            cell.appendChild(hoursSpan);
          }
          currentDay++;
        }
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    heatmapDiv.appendChild(table);
  }

  // Populate the burndown project selector and render the initial burndown chart
  function updateBurndownSelect() {
    const select = document.getElementById('burndownProjectSelect');
    if (!select) return;
    // Prevent multiple event listeners by cloning without listeners
    const newSelect = select.cloneNode(false);
    select.parentNode.replaceChild(newSelect, select);
    data.projects.forEach((project) => {
      const opt = document.createElement('option');
      opt.value = project.id;
      opt.textContent = project.name;
      newSelect.appendChild(opt);
    });
    newSelect.addEventListener('change', (e) => {
      renderBurndownChart(e.target.value);
    });
    // Render initial chart for first project (if any)
    if (data.projects.length > 0) {
      const firstId = data.projects[0].id;
      newSelect.value = firstId;
      renderBurndownChart(firstId);
    }
  }

  // Render the burndown chart for a given project ID. This charts cumulative hours worked
  // against the expected cumulative hours (linear budget burn) from project start to deadline.
  function renderBurndownChart(projectId) {
    const canvas = document.getElementById('burndownChart');
    if (!canvas || !Chart) return;
    const ctx = canvas.getContext('2d');
    // Destroy existing chart if present
    if (window.burndownChart) {
      try {
        window.burndownChart.destroy();
      } catch (err) {}
    }
    const project = data.projects.find(
      (p) => String(p.id) === String(projectId)
    );
    if (!project) return;
    const startDay = getProjectStartDate(project);
    const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
    if (!deadlineEndExclusive) return;
    const now = new Date();
    const todayEndExclusive = addLocalDays(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      1
    );
    const totalProjectDays = Math.max(
      1,
      diffCalendarDays(startDay, deadlineEndExclusive)
    );
    const totalDaysShown = diffCalendarDays(startDay, todayEndExclusive);
    if (totalDaysShown <= 0) return;

    const pad2 = (value) => String(value).padStart(2, '0');
    const labels = [];
    const actual = [];
    const expected = [];

    const dailyHoursMap = {};
    data.entries.forEach((entry) => {
      if (entry.isRunning || !entry.duration) return;
      if (entry.projectId !== project.id) return;
      const start = new Date(entry.startTime);
      const dayKey = formatLocalDateString(start);
      dailyHoursMap[dayKey] =
        (dailyHoursMap[dayKey] || 0) + entry.duration / 3600;
    });

    let cumulativeHours = 0;
    for (let i = 0; i < totalDaysShown; i++) {
      const day = addLocalDays(startDay, i);
      const dayKey = formatLocalDateString(day);
      cumulativeHours += dailyHoursMap[dayKey] || 0;
      labels.push(`${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`);
      actual.push(cumulativeHours);
      const ratio =
        totalProjectDays > 0 ? Math.min((i + 1) / totalProjectDays, 1) : 0;
      expected.push(project.budgetHours * ratio);
    }
    // Create chart
    window.burndownChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Expected',
            data: expected,
            borderColor: '#64748b',
            backgroundColor: '#64748b',
            borderWidth: 2,
            fill: false
          },
          {
            label: 'Actual',
            data: actual,
            borderColor: project.color || '#3b82f6',
            backgroundColor: project.color || '#3b82f6',
            borderWidth: 2,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            display: true,
            position: 'bottom'
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Hours'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Date'
            }
          }
        }
      }
    });
  }

  // Projects page rendering
  function updateProjectsPage() {
    updateProjectSelects();
    renderProjectsPageList();
  }
  function renderProjectsPageList() {
    const container = document.getElementById('projectsPageList');
    container.innerHTML = '';
    if (data.projects.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No projects yet.';
      container.appendChild(p);
      return;
    }
    data.projects.forEach((project) => {
      const stats = computeProjectStats(project);
      // Determine if this project is the recommended one for this week or month
      const isRecommendedMonthly = project.id === currentRecommendedMonthlyId;
      // Determine a human-friendly status label and color
      let statusLabel;
      if (stats.status === 'over-budget') statusLabel = 'Over Budget';
      else if (stats.status === 'behind-schedule')
        statusLabel = 'Behind Schedule';
      else if (stats.status === 'tight') statusLabel = 'Tight';
      else statusLabel = 'On Track';
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
              <h3 style="margin:0 0 0.5rem 0; font-size:1.1rem; font-weight:600;">${project.name}</h3>
              <p style="margin:0 0 0.25rem 0;"><strong>Client:</strong> ${project.client || '-'}</p>
              <p style="margin:0 0 0.25rem 0;"><strong>Budget:</strong> ${project.budgetHours.toFixed(1)}h @ ${formatCurrency(project.hourlyRate)}</p>
              <div style="margin:0.5rem 0;">
                <!-- Dual progress bars showing actual hours vs expected timeline progress -->
                <div style="display:flex; flex-direction:column; gap:0.2rem; margin-bottom:0.25rem;">
                  <!-- Actual hours consumed (blue) -->
                  <div class="progress-bar"><div class="fill" style="width:${Math.min(100, stats.usedPct).toFixed(1)}%;"></div></div>
                  <!-- Expected progress based on time elapsed relative to deadline (black) -->
                  <div class="progress-bar"><div class="fill" style="width:${(stats.daysPassed + stats.daysLeft > 0 ? (stats.daysPassed / (stats.daysPassed + stats.daysLeft)) * 100 : 0).toFixed(1)}%; background-color:#000000;"></div></div>
                </div>
                <small>${stats.totalHours.toFixed(1)}h used (${stats.usedPct.toFixed(1)}%) &bullet; Expected ${stats.daysPassed + stats.daysLeft > 0 ? ((stats.daysPassed / (stats.daysPassed + stats.daysLeft)) * 100).toFixed(1) : '0'}%</small>
              </div>
              <div style="margin:0.5rem 0;">
                <div class="progress-bar" style="margin-bottom:0.25rem;"><div class="fill" style="width:${stats.weeklyTargetConst ? (stats.weeklyHours / stats.weeklyTargetConst) * 100 : 0}%"></div></div>
                <small>This week: ${stats.weeklyHours.toFixed(1)} / ${stats.weeklyTargetConst.toFixed(1)}h (target)</small>
              </div>
              <div style="margin:0.5rem 0;">
                <div class="progress-bar" style="margin-bottom:0.25rem;"><div class="fill" style="width:${stats.rolling30TargetConst ? (stats.rolling30Hours / stats.rolling30TargetConst) * 100 : 0}%"></div></div>
                <small>30-day pace: ${stats.rolling30Hours.toFixed(1)} / ${stats.rolling30TargetConst.toFixed(1)}h${isRecommendedMonthly ? ' (Recommended)' : ''}</small>
              </div>
              <p style="margin:0.25rem 0;"><strong>Start Date:</strong> ${formatDate(project.startDate || project.createdAt)}</p>
              <p style="margin:0.25rem 0;"><strong>Deadline:</strong> ${formatDate(project.deadline)}</p>
              <p style="margin:0.25rem 0;"><strong>Status:</strong> <span class="status-badge ${stats.statusColor || 'green'}"${stats.reason ? ` title="${stats.reason}"` : ''}>${statusLabel}</span></p>
              <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
                <button class="btn secondary edit-btn" data-id="${project.id}">Edit</button>
                <button class="btn danger delete-btn" data-id="${project.id}">Delete</button>
              </div>
            `;
      // Edit button handler
      const editBtn = card.querySelector('.edit-btn');
      editBtn.addEventListener('click', () => {
        // Prompt the user for new project details
        const newName = prompt('Project Name:', project.name);
        if (!newName) return;
        const newClient = prompt('Client (optional):', project.client || '');
        const newBudgetStr = prompt(
          'Budget Hours:',
          project.budgetHours.toFixed(1)
        );
        const newBudget = parseFloat(newBudgetStr);
        if (isNaN(newBudget)) return;
        const newRateStr = prompt(
          'Hourly Rate:',
          project.hourlyRate.toFixed(2)
        );
        const newRate = parseFloat(newRateStr);
        if (isNaN(newRate)) return;
        const currentStartDate =
          project.startDate ||
          formatLocalDateString(getProjectStartDate(project));
        const newStartDate = prompt(
          'Start Date (YYYY-MM-DD):',
          currentStartDate
        );
        if (!newStartDate) return;
        const newDeadline = prompt('Deadline (YYYY-MM-DD):', project.deadline);
        if (!newDeadline) return;
        // Prompt for rounding preference (minutes) and update roundingMinutes
        const newRoundingStr = prompt(
          'Rounding (minutes – 0 for none, 5, 10, 15):',
          project.roundingMinutes != null
            ? project.roundingMinutes.toString()
            : '0'
        );
        const newRoundingInt = parseInt(newRoundingStr, 10);
        // If the user cancels or enters invalid number, leave rounding unchanged
        if (!isNaN(newRoundingInt)) {
          project.roundingMinutes = newRoundingInt;
        }
        // Update project fields
        project.name = newName.trim();
        project.client = newClient ? newClient.trim() : null;
        project.budgetHours = newBudget;
        project.hourlyRate = newRate;
        project.startDate = newStartDate;
        project.deadline = newDeadline;
        saveData();
        updateProjectsPage();
        updateProjectSelects();
        updateDashboard();
      });
      // Delete button handler
      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', () => {
        if (confirm('Delete this project and its entries?')) {
          data.projects = data.projects.filter((p) => p.id !== project.id);
          data.entries = data.entries.filter((e) => e.projectId !== project.id);
          saveData();
          updateProjectsPage();
          updateDashboard();
        }
      });
      container.appendChild(card);
    });
  }

  // Create new project
  document.getElementById('projectFormPro').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('projectNamePro').value.trim();
    const client = document.getElementById('projectClientPro').value.trim();
    const budget = parseFloat(
      document.getElementById('projectBudgetPro').value
    );
    const rate = parseFloat(document.getElementById('projectRatePro').value);
    const startDateInput = document.getElementById('projectStartDatePro').value;
    const deadline = document.getElementById('projectDeadlinePro').value;
    if (!name || !deadline) return;
    const startDate = startDateInput || formatLocalDateString(new Date());
    const newProject = {
      id: uuid(),
      name,
      client: client || null,
      budgetHours: budget,
      hourlyRate: rate,
      startDate,
      deadline,
      createdAt: new Date().toISOString(),
      color: getUniqueColor(),
      isActive: true,
      // Store rounding preference for this project; roundingMinutes is the interval in minutes (0 means no rounding)
      roundingMinutes:
        parseInt(document.getElementById('projectRoundingPro').value, 10) || 0
    };
    data.projects.push(newProject);
    saveData();
    e.target.reset();
    updateProjectsPage();
    updateProjectSelects();
    updateDashboard();
  });

  const monthlyRecurringForm = document.getElementById('monthlyRecurringForm');
  if (monthlyRecurringForm) {
    monthlyRecurringForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('monthlyPaymentName');
      const amountInput = document.getElementById('monthlyPaymentAmount');
      const name = nameInput.value.trim();
      const amount = parseFloat(amountInput.value);
      if (!name) {
        alert('Please enter a payment name.');
        nameInput.focus();
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        alert('Enter a valid amount.');
        amountInput.focus();
        return;
      }
      const payments = ensureMonthlyRecurringPayments();
      payments.push({ id: uuid(), name, amount });
      saveData();
      monthlyRecurringForm.reset();
      updateGrocerySection();
    });
  }

  const groceryForm = document.getElementById('groceryForm');
  if (groceryForm) {
    groceryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('groceryName');
      const freqSelect = document.getElementById('groceryFreq');
      const categorySelect = document.getElementById('groceryCategory');
      const name = nameInput.value.trim();
      if (!name) {
        alert('Please enter an item name.');
        nameInput.focus();
        return;
      }
      const normalizedFreq = ['weekly', 'monthly', 'biannual'].includes(
        (freqSelect.value || '').toLowerCase()
      )
        ? freqSelect.value.toLowerCase()
        : 'weekly';
      const normalizedCategory = ['standard', 'treat', 'essential'].includes(
        (categorySelect.value || '').toLowerCase()
      )
        ? categorySelect.value.toLowerCase()
        : 'standard';
      if (!Array.isArray(data.groceries)) {
        data.groceries = [];
      }
      data.groceries.push({
        id: uuid(),
        name,
        frequency: normalizedFreq,
        category: normalizedCategory,
        archived: false,
        createdAt: new Date().toISOString()
      });
      saveData();
      groceryForm.reset();
      updateGrocerySection();
      if (typeof provideHaptic === 'function') {
        provideHaptic('tick');
      }
    });
  }

  const wealthGoalApplyBtn = document.getElementById('wealthGoalApply');
  const wealthGoalAmountInput = document.getElementById('wealthGoalAmount');
  const wealthGoalDateInput = document.getElementById('wealthGoalDate');
  const wealthEntryForm = document.getElementById('wealthEntryForm');
  const wealthEntryDateInput = document.getElementById('wealthEntryDate');
  const wealthEntryAmountInput = document.getElementById('wealthEntryAmount');
  const wealthEntryNoteInput = document.getElementById('wealthEntryNote');
  function persistWealthGoal() {
    const amount = parseWealthAmount(
      wealthGoalAmountInput ? wealthGoalAmountInput.value : null
    );
    const date =
      wealthGoalDateInput && wealthGoalDateInput.value
        ? wealthGoalDateInput.value
        : '';
    data.wealthGoal = { amount, date };
    saveData();
    updateWealthDashboard();
  }
  if (wealthGoalApplyBtn) {
    wealthGoalApplyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      persistWealthGoal();
    });
  }
  [wealthGoalAmountInput, wealthGoalDateInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('change', () => persistWealthGoal());
  });
  if (wealthEntryForm) {
    wealthEntryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const dateVal = wealthEntryDateInput ? wealthEntryDateInput.value : '';
      const amountVal = wealthEntryAmountInput
        ? wealthEntryAmountInput.value
        : '';
      const noteVal = wealthEntryNoteInput ? wealthEntryNoteInput.value : '';
      const result = addWealthHistoryEntry(dateVal, amountVal, noteVal);
      if (!result.ok) {
        alert(
          result.reason === 'date'
            ? 'Enter a valid date.'
            : 'Enter a valid amount.'
        );
        return;
      }
      wealthEntryForm.reset();
      renderWealthHistoryTable();
      updateWealthDashboard();
    });
  }

  // Color generator for project dots. Ensures uniqueness by selecting an unused color when possible.
  function _getRandomColor() {
    const palette = [
      '#2563eb',
      '#dc2626',
      '#10b981',
      '#8b5cf6',
      '#f59e0b',
      '#ec4899'
    ];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  function getUniqueColor() {
    const palette = [
      '#2563eb',
      '#dc2626',
      '#10b981',
      '#8b5cf6',
      '#f59e0b',
      '#ec4899'
    ];
    // Collect colors already used by existing projects
    const used = new Set(data.projects.map((p) => p.color).filter((c) => c));
    // Find a color not used yet
    for (const col of palette) {
      if (!used.has(col)) {
        return col;
      }
    }
    // If all colors are used, return a random one
    return palette[Math.floor(Math.random() * palette.length)];
  }

  // Timer section functions (reuse from previous implementation but adjust IDs)
  function getRunningEntries() {
    // Return an array of all entries that are currently running
    return data.entries.filter((e) => e.isRunning);
  }
  function updateTimerSection() {
    const runningEntries = getRunningEntries();
    const runningDiv = document.getElementById('runningTimerPro');
    const startDiv = document.getElementById('startTimerPro');
    // Clear any previous interval that updated timers
    clearInterval(timerInterval);
    if (runningEntries.length > 0) {
      // Show the running timers section
      runningDiv.style.display = '';
      // Keep the start form visible to allow starting additional timers
      startDiv.style.display = '';
      // Clear and rebuild the running timers list
      runningDiv.innerHTML = '';
      // Sticky toolbar so it's hard to lose "Stop All Timers" while scrolling.
      const toolbar = document.createElement('div');
      toolbar.className = 'running-timers-toolbar';
      // Heading for running timers
      const heading = document.createElement('h3');
      heading.textContent = 'Running Timers';
      heading.style.margin = '0 0 0.5rem 0';
      heading.style.fontSize = '1.1rem';
      heading.style.fontWeight = '600';
      toolbar.appendChild(heading);
      // Display total earnings for all running timers
      const totalEarnedP = document.createElement('p');
      totalEarnedP.innerHTML =
        '<strong>Total Earned:</strong> <span id="runningTotalEarned"></span>';
      totalEarnedP.style.marginBottom = '0.5rem';
      toolbar.appendChild(totalEarnedP);
      // Display total effective elapsed time across all running timers (matches the per-timer "Elapsed" values).
      const totalElapsedP = document.createElement('p');
      totalElapsedP.innerHTML =
        '<strong>Total Elapsed:</strong> <span id="runningTotalElapsed"></span>';
      totalElapsedP.style.marginBottom = '0.5rem';
      toolbar.appendChild(totalElapsedP);
      const timeLeftTodayP = document.createElement('p');
      timeLeftTodayP.innerHTML =
        '<strong>Time Left Today:</strong> <span id="runningTimeLeftToday"></span>';
      timeLeftTodayP.style.marginBottom = '0.5rem';
      toolbar.appendChild(timeLeftTodayP);
      // Display the sum of all timer factors to make concurrency weighting visible at a glance.
      const totalFactorP = document.createElement('p');
      totalFactorP.innerHTML =
        '<strong>Total Factor:</strong> <span id="runningTotalFactor"></span>';
      totalFactorP.style.marginBottom = '0.5rem';
      toolbar.appendChild(totalFactorP);
      // Add a "Stop All Timers" button to allow stopping all timers at once
      const stopAllBtn = document.createElement('button');
      stopAllBtn.className = 'btn danger';
      stopAllBtn.textContent = 'Stop All Timers';
      stopAllBtn.style.marginBottom = '0';
      stopAllBtn.addEventListener('click', () => {
        stopAllTimers();
      });
      toolbar.appendChild(stopAllBtn);
      runningDiv.appendChild(toolbar);
      // Render each running entry
      runningEntries.forEach((entry) => {
        const project = data.projects.find((p) => p.id === entry.projectId);
        const row = document.createElement('div');
        row.style.marginBottom = '0.75rem';
        // Project name
        const nameP = document.createElement('p');
        nameP.innerHTML =
          '<strong>Project:</strong> ' + (project ? project.name : '');
        row.appendChild(nameP);
        // Started time
        const startP = document.createElement('p');
        startP.innerHTML =
          '<strong>Started:</strong> ' + formatDateTime(entry.startTime);
        row.appendChild(startP);
        // Elapsed time
        const elapsedP = document.createElement('p');
        elapsedP.innerHTML = '<strong>Elapsed:</strong> ';
        const elapsedSpan = document.createElement('span');
        elapsedSpan.id = 'runningElapsed-' + entry.id;
        elapsedSpan.textContent = '';
        elapsedP.appendChild(elapsedSpan);
        row.appendChild(elapsedP);
        // Factor display (e.g. 100%, 75%)
        const factorP = document.createElement('p');
        factorP.innerHTML = '<strong>Factor:</strong> ';
        const factorSpan = document.createElement('span');
        factorSpan.id = 'runningFactor-' + entry.id;
        factorSpan.textContent = '';
        factorP.appendChild(factorSpan);
        row.appendChild(factorP);
        // Factor override selector. Allows the user to override the concurrency factor
        const overrideP = document.createElement('p');
        overrideP.innerHTML = '<strong>Override:</strong> ';
        const factorSelect = document.createElement('select');
        factorSelect.style.marginLeft = '0.25rem';
        // Default option for automatic concurrency (no override)
        const optDef = document.createElement('option');
        optDef.value = '';
        optDef.textContent = 'Auto';
        factorSelect.appendChild(optDef);
        appendFocusFactorOptions(factorSelect);
        // Set current selection based on manualFactor
        if (entry.manualFactor) {
          factorSelect.value = String(entry.manualFactor);
        } else {
          factorSelect.value = '';
        }
        factorSelect.addEventListener('change', () => {
          const v = factorSelect.value;
          // Before changing the factor, accumulate time elapsed since last update
          const now = new Date();
          const lastUpdate = entry.lastUpdateTime
            ? new Date(entry.lastUpdateTime)
            : new Date(entry.startTime);
          const elapsedSec = (now - lastUpdate) / 1000;
          // Use current factor (manual override or concurrency) to update effective seconds
          const currentFactor =
            entry.factor ||
            computeConcurrencyFactor(getRunningEntries().length);
          entry.effectiveSeconds =
            (entry.effectiveSeconds || 0) + elapsedSec * currentFactor;
          // Update last update timestamp to now
          entry.lastUpdateTime = now.toISOString();
          // Apply new override or restore automatic factor
          if (!v) {
            // Remove override: restore concurrency factor based on current running count
            entry.manualFactor = null;
            const count = getRunningEntries().length;
            entry.factor = computeConcurrencyFactor(count);
            entry.focusFactor = entry.factor;
          } else {
            const fVal = parseFloat(v);
            entry.manualFactor = fVal;
            entry.factor = fVal;
            entry.focusFactor = fVal;
          }
          saveData();
          // Refresh the timer section to apply the new factor
          updateTimerSection();
          // Recompute focus blocker activation in case total factor changed
          updateFocusBlocker();
        });
        overrideP.appendChild(factorSelect);
        row.appendChild(overrideP);
        // Earned display
        const earnP = document.createElement('p');
        earnP.innerHTML = '<strong>Earned:</strong> ';
        const earnSpan = document.createElement('span');
        earnSpan.id = 'runningEarned-' + entry.id;
        earnSpan.textContent = '';
        earnP.appendChild(earnSpan);
        row.appendChild(earnP);
        // Nudge controls: allow the user to adjust elapsed time in 5 minute increments
        const nudgeDiv = document.createElement('div');
        nudgeDiv.style.display = 'flex';
        nudgeDiv.style.gap = '0.25rem';
        // Minus 5 minutes button
        const minusBtn = document.createElement('button');
        minusBtn.className = 'btn secondary';
        minusBtn.textContent = '-5m';
        minusBtn.style.padding = '0.25rem 0.5rem';
        minusBtn.style.fontSize = '0.75rem';
        minusBtn.addEventListener('click', () => {
          // Compute elapsed time since last update and update effective seconds first
          const now = new Date();
          const lastUpdate = entry.lastUpdateTime
            ? new Date(entry.lastUpdateTime)
            : new Date(entry.startTime);
          const elapsedSec = (now - lastUpdate) / 1000;
          // Use current factor (manual override or concurrency) to update effective seconds
          const currentFactor =
            entry.manualFactor != null
              ? entry.manualFactor
              : entry.factor ||
                computeConcurrencyFactor(getRunningEntries().length);
          entry.effectiveSeconds =
            (entry.effectiveSeconds || 0) + elapsedSec * currentFactor;
          entry.lastUpdateTime = now.toISOString();
          // Subtract 5 minutes of actual time from effectiveSeconds taking into account factor
          const delta = 300 * currentFactor;
          entry.effectiveSeconds = Math.max(
            0,
            (entry.effectiveSeconds || 0) - delta
          );
          saveData();
          updateTimerSection();
          provideHaptic('beep');
        });
        nudgeDiv.appendChild(minusBtn);
        // Plus 5 minutes button
        const plusBtn = document.createElement('button');
        plusBtn.className = 'btn secondary';
        plusBtn.textContent = '+5m';
        plusBtn.style.padding = '0.25rem 0.5rem';
        plusBtn.style.fontSize = '0.75rem';
        plusBtn.addEventListener('click', () => {
          // Compute elapsed time since last update and update effective seconds first
          const now = new Date();
          const lastUpdate = entry.lastUpdateTime
            ? new Date(entry.lastUpdateTime)
            : new Date(entry.startTime);
          const elapsedSec = (now - lastUpdate) / 1000;
          const currentFactor =
            entry.manualFactor != null
              ? entry.manualFactor
              : entry.factor ||
                computeConcurrencyFactor(getRunningEntries().length);
          entry.effectiveSeconds =
            (entry.effectiveSeconds || 0) + elapsedSec * currentFactor;
          entry.lastUpdateTime = now.toISOString();
          // Add 5 minutes of actual time to effectiveSeconds, scaled by factor
          const delta = 300 * currentFactor;
          entry.effectiveSeconds = (entry.effectiveSeconds || 0) + delta;
          saveData();
          updateTimerSection();
          provideHaptic('beep');
        });
        nudgeDiv.appendChild(plusBtn);
        row.appendChild(nudgeDiv);
        // Stop button
        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn danger';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => {
          stopSingleTimer(entry.id);
        });
        row.appendChild(stopBtn);
        runningDiv.appendChild(row);
      });
      // Start an interval that updates all running timers every second
      const statsSnapshot = computeGlobalStats();
      const dailyTargetHours = Math.max(
        0,
        Number(statsSnapshot.dailyTarget) || 0
      );
      const completedTodayHours = Math.max(
        0,
        Number(statsSnapshot.todayHours) || 0
      );
      const tick = () => {
        const now = new Date();
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate()
        );
        let totalEarned = 0;
        let totalElapsedSeconds = 0;
        let totalFactor = 0;
        let runningTodayEffectiveSeconds = 0;
        runningEntries.forEach((entry) => {
          // Compute effective elapsed time: accumulate effectiveSeconds plus time since last update times current factor
          const last = entry.lastUpdateTime
            ? new Date(entry.lastUpdateTime)
            : new Date(entry.startTime);
          const prev = entry.effectiveSeconds || 0;
          const factor =
            entry.factor || computeConcurrencyFactor(runningEntries.length);
          const extra = ((now - last) / 1000) * factor;
          const effective = prev + extra;
          totalElapsedSeconds += effective;
          totalFactor += factor;
          // For "Time Left Today", estimate only today's contribution from running timers.
          const entryStart = new Date(entry.startTime);
          if (entryStart >= todayStart) {
            runningTodayEffectiveSeconds += effective;
          } else if (last >= todayStart) {
            runningTodayEffectiveSeconds += extra;
          } else if (todayStart < now) {
            runningTodayEffectiveSeconds +=
              ((now - todayStart) / 1000) * factor;
          }
          // Update elapsed display
          const elapsedSpan = document.getElementById(
            'runningElapsed-' + entry.id
          );
          if (elapsedSpan)
            elapsedSpan.textContent = formatDuration(Math.floor(effective));
          // Update factor display as percentage
          const factorSpan = document.getElementById(
            'runningFactor-' + entry.id
          );
          if (factorSpan)
            factorSpan.textContent = Math.round(factor * 100) + '%';
          // Compute earned amount for this entry based on the project hourly rate
          const project = data.projects.find((p) => p.id === entry.projectId);
          let earned = 0;
          if (project) {
            earned = (effective / 3600) * (project.hourlyRate || 0);
          }
          const earnSpan = document.getElementById('runningEarned-' + entry.id);
          if (earnSpan) earnSpan.textContent = formatCurrency(earned, 0);
          totalEarned += earned;
        });
        // Update total earned across all running timers
        const totalSpan = document.getElementById('runningTotalEarned');
        if (totalSpan) totalSpan.textContent = formatCurrency(totalEarned, 0);
        const totalElapsedSpan = document.getElementById('runningTotalElapsed');
        if (totalElapsedSpan)
          totalElapsedSpan.textContent = formatDuration(
            Math.floor(totalElapsedSeconds)
          );
        const todayProgressHours =
          completedTodayHours + runningTodayEffectiveSeconds / 3600;
        const remainingGoalHours = Math.max(
          0,
          dailyTargetHours - todayProgressHours
        );
        const secondsLeft =
          totalFactor > 0
            ? Math.ceil((remainingGoalHours / totalFactor) * 3600)
            : 0;
        const timeLeftTodaySpan = document.getElementById(
          'runningTimeLeftToday'
        );
        if (timeLeftTodaySpan)
          timeLeftTodaySpan.textContent = formatDuration(secondsLeft);
        const totalFactorSpan = document.getElementById('runningTotalFactor');
        if (totalFactorSpan)
          totalFactorSpan.textContent = Math.round(totalFactor * 100) + '%';
      };
      tick();
      timerInterval = setInterval(tick, 1000);
    } else {
      // No running entries: hide running timer section and show start form
      runningDiv.style.display = 'none';
      runningDiv.innerHTML = '';
      startDiv.style.display = '';
    }
    // update project selects
    updateProjectSelects();
  }

  // Stop a single running timer by id
  function stopSingleTimer(entryId) {
    const toStop = data.entries.find((e) => e.id === entryId && e.isRunning);
    // Provide tactile feedback when stopping a timer
    provideHaptic('long');
    if (!toStop) return;
    const now = new Date();
    // Gather all running entries including the one to stop
    const runningEntries = getRunningEntries();
    const n = runningEntries.length;
    // First update effective seconds for all running entries using their current factor
    runningEntries.forEach((e) => {
      const last = e.lastUpdateTime
        ? new Date(e.lastUpdateTime)
        : new Date(e.startTime);
      const elapsedSec = (now - last) / 1000;
      const prevFactor = e.factor || computeConcurrencyFactor(n);
      e.effectiveSeconds = (e.effectiveSeconds || 0) + elapsedSec * prevFactor;
      e.lastUpdateTime = now.toISOString();
    });
    // Finalize the stopped entry
    const finalSeconds = toStop.effectiveSeconds || 0;
    toStop.endTime = now.toISOString();
    toStop.duration = Math.floor(finalSeconds);
    toStop.isRunning = false;
    toStop.focusFactor = getEntryFocusFactor(toStop, n);
    // Cleanup weighted fields (optional)
    delete toStop.effectiveSeconds;
    delete toStop.lastUpdateTime;
    delete toStop.factor;
    // Compute new concurrency factor for remaining running timers after removal
    const remaining = runningEntries.filter((e) => e.id !== entryId);
    const newCount = remaining.length;
    const newFactor = computeConcurrencyFactor(newCount);
    // Update remaining running entries: assign new factor only if no manual override
    remaining.forEach((e) => {
      if (!e.manualFactor) {
        e.factor = newFactor;
        e.focusFactor = newFactor;
      }
      e.lastUpdateTime = now.toISOString();
    });
    // Persist and refresh
    saveData();
    updateTimerSection();
    updateDashboard();
    updateEntriesTable();
    // Do not immediately save backup here; periodic auto‑sync will handle exporting
    // Recompute focus blocker activation after stopping this timer. If the total
    // factor has dropped below or equal to 50%, the blocker will be disabled.
    updateFocusBlocker();
  }
  let timerInterval = null;
  // Chart instances for weekly and monthly scatter plots
  let weeklyScatterChart = null;
  let monthlyScatterChart = null;
  function startProjectTimer(
    projectId,
    { initialHours = 0, overrideFactor = null, resetStartControls = false } = {}
  ) {
    if (!projectId) return;
    // Check if there's already a running timer for this project
    const runningEntries = getRunningEntries();
    // Prevent starting multiple timers for the same project. Compare string representations of IDs to avoid mismatches.
    if (runningEntries.some((e) => String(e.projectId) === String(projectId))) {
      alert(
        'A timer is already running for this project. You cannot start another timer for the same project.'
      );
      return;
    }
    // No immediate focus start here; activation of focus mode will be handled
    // by updateFocusBlocker() based on the total factor of running timers.

    // Provide tactile feedback when starting a timer
    provideHaptic('long');
    const now = new Date();
    const parsedOverride =
      overrideFactor === null || overrideFactor === ''
        ? null
        : Number(overrideFactor);
    const hasOverride =
      Number.isFinite(parsedOverride) && Number(parsedOverride) > 0;
    // Compute the new concurrency count including the new entry
    const newConcurrencyCount = runningEntries.length + 1;
    // Compute the concurrency factor that would apply if no override is used
    const autoFactor = computeConcurrencyFactor(newConcurrencyCount);
    // Update all existing running entries: accumulate effective seconds and set new factor
    runningEntries.forEach((e) => {
      const last = e.lastUpdateTime
        ? new Date(e.lastUpdateTime)
        : new Date(e.startTime);
      const elapsedSec = (now - last) / 1000;
      const prevFactor =
        e.factor || computeConcurrencyFactor(runningEntries.length);
      e.effectiveSeconds = (e.effectiveSeconds || 0) + elapsedSec * prevFactor;
      e.lastUpdateTime = now.toISOString();
      // For timers without manual override, assign the new concurrency factor
      if (!e.manualFactor) {
        e.factor = autoFactor;
        e.focusFactor = autoFactor;
      }
    });
    // Create new entry for the selected project
    const realStart = new Date(now.getTime() - initialHours * 3600 * 1000);
    // Determine the factor for the new entry: manual override or auto
    let newEntryFactor;
    let newEntryManual = null;
    if (hasOverride) {
      newEntryFactor = parsedOverride;
      newEntryManual = newEntryFactor;
    } else {
      newEntryFactor = autoFactor;
      newEntryManual = null;
    }
    const newEntry = {
      id: uuid(),
      projectId,
      description: '',
      startTime: realStart.toISOString(),
      endTime: null,
      duration: null,
      isRunning: true,
      createdAt: now.toISOString(),
      effectiveSeconds: initialHours * 3600,
      lastUpdateTime: now.toISOString(),
      factor: newEntryFactor,
      focusFactor: newEntryFactor,
      manualFactor: newEntryManual
    };
    data.entries.push(newEntry);
    if (resetStartControls) {
      // Reset initial input and focus factor selection
      document.getElementById('timerInitialPro').value = '';
      document.getElementById('startFactorPro').value = '';
    }
    saveData();
    // Update UI and timers
    updateProjectSelects();
    updateTimerSection();
    updateDashboard();
    // After adding the new entry, update the focus blocker based on the new total factor
    updateFocusBlocker();
    return true;
  }

  document.getElementById('startTimerBtnPro').addEventListener('click', () => {
    const projectId = document.getElementById('timerProjectPro').value;
    // Hours already spent when starting the timer (pre-filled time)
    const initialHours =
      parseFloat(document.getElementById('timerInitialPro').value) || 0;
    const overrideFactor = document.getElementById('startFactorPro').value;
    startProjectTimer(projectId, {
      initialHours,
      overrideFactor,
      resetStartControls: true
    });
  });
  document.getElementById('stopTimerBtnPro').addEventListener('click', () => {
    stopAllTimers();
  });

  // Stop all running timers at once, updating their weighted durations consistently
  function stopAllTimers() {
    const runningList = getRunningEntries();
    if (runningList.length === 0) return;
    const now = new Date();
    const n = runningList.length;
    // Update effective seconds for all entries using their current factors
    runningList.forEach((e) => {
      const last = e.lastUpdateTime
        ? new Date(e.lastUpdateTime)
        : new Date(e.startTime);
      const elapsedSec = (now - last) / 1000;
      const prevFactor = e.factor || computeConcurrencyFactor(n);
      e.effectiveSeconds = (e.effectiveSeconds || 0) + elapsedSec * prevFactor;
      e.lastUpdateTime = now.toISOString();
    });
    // Finalize each entry: set duration, endTime, isRunning
    runningList.forEach((e) => {
      // Compute raw duration in seconds
      let rawDuration = Math.floor(e.effectiveSeconds || 0);
      // Apply rounding based on project rounding preference
      const projR = data.projects.find(
        (p) => String(p.id) === String(e.projectId)
      );
      if (projR && projR.roundingMinutes && projR.roundingMinutes > 0) {
        const rounding = projR.roundingMinutes;
        const minutes = rawDuration / 60;
        const roundedMinutes = Math.round(minutes / rounding) * rounding;
        rawDuration = Math.floor(roundedMinutes * 60);
      }
      e.duration = rawDuration;
      e.endTime = now.toISOString();
      e.isRunning = false;
      e.focusFactor = getEntryFocusFactor(e, n);
      delete e.effectiveSeconds;
      delete e.lastUpdateTime;
      delete e.factor;
    });
    saveData();
    updateTimerSection();
    updateDashboard();
    updateEntriesTable();
    // Do not immediately save backup here; periodic auto‑sync will handle exporting
    // After stopping all timers, recompute focus blocker activation based on total factor
    updateFocusBlocker();
  }

  // Update project selects for timer and manual forms
  function updateProjectSelects() {
    const timerSelect = document.getElementById('timerProjectPro');
    const manualSelect = document.getElementById('manualProjectPro');
    const entryFilterSelect = document.getElementById('entryProjectFilter');
    const startBtn = document.getElementById('startTimerBtnPro');
    timerSelect.innerHTML = '';
    manualSelect.innerHTML = '';
    if (entryFilterSelect) {
      const selectedFilter = entryProjectFilter || entryFilterSelect.value;
      entryFilterSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All projects';
      entryFilterSelect.appendChild(allOption);
      entryProjectFilter = selectedFilter;
    }
    if (data.projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '-- no projects --';
      timerSelect.appendChild(opt);
      manualSelect.appendChild(opt.cloneNode(true));
      if (entryFilterSelect) {
        entryProjectFilter = '';
        entryFilterSelect.value = '';
      }
      startBtn.disabled = true;
      renderTimerHints(timerSelect, null, new Map(), new Set());
      return;
    }
    // Never recommend (or auto-select) a project that already has a running timer,
    // since we prevent starting the same timer twice.
    const runningProjectIds = new Set(
      getRunningEntries().map((e) => String(e.projectId))
    );
    const weekContext = getCurrentWeekPlanningContext();
    const projectOptionData = data.projects.map((project, index) => {
      const stats = computeProjectStats(project);
      const dailyPlan = getProjectDailyPlan(project, stats, weekContext);
      return { project, stats, dailyPlan, index };
    });
    const dailyPlanByProjectId = new Map(
      projectOptionData.map((item) => [String(item.project.id), item.dailyPlan])
    );
    const recommendedEntry = getRecommendedProjectEntry(
      projectOptionData,
      dailyPlanByProjectId
    );
    const sortedProjects = projectOptionData
      .slice()
      .sort((a, b) => {
        const remainingDiff =
          b.dailyPlan.remainingToday - a.dailyPlan.remainingToday;
        if (Math.abs(remainingDiff) > 0.01) return remainingDiff;
        const weeklyDiff =
          b.dailyPlan.weeklyRemaining - a.dailyPlan.weeklyRemaining;
        if (Math.abs(weeklyDiff) > 0.01) return weeklyDiff;
        return a.index - b.index;
      })
      .map((item) => item.project);

    // Choose a startable recommendation only when a project still needs hours today.
    let recommendedForTimerId = null;
    if (
      recommendedEntry &&
      !runningProjectIds.has(String(recommendedEntry.project.id))
    ) {
      recommendedForTimerId = recommendedEntry.project.id;
    } else if (
      currentRecommendedMonthlyId &&
      !runningProjectIds.has(String(currentRecommendedMonthlyId)) &&
      (dailyPlanByProjectId.get(String(currentRecommendedMonthlyId))
        ?.remainingToday || 0) > 0
    ) {
      recommendedForTimerId = currentRecommendedMonthlyId;
    } else {
      recommendedForTimerId = null;
    }
    if (recommendedForTimerId) {
      const idx = sortedProjects.findIndex(
        (p) => String(p.id) === String(recommendedForTimerId)
      );
      if (idx > 0) {
        const [recProj] = sortedProjects.splice(idx, 1);
        sortedProjects.unshift(recProj);
      }
    }

    sortedProjects.forEach((project) => {
      // First option for timer select with possible recommendation hint
      const o1 = document.createElement('option');
      o1.value = project.id;
      let label = project.name;
      // If this project is the recommended project, append a hint about today's remaining hours.
      if (
        recommendedForTimerId &&
        String(project.id) === String(recommendedForTimerId)
      ) {
        try {
          const dailyPlan = dailyPlanByProjectId.get(String(project.id));
          label +=
            ' (Recommended, needs ~' +
            formatRecommendationHours(dailyPlan?.remainingToday) +
            'h today)';
        } catch (err) {
          label += ' (Recommended)';
        }
      }
      o1.textContent = label;
      timerSelect.appendChild(o1);
      // Second option for manual entry select (no recommendation hint)
      const o2 = document.createElement('option');
      o2.value = project.id;
      o2.textContent = project.name;
      manualSelect.appendChild(o2);
      if (entryFilterSelect) {
        const o3 = document.createElement('option');
        o3.value = project.id;
        o3.textContent = project.name;
        entryFilterSelect.appendChild(o3);
      }
    });
    if (entryFilterSelect) {
      const filterStillExists = data.projects.some(
        (p) => String(p.id) === String(entryProjectFilter)
      );
      if (entryProjectFilter && !filterStillExists) {
        entryProjectFilter = '';
      }
      entryFilterSelect.value = entryProjectFilter;
    }
    // Disable timer options for projects that already have a running timer
    timerSelect.querySelectorAll('option').forEach((opt) => {
      opt.disabled = runningProjectIds.has(String(opt.value));
    });

    // If the current selection is not startable, pick the first startable option.
    const selectedOpt =
      timerSelect.selectedOptions && timerSelect.selectedOptions.length > 0
        ? timerSelect.selectedOptions[0]
        : null;
    if (!selectedOpt || selectedOpt.disabled) {
      const firstEnabled = Array.from(timerSelect.options).find(
        (o) => o.value && !o.disabled
      );
      if (firstEnabled) timerSelect.value = firstEnabled.value;
    }
    const hasStartable = Array.from(timerSelect.options).some(
      (o) => o.value && !o.disabled
    );
    startBtn.disabled = !hasStartable;
    renderTimerHints(
      timerSelect,
      recommendedForTimerId,
      dailyPlanByProjectId,
      runningProjectIds
    );
  }

  function renderTimerHints(
    timerSelect,
    recommendedForTimerId,
    dailyPlanByProjectId,
    runningProjectIds
  ) {
    const recommendationEl = document.getElementById('timerRecommendationPro');
    if (recommendationEl) {
      const recommendedProject = data.projects.find(
        (project) => String(project.id) === String(recommendedForTimerId)
      );
      if (recommendedProject) {
        const dailyPlan = dailyPlanByProjectId.get(
          String(recommendedProject.id)
        );
        recommendationEl.textContent =
          'Recommended: ' +
          recommendedProject.name +
          ' - ' +
          formatRecommendationHours(dailyPlan?.remainingToday) +
          'h left today';
        recommendationEl.style.display = '';
      } else {
        recommendationEl.textContent = '';
        recommendationEl.style.display = 'none';
      }
    }

    const recentEl = document.getElementById('recentTimersPro');
    if (!recentEl) return;
    recentEl.innerHTML = '';
    const recentTimers = [];
    const seen = new Set();
    data.entries
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.createdAt || a.startTime || 0).getTime();
        const bTime = new Date(b.createdAt || b.startTime || 0).getTime();
        return bTime - aTime;
      })
      .forEach((entry) => {
        if (seen.has(String(entry.projectId))) return;
        const project = data.projects.find(
          (p) => String(p.id) === String(entry.projectId)
        );
        if (!project || runningProjectIds.has(String(project.id))) return;
        seen.add(String(project.id));
        recentTimers.push({
          project,
          focusFactor: getEntryFocusFactor(entry, 1)
        });
      });

    const startableRecent = recentTimers.slice(0, 4);
    if (!startableRecent.length) {
      recentEl.style.display = 'none';
      return;
    }

    recentEl.style.display = '';
    const label = document.createElement('div');
    label.className = 'timer-hint-label';
    label.textContent = 'Recent timers';
    recentEl.appendChild(label);
    const row = document.createElement('div');
    row.className = 'timer-chip-row';
    startableRecent.forEach(({ project, focusFactor }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'timer-chip';
      button.textContent =
        project.name + ' - ' + formatFocusPercent(focusFactor);
      button.title =
        'Start ' + project.name + ' at ' + formatFocusPercent(focusFactor);
      button.addEventListener('click', () => {
        timerSelect.value = project.id;
        startProjectTimer(project.id, { overrideFactor: focusFactor });
      });
      row.appendChild(button);
    });
    recentEl.appendChild(row);
  }

  // Manual entry add/cancel
  document
    .getElementById('addManualEntryBtnPro')
    .addEventListener('click', () => {
      document.getElementById('manualEntryFormPro').classList.remove('hidden');
    });
  document
    .getElementById('cancelManualBtnPro')
    .addEventListener('click', () => {
      document.getElementById('manualEntryFormPro').classList.add('hidden');
      document.getElementById('manualFormPro').reset();
    });
  document.getElementById('manualFormPro').addEventListener('submit', (e) => {
    e.preventDefault();
    const projectId = document.getElementById('manualProjectPro').value;
    const description = document
      .getElementById('manualDescriptionPro')
      .value.trim();
    const hoursVal = parseFloat(
      document.getElementById('manualHoursPro').value
    );
    if (!projectId || isNaN(hoursVal) || hoursVal <= 0) return;
    const now = new Date();
    // Apply rounding based on project preferences. If the project specifies a rounding interval (minutes),
    // we round the hours to the nearest interval before converting to seconds.
    let adjustedHours = hoursVal;
    const projForRound = data.projects.find(
      (p) => String(p.id) === String(projectId)
    );
    if (
      projForRound &&
      projForRound.roundingMinutes &&
      projForRound.roundingMinutes > 0
    ) {
      const rounding = projForRound.roundingMinutes;
      const minutesVal = hoursVal * 60;
      const roundedMinutes = Math.round(minutesVal / rounding) * rounding;
      adjustedHours = roundedMinutes / 60;
    }
    const durationSeconds = Math.floor(adjustedHours * 3600);
    // start time is computed as end time minus duration
    const startTime = new Date(now.getTime() - durationSeconds * 1000);
    const newEntry = {
      id: uuid(),
      projectId,
      description,
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
      duration: durationSeconds,
      isRunning: false,
      createdAt: now.toISOString()
    };
    data.entries.push(newEntry);
    saveData();
    e.target.reset();
    document.getElementById('manualEntryFormPro').classList.add('hidden');
    updateEntriesTable();
    updateDashboard();
    updateProjectsPage();
  });

  // Toggle between showing all entries and only recent entries (last 30 days). When
  // showing only recent entries, the button text reads "Show All". When
  // showing all entries, it reads "Show Recent". Clicking the button
  // toggles the view and re-renders the entries table.
  const toggleEntriesBtn = document.getElementById('toggleEntriesViewBtn');
  function updateEntriesViewToggleLabel() {
    if (!toggleEntriesBtn) return;
    toggleEntriesBtn.textContent = showAllEntries ? 'Show Recent' : 'Show All';
  }
  if (toggleEntriesBtn) {
    updateEntriesViewToggleLabel();
    toggleEntriesBtn.addEventListener('click', () => {
      showAllEntries = !showAllEntries;
      updateEntriesViewToggleLabel();
      updateEntriesTable();
    });
  }
  const entryProjectFilterSelect =
    document.getElementById('entryProjectFilter');
  if (entryProjectFilterSelect) {
    entryProjectFilterSelect.addEventListener('change', () => {
      entryProjectFilter = entryProjectFilterSelect.value || '';
      updateEntriesTable();
    });
  }
  const entrySearchInput = document.getElementById('entrySearchInput');
  if (entrySearchInput) {
    entrySearchInput.addEventListener('input', () => {
      entrySearchQuery = entrySearchInput.value.trim().toLowerCase();
      updateEntriesTable();
    });
  }

  // Nudge buttons for manual entry: adjust hours by ±5 minutes
  const minusBtn = document.getElementById('manualMinus5Btn');
  const plusBtn = document.getElementById('manualPlus5Btn');
  if (minusBtn && plusBtn) {
    minusBtn.addEventListener('click', () => {
      // Provide a short beep when nudging entry time
      provideHaptic('beep');
      const hoursInput = document.getElementById('manualHoursPro');
      let current = parseFloat(hoursInput.value) || 0;
      current -= 5 / 60;
      if (current < 0) current = 0;
      hoursInput.value = current.toFixed(2);
    });
    plusBtn.addEventListener('click', () => {
      provideHaptic('beep');
      const hoursInput = document.getElementById('manualHoursPro');
      let current = parseFloat(hoursInput.value) || 0;
      current += 5 / 60;
      hoursInput.value = current.toFixed(2);
    });
  }

  // Delete entry
  function deleteEntry(id) {
    data.entries = data.entries.filter((e) => e.id !== id);
    saveData();
    updateEntriesTable();
    updateDashboard();
    updateProjectsPage();
  }

  function getEntryProject(entry) {
    return (
      data.projects.find((p) => String(p.id) === String(entry.projectId)) ||
      null
    );
  }

  function getEntriesForCurrentView() {
    let entriesToShow = data.entries;
    if (!showAllEntries) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      entriesToShow = entriesToShow.filter((entry) => {
        const startDate = new Date(entry.startTime);
        const endDate = entry.endTime ? new Date(entry.endTime) : startDate;
        return startDate >= cutoff || endDate >= cutoff;
      });
    }
    if (entryProjectFilter) {
      entriesToShow = entriesToShow.filter(
        (entry) => String(entry.projectId) === String(entryProjectFilter)
      );
    }
    if (entrySearchQuery) {
      entriesToShow = entriesToShow.filter((entry) => {
        const project = getEntryProject(entry);
        const searchable = [
          project ? project.name : '',
          project ? project.client : '',
          entry.description || ''
        ]
          .join(' ')
          .toLowerCase();
        return searchable.includes(entrySearchQuery);
      });
    }
    return entriesToShow;
  }

  function renderEntrySummary(entriesToShow) {
    const summaryEl = document.getElementById('entrySummaryPro');
    if (!summaryEl) return;
    summaryEl.innerHTML = '';
    const totalHours = entriesToShow.reduce(
      (sum, entry) => sum + ((entry.duration || 0) / 3600 || 0),
      0
    );
    const totalEarned = entriesToShow.reduce((sum, entry) => {
      const project = getEntryProject(entry);
      const hours = (entry.duration || 0) / 3600 || 0;
      return sum + (project ? hours * (Number(project.hourlyRate) || 0) : 0);
    }, 0);
    const scopeText = showAllEntries ? 'All time' : 'Last 30 days';
    const labels = [
      `${entriesToShow.length} ${entriesToShow.length === 1 ? 'entry' : 'entries'}`,
      `${formatDuration(Math.round(totalHours * 3600))} tracked`,
      `${formatCurrency(totalEarned)} billable`,
      scopeText
    ];
    labels.forEach((label) => {
      const pill = document.createElement('span');
      pill.className = 'entry-summary-pill';
      pill.textContent = label;
      summaryEl.appendChild(pill);
    });
  }

  function appendEntryCell(row, label, value) {
    const cell = document.createElement('td');
    cell.dataset.label = label;
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  }

  // Entries table
  function updateEntriesTable() {
    const tbody = document.getElementById('entriesTableBodyPro');
    tbody.innerHTML = '';
    const entriesToShow = getEntriesForCurrentView();
    renderEntrySummary(entriesToShow);
    if (data.entries.length === 0 || entriesToShow.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent =
        data.entries.length === 0
          ? 'No entries yet.'
          : 'No entries match the current filters.';
      td.style.textAlign = 'center';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    // sort by start time desc
    const sorted = [...entriesToShow].sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime)
    );
    sorted.forEach((entry) => {
      const tr = document.createElement('tr');
      const project = getEntryProject(entry);
      const hours = entry.duration ? entry.duration / 3600 : 0;
      const total = project ? hours * project.hourlyRate : 0;
      appendEntryCell(tr, 'Project', project ? project.name : '');
      appendEntryCell(tr, 'Description', entry.description || '');
      appendEntryCell(tr, 'Start', formatDateTime(entry.startTime));
      appendEntryCell(
        tr,
        'End',
        entry.endTime
          ? formatDateTime(entry.endTime)
          : entry.isRunning
            ? '-'
            : ''
      );
      appendEntryCell(
        tr,
        'Duration',
        entry.duration
          ? formatDuration(entry.duration)
          : entry.isRunning
            ? 'Running...'
            : ''
      );
      appendEntryCell(tr, 'Total', formatCurrency(total));
      const actionsTd = appendEntryCell(tr, 'Actions', '');
      // Action cell: add nudge and snap controls plus delete button
      actionsTd.className = 'entry-actions';
      // −5m button
      const minusBtn = document.createElement('button');
      minusBtn.className = 'btn secondary';
      minusBtn.style.padding = '0.25rem 0.5rem';
      minusBtn.style.fontSize = '0.7rem';
      minusBtn.textContent = '−5m';
      minusBtn.addEventListener('click', () => {
        // Provide quick beep feedback
        provideHaptic('beep');
        // Subtract 5 minutes (300 seconds) from the entry duration
        let newDur = (entry.duration || 0) - 300;
        if (newDur < 0) newDur = 0;
        entry.duration = newDur;
        // Update endTime based on new duration
        const start = new Date(entry.startTime);
        entry.endTime = new Date(start.getTime() + newDur * 1000).toISOString();
        saveData();
        updateEntriesTable();
        updateDashboard();
        updateProjectsPage();
        updateTimerSection();
      });
      actionsTd.appendChild(minusBtn);
      // +5m button
      const plusBtn = document.createElement('button');
      plusBtn.className = 'btn secondary';
      plusBtn.style.padding = '0.25rem 0.5rem';
      plusBtn.style.fontSize = '0.7rem';
      plusBtn.style.marginLeft = '0.25rem';
      plusBtn.textContent = '+5m';
      plusBtn.addEventListener('click', () => {
        provideHaptic('beep');
        // Add 5 minutes to the duration
        let newDur = (entry.duration || 0) + 300;
        entry.duration = newDur;
        const start = new Date(entry.startTime);
        entry.endTime = new Date(start.getTime() + newDur * 1000).toISOString();
        saveData();
        updateEntriesTable();
        updateDashboard();
        updateProjectsPage();
        updateTimerSection();
      });
      actionsTd.appendChild(plusBtn);
      // Snap selector: choose nearest minutes (5,10,15)
      const snapSelect = document.createElement('select');
      snapSelect.style.marginLeft = '0.25rem';
      snapSelect.style.padding = '0.25rem';
      snapSelect.style.fontSize = '0.7rem';
      snapSelect.style.border = '1px solid #cbd5e1';
      snapSelect.style.borderRadius = '0.375rem';
      // Placeholder option
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = 'Snap';
      snapSelect.appendChild(placeholderOption);
      [5, 10, 15].forEach((mins) => {
        const opt = document.createElement('option');
        opt.value = String(mins);
        opt.textContent = mins + 'm';
        snapSelect.appendChild(opt);
      });
      snapSelect.addEventListener('change', () => {
        const val = parseInt(snapSelect.value);
        if (!isNaN(val) && val > 0) {
          const minutes = (entry.duration || 0) / 60;
          const snappedMinutes = Math.round(minutes / val) * val;
          entry.duration = Math.max(0, Math.floor(snappedMinutes * 60));
          const start = new Date(entry.startTime);
          entry.endTime = new Date(
            start.getTime() + entry.duration * 1000
          ).toISOString();
          saveData();
          updateEntriesTable();
          updateDashboard();
          updateProjectsPage();
          updateTimerSection();
        }
        // reset to placeholder
        snapSelect.value = '';
      });
      actionsTd.appendChild(snapSelect);
      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.style.padding = '0.25rem 0.5rem';
      delBtn.style.fontSize = '0.7rem';
      delBtn.style.marginLeft = '0.25rem';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        if (confirm('Delete this entry?')) deleteEntry(entry.id);
      });
      actionsTd.appendChild(delBtn);
      tbody.appendChild(tr);
    });
  }

  // Export / Import
  function applyImportedData(imported) {
    if (
      !imported ||
      !Array.isArray(imported.projects) ||
      !Array.isArray(imported.entries)
    ) {
      throw new Error('Invalid data format');
    }
    const previousBackupDirName = data.backupDirName || null;
    const previousLastBackupAt = data.lastBackupAt || null;
    data = imported;
    if (!data.backupDirName && previousBackupDirName) {
      data.backupDirName = previousBackupDirName;
    }
    if (!data.lastBackupAt && previousLastBackupAt) {
      data.lastBackupAt = previousLastBackupAt;
    }
    // Remove transient timer fields from imported entries.
    data.entries.forEach((entry) => {
      delete entry.effectiveSeconds;
      delete entry.lastUpdateTime;
      delete entry.factor;
    });
    let colorChanged = false;
    data.projects.forEach((p) => {
      if (!p.color) {
        p.color = getUniqueColor();
        colorChanged = true;
      }
    });
    saveData();
    if (colorChanged) {
      persistDataToLocalStorage();
    }
    updateDashboard();
    updateProjectsPage();
    updateEntriesTable();
    updateTimerSection();
  }

  async function restoreLatestBackupFromDir() {
    try {
      if (!backupDirHandle) {
        backupWarningMessage =
          'Choose a backup folder before restoring from backup.';
        updateAutoSyncStatus();
        return false;
      }
      const permissionGranted =
        await ensureBackupPermissionWithPrompt(backupDirHandle);
      if (!permissionGranted) {
        backupWarningMessage =
          'Permission to access the backup folder was not granted.';
        updateAutoSyncStatus();
        return false;
      }
      const text = await readTextFile(backupDirHandle, BACKUP_LATEST_FILENAME);
      const imported = JSON.parse(text);
      if (
        !confirm(
          'Restore the latest backup from the selected folder? This replaces the current local data.'
        )
      ) {
        return false;
      }
      applyImportedData(imported);
      alert('Latest backup restored successfully.');
      return true;
    } catch (err) {
      console.error('Restore from backup failed:', err);
      backupWarningMessage =
        'Restore failed. Check that the backup folder contains timekeeper-data.json.';
      updateAutoSyncStatus();
      return false;
    }
  }

  document.getElementById('exportBtnPro').addEventListener('click', () => {
    // Use shared downloadData function for exports
    downloadData();
  });
  document
    .getElementById('importInputPro')
    .addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const imported = JSON.parse(text);
        applyImportedData(imported);
        alert('Data imported successfully');
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
    });

  // Initial render
  updateProjectSelects();
  updateEntriesTable();
  updateProjectsPage();
  updateDashboard();
  updateTimerSection();
  loadStravaFeed();
  // Programmatically activate the Timer tab on first load. This ensures the Timer
  // section is displayed instead of the Dashboard when the page is opened. We
  // simulate a click on the Timer navigation item which will trigger the
  // navigation handler to set the active class and hide/show sections.
  const timerNavItem = document.querySelector(
    '#navList li[data-section="timer"]'
  );
  if (timerNavItem) {
    timerNavItem.click();
  }

  // Initialize auto sync toggle and status message
  const autoSyncToggle = document.getElementById('autoSyncToggle');
  const autoSyncStatusElem = document.getElementById('autoSyncStatus');
  const autoSyncWarningElem = document.getElementById('autoSyncWarning');
  const lastBackupStatusElem = document.getElementById('lastBackupStatus');
  const chooseBtn = document.getElementById('chooseBackupDirBtn');
  const backupNowBtn = document.getElementById('backupNowBtn');
  const restoreBackupBtn = document.getElementById('restoreBackupBtn');
  function syncAutoSyncToggleUI() {
    if (!autoSyncToggle) return;
    const shouldCheck =
      autoSyncEnabled &&
      backupPermissionState === 'granted' &&
      !!backupDirHandle;
    if (autoSyncToggle.checked !== shouldCheck) {
      autoSyncToggle.checked = shouldCheck;
    }
  }
  function updateAutoSyncStatus() {
    if (!autoSyncStatusElem) return;
    syncAutoSyncToggleUI();
    const hasHandle = !!backupDirHandle;
    const backupName = hasHandle
      ? backupDirHandle.name || data.backupDirName || ''
      : (data && data.backupDirName) || '';
    const folderUsable = hasHandle && backupPermissionState === 'granted';
    if (backupNowBtn) {
      backupNowBtn.disabled = !folderUsable;
      backupNowBtn.title = folderUsable
        ? 'Write latest data, manifest, and a timestamped snapshot now.'
        : 'Select a backup folder first.';
    }
    if (restoreBackupBtn) {
      restoreBackupBtn.disabled = !folderUsable;
      restoreBackupBtn.title = folderUsable
        ? 'Restore timekeeper-data.json from the selected backup folder.'
        : 'Select a backup folder first.';
    }
    if (autoSyncEnabled && folderUsable) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is ON – syncing to “${backupName}”.`
        : 'Auto sync is ON – syncing to your backup folder.';
    } else if (
      autoSyncEnabled &&
      hasHandle &&
      backupPermissionState !== 'granted'
    ) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is ON but access to “${backupName}” must be re-authorized.`
        : 'Auto sync is ON but access to the backup folder must be re-authorized.';
    } else if (autoSyncEnabled) {
      autoSyncStatusElem.textContent =
        'Auto sync is ON but no backup folder is available.';
    } else if (!autoSyncEnabled && folderUsable) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is OFF – backup folder “${backupName}” is ready.`
        : 'Auto sync is OFF – backup folder is ready.';
    } else if (!autoSyncEnabled && hasHandle) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is OFF – allow access to “${backupName}” to resume.`
        : 'Auto sync is OFF – allow access to the backup folder to resume.';
    } else {
      autoSyncStatusElem.textContent =
        'Auto sync is OFF. No backup folder selected.';
    }
    if (autoSyncWarningElem) {
      let warning = backupWarningMessage;
      if (!warning) {
        if (!hasHandle) {
          warning = 'Select a backup folder to keep automatic backups running.';
        } else if (backupPermissionState === 'prompt') {
          warning = backupName
            ? `Grant TimeKeeper access to “${backupName}” to keep automatic backups running.`
            : 'Grant TimeKeeper access to your backup folder to keep automatic backups running.';
        }
      }
      if (warning) {
        autoSyncWarningElem.textContent = warning;
        autoSyncWarningElem.style.display = 'block';
      } else {
        autoSyncWarningElem.textContent = '';
        autoSyncWarningElem.style.display = 'none';
      }
    }
    if (lastBackupStatusElem) {
      if (data && data.lastBackupAt) {
        const relative = formatRelativeTime(data.lastBackupAt);
        const backupDate = new Date(data.lastBackupAt);
        if (!isNaN(backupDate)) {
          const snapshot = data.lastBackupSnapshotAt ? ' with snapshot' : '';
          lastBackupStatusElem.textContent = `Last backup: ${relative}${snapshot}`;
          lastBackupStatusElem.title = backupDate.toLocaleString();
          lastBackupStatusElem.style.display = 'block';
        } else {
          lastBackupStatusElem.textContent = '';
          lastBackupStatusElem.style.display = 'none';
        }
      } else if (autoSyncEnabled && folderUsable) {
        lastBackupStatusElem.textContent = 'Last backup: pending…';
        lastBackupStatusElem.title = '';
        lastBackupStatusElem.style.display = 'block';
      } else {
        lastBackupStatusElem.textContent = '';
        lastBackupStatusElem.style.display = 'none';
      }
    }
  }
  if (autoSyncToggle) {
    updateAutoSyncStatus();
    autoSyncToggle.addEventListener('change', async () => {
      if (autoSyncToggle.checked) {
        let ensured = true;
        if (!backupDirHandle) {
          ensured = await chooseBackupDir();
        } else {
          ensured = await ensureBackupPermissionWithPrompt(backupDirHandle);
        }
        if (!ensured || !backupDirHandle) {
          disableAutoSyncWithWarning(
            'Permission to the backup folder is required to enable auto sync.'
          );
          return;
        }
        autoSyncEnabled = true;
        localStorage.setItem('autoSyncEnabledPro', 'true');
        backupWarningMessage = '';
        updateAutoSyncStatus();
        await saveBackupToDir();
      } else {
        disableAutoSyncWithWarning(
          'Auto sync is OFF. Remember to back up manually.'
        );
      }
    });
  } else {
    updateAutoSyncStatus();
  }

  // Set Backup Folder button: prompts the user to pick a directory for backups. When
  // auto sync is enabled and no directory is selected, clicking this button
  // will call chooseBackupDir(). If auto sync is disabled, this button remains
  // functional to allow the user to preselect a folder before enabling auto sync.
  const fsAccessSupported = !!window.showDirectoryPicker;
  if (!fsAccessSupported) {
    if (autoSyncToggle) {
      autoSyncToggle.disabled = true;
      autoSyncToggle.title =
        'Auto sync requires a browser that supports folder access.';
    }
    if (chooseBtn) {
      chooseBtn.disabled = true;
      chooseBtn.title =
        'Auto sync requires a browser that supports folder access.';
    }
    if (backupNowBtn) {
      backupNowBtn.disabled = true;
      backupNowBtn.title =
        'Auto sync requires a browser that supports folder access.';
    }
    if (restoreBackupBtn) {
      restoreBackupBtn.disabled = true;
      restoreBackupBtn.title =
        'Auto sync requires a browser that supports folder access.';
    }
    backupWarningMessage =
      'Auto sync unavailable: your browser does not support choosing folders.';
    updateAutoSyncStatus();
  }
  if (chooseBtn) {
    chooseBtn.addEventListener('click', () => {
      chooseBackupDir({ activateSync: true });
    });
  }
  if (backupNowBtn) {
    backupNowBtn.addEventListener('click', async () => {
      const ok = await saveBackupToDir();
      if (ok) alert('Backup written successfully.');
    });
  }
  if (restoreBackupBtn) {
    restoreBackupBtn.addEventListener('click', () => {
      restoreLatestBackupFromDir();
    });
  }
})();
