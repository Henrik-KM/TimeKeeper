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
  getProjectPlannedHoursForPeriod,
  getProjectPlanningSnapshot,
  getProjectStartDate,
  getProjectWeeklyExpectedHours,
  getRollingWindowBounds,
  isProjectActive,
  isWeeklyPaceProject,
  maxDate,
  parseLocalDateString,
  startOfLocalDay,
  sumEntryHours
} from './shared/runtime-helpers.mjs';
import { uuid } from './shared/id.mjs';
import { openFormDialog, requestConfirm, showToast } from './shared/ui.mjs';
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
import { buildStravaPayloadFromCsv } from './features/strava/import.mjs';
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
  parseCustomIntensity,
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

  function parseWorkoutIntensityInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = normalizeIntensity(raw);
    if (['intense', 'medium', 'light'].includes(normalized)) {
      return normalized;
    }
    if (normalized.startsWith('custom:')) {
      const customValue = sanitizeCustomPoints(normalized.slice(7));
      return customValue === null ? null : makeCustomIntensity(customValue);
    }
    const customValue = sanitizeCustomPoints(raw);
    return customValue === null ? null : makeCustomIntensity(customValue);
  }

  function getWorkoutIntensityOptions(currentIntensity) {
    const normalized = normalizeIntensity(currentIntensity);
    const options = [
      { value: 'intense', label: 'Intense' },
      { value: 'medium', label: 'Medium' },
      { value: 'light', label: 'Light' }
    ];
    if (normalized.startsWith('custom:')) {
      const customPoints = parseCustomIntensity(normalized);
      options.push({
        value: normalized,
        label: `Custom (${formatCustomIntensityValue(customPoints)})`
      });
    }
    return options;
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

  function formatSek(value, decimals = -1) {
    return formatCurrency(value || 0, decimals).replace(' kr', ' SEK');
  }

  function getCurrentWeekBounds(now = new Date()) {
    const dayOfWeek = now.getDay();
    const diffToMon = (dayOfWeek + 6) % 7;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffToMon
    );
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { weekStart, weekEnd };
  }

  function getFinanceBudgetSnapshot(now = new Date()) {
    const groceries = Array.isArray(data.groceries) ? data.groceries : [];
    const recurringPayments = ensureMonthlyRecurringPayments();
    const recurringTotal = getMonthlyRecurringTotal(recurringPayments);
    const { weekStart, weekEnd } = getCurrentWeekBounds(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let startDate = parseLocalDateString(data.groceryBudgetStartDate);
    if (!startDate) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    startDate.setHours(0, 0, 0, 0);
    const monthsDiff =
      (now.getFullYear() - startDate.getFullYear()) * 12 +
      (now.getMonth() - startDate.getMonth());
    const halfIndex = Math.floor(monthsDiff / 6);
    const halfStart = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + halfIndex * 6,
      startDate.getDate()
    );
    halfStart.setHours(0, 0, 0, 0);
    const halfEnd = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + (halfIndex + 1) * 6,
      startDate.getDate()
    );
    halfEnd.setHours(0, 0, 0, 0);
    let weeklySpent = 0;
    let monthlySpent = 0;
    let biannualSpent = 0;
    groceries.forEach((item) => {
      if (!item || !item.archived || !item.purchasedDate) return;
      const cost = Number(item.cost);
      if (!Number.isFinite(cost)) return;
      const purchasedDate = new Date(item.purchasedDate);
      if (Number.isNaN(purchasedDate.getTime())) return;
      const frequency =
        typeof item.frequency === 'string'
          ? item.frequency.toLowerCase()
          : 'weekly';
      if (
        frequency === 'weekly' &&
        purchasedDate >= weekStart &&
        purchasedDate < weekEnd
      ) {
        weeklySpent += cost;
      }
      if (
        frequency === 'monthly' &&
        purchasedDate >= monthStart &&
        purchasedDate < monthEnd
      ) {
        monthlySpent += cost;
      }
      if (
        frequency === 'biannual' &&
        purchasedDate >= halfStart &&
        purchasedDate < halfEnd
      ) {
        biannualSpent += cost;
      }
    });
    monthlySpent += recurringTotal;
    const fitness = ensureFitnessDefaults();
    const currentMultiplier = clampMultiplier(fitness.currentMultiplier || 1);
    const nextMultiplier = clampMultiplier(
      typeof fitness.nextMultiplier === 'number'
        ? fitness.nextMultiplier
        : currentMultiplier
    );
    const weeklyBaseWithCarry =
      (data.groceryBudgetWeekly || 0) + (data.groceryBudgetWeeklyCarry || 0);
    const monthlyBudget =
      (data.groceryBudgetMonthly || 0) + (data.groceryBudgetMonthlyCarry || 0);
    const biannualBudget =
      (data.groceryBudgetBiYearly || 0) +
      (data.groceryBudgetBiYearlyCarry || 0);
    const weeklyBudget = weeklyBaseWithCarry * currentMultiplier;
    const makePeriod = (spent, budget, start, end) => {
      const progress = clampUnitInterval((now - start) / (end - start));
      const expected = budget * progress;
      return {
        spent,
        budget,
        expected,
        remaining: Math.max(0, budget - spent),
        progress
      };
    };
    return {
      weekly: makePeriod(weeklySpent, weeklyBudget, weekStart, weekEnd),
      monthly: makePeriod(monthlySpent, monthlyBudget, monthStart, monthEnd),
      biannual: makePeriod(biannualSpent, biannualBudget, halfStart, halfEnd),
      recurringTotal,
      wellnessCredits: fitness.wellnessCredits || 0,
      currentMultiplier,
      nextMultiplier,
      nextWeekBudget: weeklyBaseWithCarry * nextMultiplier
    };
  }

  function getWorkoutMobileSummary(now = new Date()) {
    const fitness = ensureFitnessDefaults();
    const monday = getWeekStart(now);
    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);
    const pointsInfo = collectWorkoutPoints({ start: monday, end: nextMonday });
    const weeklyPlan = computeWorkoutWeekPlan({
      fitness,
      pointsInfo,
      weekStart: monday,
      weekEnd: nextMonday,
      now
    });
    const remaining = weeklyPlan.paused
      ? 0
      : Math.max(0, weeklyPlan.requiredPoints - weeklyPlan.actualPoints);
    const todayStart = startOfLocalDay(now);
    const daysLeftThisWeek = Math.max(
      1,
      Math.ceil((nextMonday.getTime() - todayStart.getTime()) / 86400000)
    );
    const dailyTarget = weeklyPlan.paused ? 0 : remaining / daysLeftThisWeek;
    let state = 'On track';
    let tone = '';
    if (weeklyPlan.paused) {
      state = 'Week paused';
      tone = 'muted';
    } else if (weeklyPlan.scheduleDelta <= -1) {
      state = `${formatPoints(Math.abs(weeklyPlan.scheduleDelta))} pts behind`;
      tone = 'risk';
    } else if (weeklyPlan.scheduleDelta >= 1) {
      state = `${formatPoints(weeklyPlan.scheduleDelta)} pts ahead`;
      tone = 'primary';
    }
    return {
      weeklyPlan,
      pointsInfo,
      remaining,
      dailyTarget,
      label: weeklyPlan.paused
        ? 'Paused'
        : `${formatPoints(dailyTarget)} pts today`,
      detail: `${formatPoints(weeklyPlan.actualPoints)} / ${formatPoints(
        weeklyPlan.requiredPoints
      )} pts scheduled`,
      state,
      tone
    };
  }

  function getRecentManualWorkoutEntry() {
    return ensureWorkoutData()
      .entries.slice()
      .filter((entry) => entry && entry.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  }

  function getFavoriteWorkoutPreset() {
    const workouts = ensureWorkoutData();
    const recent = getRecentManualWorkoutEntry();
    if (recent) {
      const preset = workouts.presets.find(
        (candidate) => candidate.id === recent.presetId
      );
      if (preset) return preset;
      return {
        id: null,
        name: recent.name,
        intensity: recent.intensity
      };
    }
    return workouts.presets.slice().sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    })[0];
  }

  function logWorkoutShortcut(presetOrEntry) {
    if (!presetOrEntry) {
      openMobileWorkoutSheet();
      return null;
    }
    const snapshot = cloneData();
    const entry = logWorkoutEntry({
      name: presetOrEntry.name,
      intensity: presetOrEntry.intensity,
      presetId: presetOrEntry.id || presetOrEntry.presetId || null
    });
    if (!entry) {
      showToast('Could not log workout.');
      return null;
    }
    offerUndo('Workout logged.', snapshot);
    provideHaptic('beep');
    renderTodayCommandPanel();
    return entry;
  }

  function getRecentArchivedPurchase() {
    return (Array.isArray(data.groceries) ? data.groceries : [])
      .filter((item) => item && item.archived && item.purchasedDate)
      .sort((a, b) => new Date(b.purchasedDate) - new Date(a.purchasedDate))[0];
  }

  function computePurchaseCost(item, originalCost, { apply = false } = {}) {
    const fitnessData = ensureFitnessDefaults();
    let costVal = originalCost;
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
      costVal = Math.max(0, originalCost - creditsUsed);
      if (apply) {
        fitnessData.wellnessCredits = Math.max(
          0,
          (fitnessData.wellnessCredits || 0) - creditsUsed
        );
      }
    }
    return {
      originalCost,
      cost: costVal,
      creditsUsed,
      boostApplied: boostCreditsUsed > 0,
      boostPercentApplied
    };
  }

  function logGroceryPurchase(item, parsedCost, { snapshot = null } = {}) {
    if (!item) {
      showToast('Choose an item to buy.');
      return null;
    }
    const originalCost = Number(parsedCost);
    if (!Number.isFinite(originalCost) || originalCost < 0) {
      showToast('Enter a valid cost.');
      return null;
    }
    const undoSnapshot = snapshot || cloneData();
    const purchase = computePurchaseCost(item, originalCost, { apply: true });
    item.originalCost = purchase.originalCost;
    item.cost = purchase.cost;
    item.appliedCredits = purchase.creditsUsed;
    item.boostApplied = purchase.boostApplied;
    item.boostPercentApplied = purchase.boostPercentApplied;
    item.archived = true;
    item.purchasedDate = new Date().toISOString();
    saveData();
    updateGrocerySection();
    updateTodoSection();
    renderTodayCommandPanel();
    offerUndo('Purchase logged.', undoSnapshot);
    provideHaptic('beep');
    return purchase;
  }

  function createAndLogGroceryPurchase({
    name,
    frequency = 'weekly',
    category = 'standard',
    cost
  }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      showToast('Enter an item name.');
      return null;
    }
    const snapshot = cloneData();
    if (!Array.isArray(data.groceries)) data.groceries = [];
    const item = {
      id: uuid(),
      name: trimmed,
      frequency: ['weekly', 'monthly', 'biannual'].includes(frequency)
        ? frequency
        : 'weekly',
      category: ['standard', 'treat', 'essential'].includes(category)
        ? category
        : 'standard',
      archived: false,
      createdAt: new Date().toISOString()
    };
    data.groceries.push(item);
    return logGroceryPurchase(item, cost, { snapshot });
  }

  function repeatRecentPurchase() {
    const recent = getRecentArchivedPurchase();
    if (!recent) {
      openMobileFinanceSheet();
      return null;
    }
    return createAndLogGroceryPurchase({
      name: recent.name,
      frequency:
        typeof recent.frequency === 'string'
          ? recent.frequency.toLowerCase()
          : 'weekly',
      category: ['standard', 'treat', 'essential'].includes(recent.category)
        ? recent.category
        : 'standard',
      cost: Number.isFinite(Number(recent.originalCost))
        ? Number(recent.originalCost)
        : Number(recent.cost) || 0
    });
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
      deleteBtn.addEventListener('click', async () => {
        const ok = await requestConfirm({
          title: 'Delete Wealth Point',
          message: 'Delete this wealth data point?',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        const snapshot = cloneData();
        deleteWealthHistoryEntry(entry.id);
        updateWealthDashboard();
        renderWealthHistoryTable();
        offerUndo('Wealth point deleted.', snapshot);
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
          label: 'Projection band (+/- ~1 sigma)',
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
    return (value >= 0 ? '+' : '-') + formatted + ' SEK';
  }
  // Load and save data

  const DEFAULT_FOCUS_BLOCKED_WEBSITES = [
    'reddit.com',
    'www.reddit.com',
    'old.reddit.com',
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
    'youtubei.googleapis.com',
    'youtube.googleapis.com',
    'ytimg.com',
    'www.ytimg.com',
    'i.ytimg.com'
  ];

  function normalizeFocusBlockedSite(raw) {
    const cleaned = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .split(':')[0];
    if (!cleaned) return null;
    if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(cleaned)) return null;
    return cleaned;
  }

  function normalizeFocusBlockedSites(value, fallback = []) {
    const rawItems = Array.isArray(value)
      ? value
      : String(value || '')
          .split(/[\s,]+/)
          .filter(Boolean);
    const normalized = [
      ...new Set(rawItems.map(normalizeFocusBlockedSite).filter(Boolean))
    ];
    if (normalized.length) return normalized;
    return [...fallback];
  }

  const CODEX_INTEGRATION_TOKEN_KEY = 'timekeeperCodexIntegrationToken';
  const CODEX_DEFAULT_REPOSITORY = 'Henrik-KM/TimeKeeper';
  const CODEX_DEFAULT_BRANCH = 'main';
  const CODEX_DEFAULT_CONFIG_PATH = 'assets/timekeeper-codex-config.json';
  const CODEX_DEFAULT_INBOX_PATH = 'assets/timekeeper-codex-inbox';
  const CODEX_IMPORT_INTERVAL_MS = 5 * 60 * 1000;
  const CODEX_IMPORT_LOOKBACK_DAYS = 7;
  const CODEX_FOCUS_FACTOR = 0.5;

  function normalizeGitHubRepository(value = '') {
    const repository = String(value || '')
      .trim()
      .replace(/^https:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
    const [owner = '', repo = ''] = repository.split('/');
    return owner && repo ? `${owner}/${repo}` : repository;
  }

  function normalizeCodexPath(value, fallback) {
    const path = String(value || fallback || '')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/');
    return path || fallback;
  }

  function normalizeCodexMappings(value = []) {
    if (!Array.isArray(value)) return [];
    return value
      .map((mapping) => {
        const obj = mapping && typeof mapping === 'object' ? mapping : {};
        const match = String(obj.match || obj.repoName || '').trim();
        if (!match) return null;
        const projectId =
          obj.projectId === null ? null : String(obj.projectId || '').trim();
        return {
          matchType:
            obj.matchType === 'pathIncludes' ? 'pathIncludes' : 'repoName',
          match,
          projectId: projectId || null
        };
      })
      .filter(Boolean);
  }

  function makeDefaultCodexIntegration() {
    return {
      enabled: false,
      repository: CODEX_DEFAULT_REPOSITORY,
      branch: CODEX_DEFAULT_BRANCH,
      configPath: CODEX_DEFAULT_CONFIG_PATH,
      inboxPath: CODEX_DEFAULT_INBOX_PATH,
      mappings: [],
      importedCodexRecordIds: [],
      lastImportAt: null,
      lastImportSummary: null
    };
  }

  function normalizeCodexIntegration(value = {}) {
    const config = value && typeof value === 'object' ? value : {};
    const defaults = makeDefaultCodexIntegration();
    const importedIds = Array.isArray(config.importedCodexRecordIds)
      ? config.importedCodexRecordIds.map((id) => String(id)).filter(Boolean)
      : [];
    return {
      enabled: config.enabled === true,
      repository:
        normalizeGitHubRepository(config.repository) || defaults.repository,
      branch:
        String(config.branch || defaults.branch).trim() || defaults.branch,
      configPath: normalizeCodexPath(config.configPath, defaults.configPath),
      inboxPath: normalizeCodexPath(config.inboxPath, defaults.inboxPath),
      mappings: normalizeCodexMappings(config.mappings),
      importedCodexRecordIds: [...new Set(importedIds)].slice(-1000),
      lastImportAt: config.lastImportAt || null,
      lastImportSummary:
        config.lastImportSummary && typeof config.lastImportSummary === 'object'
          ? config.lastImportSummary
          : null
    };
  }

  function normalizeProjectData(project) {
    const obj = project && typeof project === 'object' ? { ...project } : {};
    if (!obj.id) obj.id = uuid();
    if (!obj.createdAt) obj.createdAt = new Date().toISOString();
    const explicitType =
      typeof obj.scheduleType === 'string' ? obj.scheduleType : '';
    const weeklyHours = Number(obj.weeklyExpectedHours);
    obj.scheduleType =
      explicitType === 'weekly' ||
      (!obj.deadline && Number.isFinite(weeklyHours) && weeklyHours > 0)
        ? 'weekly'
        : 'deadline';
    obj.weeklyExpectedHours =
      obj.scheduleType === 'weekly' && Number.isFinite(weeklyHours)
        ? Math.max(0, weeklyHours)
        : 0;
    if (obj.scheduleType === 'weekly') {
      obj.deadline = '';
      const budgetHours = Number(obj.budgetHours);
      obj.budgetHours = Number.isFinite(budgetHours)
        ? Math.max(0, budgetHours)
        : 0;
    }
    obj.archived = obj.archived === true || obj.isActive === false;
    obj.isActive = !obj.archived;
    const parsedStart = parseLocalDateString(obj.startDate || obj.createdAt);
    obj.startDate = parsedStart ? formatLocalDateString(parsedStart) : '';
    return obj;
  }

  function normalizeTimerPreset(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const projectId = String(preset.projectId || '').trim();
    if (!projectId) return null;
    const focusFactor = Number(preset.focusFactor);
    return {
      id: preset.id || uuid(),
      projectId,
      description: String(preset.description || '').trim(),
      focusFactor:
        Number.isFinite(focusFactor) && focusFactor > 0 ? focusFactor : 1,
      createdAt:
        typeof preset.createdAt === 'string' && preset.createdAt
          ? preset.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof preset.updatedAt === 'string' && preset.updatedAt
          ? preset.updatedAt
          : typeof preset.createdAt === 'string' && preset.createdAt
            ? preset.createdAt
            : new Date().toISOString()
    };
  }

  function normalizeTimerPresets(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const normalized = [];
    value.forEach((preset) => {
      const item = normalizeTimerPreset(preset);
      if (!item) return;
      const key = [
        String(item.projectId),
        item.description.toLowerCase(),
        String(item.focusFactor)
      ].join('::');
      if (seen.has(key)) return;
      seen.add(key);
      normalized.push(item);
    });
    return normalized;
  }

  function normalizeReminderSettings(value = {}) {
    const input = value && typeof value === 'object' ? value : {};
    const staleTimerMinutes = Number(input.staleTimerMinutes);
    const backupAgeHours = Number(input.backupAgeHours);
    return {
      enabled: input.enabled === true,
      staleTimerMinutes:
        Number.isFinite(staleTimerMinutes) && staleTimerMinutes >= 15
          ? Math.min(1440, Math.round(staleTimerMinutes))
          : 240,
      backupAgeHours:
        Number.isFinite(backupAgeHours) && backupAgeHours >= 1
          ? Math.min(168, Math.round(backupAgeHours))
          : 24
    };
  }

  function normalizeBillingViews(value = []) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .map((view) => {
        const item = view && typeof view === 'object' ? view : {};
        const name = String(item.name || '').trim();
        if (!name) return null;
        const filters =
          item.filters && typeof item.filters === 'object' ? item.filters : {};
        const id = item.id || uuid();
        return {
          id,
          name,
          filters: {
            projectId: String(filters.projectId || ''),
            search: String(filters.search || ''),
            from: String(filters.from || ''),
            to: String(filters.to || ''),
            showAll: filters.showAll === true
          },
          createdAt:
            typeof item.createdAt === 'string' && item.createdAt
              ? item.createdAt
              : new Date().toISOString()
        };
      })
      .filter((view) => {
        if (!view) return false;
        const key = view.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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
        lastBackupVerifiedAt: null,
        backupRevision: 0,
        updatedAt: null,
        timerPresets: [],
        entryBillingViews: [],
        reminderSettings: normalizeReminderSettings(),
        codexIntegration: makeDefaultCodexIntegration(),
        focusBlockerSites: [...DEFAULT_FOCUS_BLOCKED_WEBSITES],
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
        lastBackupVerifiedAt: parsed.lastBackupVerifiedAt || null,
        backupRevision:
          typeof parsed.backupRevision === 'number' ? parsed.backupRevision : 0,
        updatedAt: parsed.updatedAt || null,
        timerPresets: normalizeTimerPresets(parsed.timerPresets),
        entryBillingViews: normalizeBillingViews(parsed.entryBillingViews),
        reminderSettings: normalizeReminderSettings(parsed.reminderSettings),
        codexIntegration: normalizeCodexIntegration(parsed.codexIntegration),
        focusBlockerSites: normalizeFocusBlockedSites(
          parsed.focusBlockerSites,
          DEFAULT_FOCUS_BLOCKED_WEBSITES
        ),
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
        lastBackupVerifiedAt: null,
        backupRevision: 0,
        updatedAt: null,
        timerPresets: [],
        entryBillingViews: [],
        reminderSettings: normalizeReminderSettings(),
        codexIntegration: makeDefaultCodexIntegration(),
        focusBlockerSites: [...DEFAULT_FOCUS_BLOCKED_WEBSITES],
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
    renderMobileSyncStatus();
  }

  function cloneData(value = data) {
    return JSON.parse(JSON.stringify(value));
  }

  function refreshAllViews() {
    data.codexIntegration = normalizeCodexIntegration(data.codexIntegration);
    ensureFitnessDefaults();
    ensureWorkoutData();
    ensureMonthlyRecurringPayments();
    ensureWealthData();
    ensureTimerPresets();
    ensureBillingViews();
    ensureReminderSettings();
    updateProjectSelects();
    updateEntriesTable();
    updateProjectsPage();
    updateDashboard();
    updateTimerSection();
    updateTodoSection();
    updateGrocerySection();
    updateWealthDashboard();
    renderWealthHistoryTable();
    updateFocusBlocker();
    updateAutoSyncStatus();
    updateCodexIntegrationPanel();
    updateReminderSettingsPanel();
    updatePwaStatusPanel();
    renderTodayCommandPanel();
    renderMobileSyncStatus();
    renderMobileUndoTray();
  }

  function restoreDataSnapshot(snapshot) {
    data = cloneData(snapshot);
    persistDataToLocalStorage();
    needsBackup = true;
    scheduleBackupSoon();
    refreshAllViews();
  }

  const MOBILE_UNDO_TRAY_VISIBLE_MS = 3500;
  const mobileActionHistory = [];
  let mobileUndoTrayTimer = null;
  let mobileUndoTrayDismissedActionId = null;

  function clearMobileUndoTrayTimer() {
    if (mobileUndoTrayTimer) {
      clearTimeout(mobileUndoTrayTimer);
      mobileUndoTrayTimer = null;
    }
  }

  function scheduleMobileUndoTrayDismiss(actionId) {
    clearMobileUndoTrayTimer();
    mobileUndoTrayTimer = setTimeout(() => {
      if (mobileActionHistory[0]?.id !== actionId) return;
      mobileUndoTrayDismissedActionId = actionId;
      const tray = document.getElementById('mobileUndoTray');
      if (tray) tray.classList.add('hidden');
      mobileUndoTrayTimer = null;
    }, MOBILE_UNDO_TRAY_VISIBLE_MS);
  }

  function pushMobileActionHistory(message, snapshot) {
    mobileUndoTrayDismissedActionId = null;
    mobileActionHistory.unshift({
      id: uuid(),
      message,
      snapshot: cloneData(snapshot),
      createdAt: new Date().toISOString()
    });
    mobileActionHistory.splice(5);
    renderMobileUndoTray();
  }

  function renderMobileUndoTray() {
    let tray = document.getElementById('mobileUndoTray');
    if (!isMobileViewport()) {
      if (tray) tray.classList.add('hidden');
      clearMobileUndoTrayTimer();
      return;
    }
    if (!tray) {
      tray = document.createElement('div');
      tray.id = 'mobileUndoTray';
      tray.className = 'mobile-undo-tray hidden';
      tray.setAttribute('aria-live', 'polite');
      document.body.appendChild(tray);
    }
    tray.innerHTML = '';
    if (!mobileActionHistory.length) {
      tray.classList.add('hidden');
      mobileUndoTrayDismissedActionId = null;
      clearMobileUndoTrayTimer();
      return;
    }
    const latest = mobileActionHistory[0];
    if (mobileUndoTrayDismissedActionId === latest.id) {
      tray.classList.add('hidden');
      clearMobileUndoTrayTimer();
      return;
    }
    tray.classList.remove('hidden');
    const label = document.createElement('span');
    label.textContent = latest.message;
    tray.appendChild(label);
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'btn secondary';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      clearMobileUndoTrayTimer();
      restoreDataSnapshot(latest.snapshot);
      mobileActionHistory.shift();
      renderMobileUndoTray();
      if (!isMobileViewport()) showToast('Undo applied.');
    });
    tray.appendChild(undoBtn);
    const historyBtn = document.createElement('button');
    historyBtn.type = 'button';
    historyBtn.className = 'btn secondary';
    historyBtn.textContent = 'History';
    historyBtn.addEventListener('click', openMobileUndoHistory);
    tray.appendChild(historyBtn);
    scheduleMobileUndoTrayDismiss(latest.id);
  }

  function openMobileUndoHistory() {
    const sheet = createMobileSheet('Recent actions', {
      className: 'mobile-history-sheet'
    });
    const list = document.createElement('div');
    list.className = 'mobile-history-list';
    if (!mobileActionHistory.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No recent actions.';
      list.appendChild(empty);
    } else {
      mobileActionHistory.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'mobile-history-row';
        const text = document.createElement('span');
        text.textContent = `${item.message} - ${formatRelativeTime(item.createdAt)}`;
        row.appendChild(text);
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'btn secondary';
        undo.textContent = 'Undo';
        undo.addEventListener('click', () => {
          sheet.close();
          restoreDataSnapshot(item.snapshot);
          const index = mobileActionHistory.findIndex(
            (candidate) => candidate.id === item.id
          );
          if (index >= 0) mobileActionHistory.splice(index, 1);
          renderMobileUndoTray();
          if (!isMobileViewport()) showToast('Undo applied.');
        });
        row.appendChild(undo);
        list.appendChild(row);
      });
    }
    sheet.body.appendChild(list);
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function offerUndo(message, snapshot) {
    pushMobileActionHistory(message, snapshot);
    if (isMobileViewport()) return;
    showToast(message, {
      actionLabel: 'Undo',
      onAction: () => {
        restoreDataSnapshot(snapshot);
        renderMobileUndoTray();
        showToast('Undo applied.');
      }
    });
  }

  function ensureTimerPresets() {
    data.timerPresets = normalizeTimerPresets(data.timerPresets);
    return data.timerPresets;
  }

  function ensureBillingViews() {
    data.entryBillingViews = normalizeBillingViews(data.entryBillingViews);
    return data.entryBillingViews;
  }

  function ensureReminderSettings() {
    data.reminderSettings = normalizeReminderSettings(data.reminderSettings);
    return data.reminderSettings;
  }

  function makeTimerPresetKey(projectId, description, focusFactor) {
    return [
      String(projectId || ''),
      String(description || '')
        .trim()
        .toLowerCase(),
      String(normalizeFocusFactor(focusFactor))
    ].join('::');
  }

  function formatTimerPresetLabel(project, description, focusFactor) {
    const focusText = formatFocusPercent(focusFactor);
    return description
      ? `${project.name} - ${description} - ${focusText}`
      : `${project.name} - ${focusText}`;
  }

  function isValidDateValue(value) {
    const date = new Date(value);
    return !Number.isNaN(date.getTime());
  }

  function getLocalDataAudit(now = new Date()) {
    const projectIds = new Set();
    const duplicateProjectIds = new Set();
    data.projects.forEach((project) => {
      const id = String(project.id || '');
      if (!id) return;
      if (projectIds.has(id)) duplicateProjectIds.add(id);
      projectIds.add(id);
    });

    const entryIds = new Set();
    const duplicateEntryIds = new Set();
    let orphanEntries = 0;
    let invalidStoppedEntries = 0;
    let invalidRunningEntries = 0;
    let invalidFocusEntries = 0;
    let staleRunningEntries = 0;
    const todayStart = startOfLocalDay(now);

    data.entries.forEach((entry) => {
      const entryId = String(entry.id || '');
      if (!entryId) {
        duplicateEntryIds.add('(missing)');
      } else if (entryIds.has(entryId)) {
        duplicateEntryIds.add(entryId);
      } else {
        entryIds.add(entryId);
      }

      const projectId = String(entry.projectId || '');
      if (!projectId || !projectIds.has(projectId)) {
        orphanEntries += 1;
      }

      const startValid = isValidDateValue(entry.startTime);
      if (entry.isRunning) {
        if (!startValid) invalidRunningEntries += 1;
        else if (new Date(entry.startTime) < todayStart) {
          staleRunningEntries += 1;
        }
      } else {
        const duration = Number(entry.duration);
        const endValid = isValidDateValue(entry.endTime);
        const start = startValid ? new Date(entry.startTime) : null;
        const end = endValid ? new Date(entry.endTime) : null;
        if (
          !Number.isFinite(duration) ||
          duration < 0 ||
          !startValid ||
          !endValid ||
          (start && end && end <= start)
        ) {
          invalidStoppedEntries += 1;
        }
      }

      const factorCandidates = [entry.focusFactor, entry.manualFactor].filter(
        (candidate) => candidate !== undefined && candidate !== null
      );
      if (
        factorCandidates.some(
          (candidate) =>
            !Number.isFinite(Number(candidate)) || Number(candidate) <= 0
        )
      ) {
        invalidFocusEntries += 1;
      }
    });

    const duplicateProjectCount = duplicateProjectIds.size;
    const duplicateEntryCount = duplicateEntryIds.size;
    const repairableCount =
      duplicateProjectCount +
      duplicateEntryCount +
      orphanEntries +
      invalidStoppedEntries +
      invalidRunningEntries +
      invalidFocusEntries;
    const issueParts = [];
    if (duplicateProjectCount)
      issueParts.push(`${duplicateProjectCount} duplicate project IDs`);
    if (duplicateEntryCount)
      issueParts.push(`${duplicateEntryCount} duplicate entry IDs`);
    if (orphanEntries) issueParts.push(`${orphanEntries} orphan entries`);
    if (invalidStoppedEntries)
      issueParts.push(`${invalidStoppedEntries} invalid stopped entries`);
    if (invalidRunningEntries)
      issueParts.push(`${invalidRunningEntries} invalid running entries`);
    if (invalidFocusEntries)
      issueParts.push(`${invalidFocusEntries} invalid focus values`);
    if (staleRunningEntries)
      issueParts.push(`${staleRunningEntries} running timers need review`);

    return {
      duplicateProjectCount,
      duplicateEntryCount,
      orphanEntries,
      invalidStoppedEntries,
      invalidRunningEntries,
      invalidFocusEntries,
      staleRunningEntries,
      repairableCount,
      totalIssues: repairableCount + staleRunningEntries,
      issueParts
    };
  }

  function repairLocalDataNow() {
    let fixedCount = 0;
    const seenProjectIds = new Set();
    data.projects.forEach((project) => {
      if (!project.id || seenProjectIds.has(String(project.id))) {
        project.id = uuid();
        fixedCount += 1;
      }
      seenProjectIds.add(String(project.id));
    });
    const projectIds = new Set(
      data.projects.map((project) => String(project.id))
    );
    const seenEntryIds = new Set();
    const repairedEntries = [];
    data.entries.forEach((entry) => {
      let changed = false;
      if (!entry.id || seenEntryIds.has(String(entry.id))) {
        entry.id = uuid();
        changed = true;
      }
      seenEntryIds.add(String(entry.id));

      if (!projectIds.has(String(entry.projectId || ''))) {
        fixedCount += 1;
        return;
      }

      const focusFactor = getEntryFocusFactor(entry, 1);
      if (
        entry.focusFactor !== undefined &&
        entry.focusFactor !== null &&
        (!Number.isFinite(Number(entry.focusFactor)) ||
          Number(entry.focusFactor) <= 0)
      ) {
        entry.focusFactor = focusFactor;
        changed = true;
      }
      if (
        entry.manualFactor !== undefined &&
        (!Number.isFinite(Number(entry.manualFactor)) ||
          Number(entry.manualFactor) <= 0)
      ) {
        entry.manualFactor = focusFactor;
        changed = true;
      }

      const start = new Date(entry.startTime);
      const startValid = !Number.isNaN(start.getTime());
      if (entry.isRunning) {
        if (!startValid) {
          fixedCount += 1;
          return;
        }
        if (!entry.lastUpdateTime || !isValidDateValue(entry.lastUpdateTime)) {
          entry.lastUpdateTime = new Date().toISOString();
          changed = true;
        }
        repairedEntries.push(entry);
        if (changed) fixedCount += 1;
        return;
      }

      const duration = Number(entry.duration);
      const end = new Date(entry.endTime);
      const endValid = !Number.isNaN(end.getTime());
      const durationValid = Number.isFinite(duration) && duration >= 0;
      if (startValid && endValid && end > start) {
        const computedDuration = Math.floor(
          ((end.getTime() - start.getTime()) / 1000) * focusFactor
        );
        if (!durationValid || duration !== computedDuration) {
          entry.duration = computedDuration;
          changed = true;
        }
      } else if (startValid && durationValid) {
        entry.endTime = new Date(
          start.getTime() + (duration / focusFactor) * 1000
        ).toISOString();
        changed = true;
      } else {
        fixedCount += 1;
        return;
      }
      delete entry.effectiveSeconds;
      delete entry.lastUpdateTime;
      delete entry.factor;
      delete entry.pausedAt;
      repairedEntries.push(entry);
      if (changed) fixedCount += 1;
    });
    data.entries = repairedEntries;
    return fixedCount;
  }

  async function repairLocalData() {
    const audit = getLocalDataAudit();
    if (!audit.repairableCount) {
      showToast('No repairable local data issues found.');
      return;
    }
    const ok = await requestConfirm({
      title: 'Repair Local Data',
      message:
        `Repair ${audit.repairableCount} local data issue${audit.repairableCount === 1 ? '' : 's'}? ` +
        'This removes entries without a project, fixes duplicate IDs, normalizes invalid focus values, and recalculates broken stopped-entry durations. Running timers that merely look old are left for review.',
      confirmLabel: 'Repair Data',
      danger: true
    });
    if (!ok) return;
    const snapshot = cloneData();
    const fixedCount = repairLocalDataNow();
    saveData();
    refreshAllViews();
    offerUndo(
      `Repaired ${fixedCount} local data issue${fixedCount === 1 ? '' : 's'}.`,
      snapshot
    );
  }

  // Focus model:
  // - 100% means you are actively focused on a project.
  // - 50% means an agent is working while you are not actively focused there.
  // - 150% means you and one agent are working together.
  // - 200% means you and two or more agents are working together.
  // - 25% means an agent is working while you are only half-engaged or not monitoring it.
  const DEFAULT_FOCUS_FACTOR = 1;
  const FOCUS_FACTOR_OPTIONS = [
    { value: 1, label: '100% - you' },
    { value: 1.5, label: '150% - you + agent' },
    { value: 2, label: '200% - you + 2+ agents' },
    { value: 0.5, label: '50% - agent' },
    { value: 0.25, label: '25% - unmonitored agent' }
  ];
  function normalizeFocusFactor(value, fallback = DEFAULT_FOCUS_FACTOR) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  function formatFocusPercent(factor) {
    const parsed = Number(factor);
    const safeFactor = Number.isFinite(parsed) ? parsed : DEFAULT_FOCUS_FACTOR;
    return Math.round(safeFactor * 100) + '%';
  }
  function getEntryFocusFactor(entry, _fallbackCount = 1) {
    const candidates = [
      entry && entry.focusFactor,
      entry && entry.manualFactor,
      entry && entry.factor,
      DEFAULT_FOCUS_FACTOR
    ];
    const value = candidates.find(
      (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0
    );
    return normalizeFocusFactor(value, DEFAULT_FOCUS_FACTOR);
  }

  function getEntryActiveFactor(entry, _fallbackCount = 1) {
    if (!entry) return DEFAULT_FOCUS_FACTOR;
    const candidates = [entry.manualFactor, entry.focusFactor, entry.factor];
    const value = candidates.find(
      (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0
    );
    if (value !== undefined) return Number(value);
    return DEFAULT_FOCUS_FACTOR;
  }

  function isTimerPaused(entry) {
    return !!(entry && entry.pausedAt);
  }

  function getActiveRunningEntries() {
    return getRunningEntries().filter((entry) => !isTimerPaused(entry));
  }

  function accumulateRunningEntry(entry, now = new Date(), runningCount = 1) {
    if (!entry || !entry.isRunning || isTimerPaused(entry)) {
      return getEntryActiveFactor(entry, runningCount);
    }
    const last = entry.lastUpdateTime
      ? new Date(entry.lastUpdateTime)
      : new Date(entry.startTime);
    const elapsedSec = Math.max(0, (now - last) / 1000);
    const factor = getEntryActiveFactor(entry, runningCount);
    entry.effectiveSeconds =
      (entry.effectiveSeconds || 0) + elapsedSec * factor;
    entry.lastUpdateTime = now.toISOString();
    return factor;
  }

  function rebalanceActiveRunningFactors(now = new Date()) {
    const active = getActiveRunningEntries();
    active.forEach((entry) => {
      const factor = getEntryActiveFactor(entry, active.length);
      entry.factor = factor;
      entry.focusFactor = factor;
      entry.lastUpdateTime = now.toISOString();
    });
  }

  function getPaidFocusTotal() {
    const running = getActiveRunningEntries();
    let total = 0;
    running.forEach((entry) => {
      const project = data.projects.find(
        (p) => String(p.id) === String(entry.projectId)
      );
      const hourlyRate = project ? Number(project.hourlyRate) : NaN;
      const isUnpaid = Number.isFinite(hourlyRate) && hourlyRate <= 0;
      if (isUnpaid) return;
      total += getEntryFocusFactor(entry, running.length);
    });
    return total;
  }

  function toDateTimeInputValue(value) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }
  function safeExternalUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''), window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {}
    return '';
  }
  function safeStatusColor(value) {
    return ['green', 'amber', 'red'].includes(value) ? value : 'green';
  }
  function appendLabeledText(container, label, value) {
    const strong = document.createElement('strong');
    strong.textContent = label;
    container.appendChild(strong);
    container.appendChild(document.createTextNode(' ' + String(value ?? '')));
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
  let backupSnapshotItems = [];
  let backupSnapshotState = 'idle';
  let backupSnapshotMessage = '';
  let backupConflict = null;
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
  let showArchivedProjects = false;
  let entryProjectFilter = '';
  let entrySearchQuery = '';
  let entryDateFrom = '';
  let entryDateTo = '';
  const selectedEntryIds = new Set();
  let pendingInstallPrompt = null;
  let pendingServiceWorkerRegistration = null;
  let reloadAfterServiceWorkerUpdate = false;
  let offlineShellStatus =
    'serviceWorker' in navigator && window.location.protocol.startsWith('http')
      ? 'pending'
      : 'unsupported';
  let offlineShellError = '';
  let lastReminderKey = '';
  let lastReminderAt = 0;

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
    } catch {
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
        showToast('Workout name is required.');
        return;
      }
      if (isNaN(whenDate)) {
        showToast('Please provide a valid date and time.');
        return;
      }
      let intensityValue = intensityInput ? intensityInput.value : 'medium';
      let intensityToSave = intensityValue;
      if (intensityValue === 'custom') {
        const raw = customIntensityInput ? customIntensityInput.value : '';
        const customPoints = sanitizeCustomPoints(raw);
        if (customPoints === null) {
          showToast(
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
    if (backupDirHandle && backupPermissionState === 'granted') {
      refreshBackupSnapshots({ quiet: true });
    }
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
  const FOCUS_STATUS_URL = 'http://127.0.0.1:8766/focus/status';
  const FOCUS_SELF_TEST_URL = 'http://127.0.0.1:8766/focus/self-test';
  const FOCUS_BLOCK_THRESHOLD = 0.5;
  const FOCUS_BLOCKER_HEARTBEAT_MS = 60000;
  const FOCUS_STATUS_TIMEOUT_MS = 3000;
  const FOCUS_BRIDGE_CONFIG_KEY = 'timekeeperFocusBridgeConfig';
  const FOCUS_BRIDGE_PUBLISH_MS = 5 * 60 * 1000;
  const FOCUS_BRIDGE_EXPIRES_MS = 15 * 60 * 1000;
  const focusWebhookImages = new Set();
  let focusBridgeLastPublishAt = 0;
  let focusBridgeLastPayloadKey = '';
  let focusBridgePublishPromise = null;
  let focusBridgeQueuedPublish = null;
  let focusBridgeStatus = {
    checkedAt: null,
    pending: false,
    publishedAt: null,
    error: '',
    apiUrl: ''
  };
  let codexImportPromise = null;
  let codexImportTimer = null;
  let codexImportRuntimeStatus = {
    pending: false,
    checkedAt: null,
    error: '',
    imported: 0,
    skipped: 0
  };

  function normalizeGitHubPath(value) {
    const path = String(value || 'assets/timekeeper-focus-state.json')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/');
    return path || 'assets/timekeeper-focus-state.json';
  }

  function normalizeFocusBridgeConfig(value = {}) {
    const config = value && typeof value === 'object' ? value : {};
    const repository = String(config.repository || '')
      .trim()
      .replace(/^https:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
    const [owner = '', repo = ''] = repository.split('/');
    return {
      enabled: config.enabled === true || config.enabled === 'github',
      repository: owner && repo ? `${owner}/${repo}` : repository,
      branch: String(config.branch || 'main').trim() || 'main',
      path: normalizeGitHubPath(config.path),
      token: String(config.token || '').trim()
    };
  }

  function getFocusBridgeConfig() {
    try {
      return normalizeFocusBridgeConfig(
        JSON.parse(localStorage.getItem(FOCUS_BRIDGE_CONFIG_KEY) || '{}')
      );
    } catch {
      return normalizeFocusBridgeConfig();
    }
  }

  function saveFocusBridgeConfig(config) {
    localStorage.setItem(
      FOCUS_BRIDGE_CONFIG_KEY,
      JSON.stringify(normalizeFocusBridgeConfig(config))
    );
  }

  function getGitHubApiPath(pathValue) {
    return normalizeGitHubPath(pathValue)
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  function getFocusBridgeApiUrl(config = getFocusBridgeConfig()) {
    const normalized = normalizeFocusBridgeConfig(config);
    if (!normalized.repository || !normalized.repository.includes('/')) {
      return '';
    }
    return `https://api.github.com/repos/${normalized.repository}/contents/${getGitHubApiPath(normalized.path)}?ref=${encodeURIComponent(normalized.branch)}`;
  }

  function encodeUtf8Base64(value) {
    return btoa(unescape(encodeURIComponent(String(value))));
  }

  function buildFocusBridgeState(paidFocus) {
    const now = new Date();
    return {
      version: 1,
      source: 'timekeeper',
      active: paidFocus > FOCUS_BLOCK_THRESHOLD,
      paidFocusPercent: Math.round(paidFocus * 100),
      thresholdPercent: Math.round(FOCUS_BLOCK_THRESHOLD * 100),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + FOCUS_BRIDGE_EXPIRES_MS
      ).toISOString(),
      blockedSites: getFocusBlockedWebsites()
    };
  }

  function getFocusBridgePayloadKey(state) {
    return JSON.stringify({
      active: state.active,
      paidFocusPercent: state.paidFocusPercent,
      thresholdPercent: state.thresholdPercent,
      blockedSites: state.blockedSites
    });
  }

  function getGitHubErrorMessage(payload, status) {
    const base =
      payload && payload.message
        ? payload.message
        : `GitHub returned ${status}.`;
    const details = Array.isArray(payload?.errors)
      ? payload.errors
          .map((item) =>
            String(
              item?.message ||
                [item?.resource, item?.field, item?.code]
                  .filter(Boolean)
                  .join(' ')
            ).trim()
          )
          .filter(Boolean)
      : [];
    return [base, ...details].join(' ');
  }

  function isGitHubShaMismatchError(error) {
    return (
      error &&
      (error.status === 409 ||
        (error.status === 422 &&
          /sha|does not match|not match/i.test(error.message || '')))
    );
  }

  async function githubJson(url, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(url, {
      cache: 'no-store',
      ...requestOptions,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(getGitHubErrorMessage(payload, response.status));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function publishGitHubFocusState(config, state) {
    const apiUrl = getFocusBridgeApiUrl(config);
    if (!apiUrl) {
      throw new Error('Enter a GitHub repository as owner/repo.');
    }
    if (!config.token) {
      throw new Error('Enter a GitHub token with contents write access.');
    }
    const putUrl = apiUrl.replace(/\?.*$/, '');
    const content = `${JSON.stringify(state, null, 2)}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sha = null;
      try {
        const existing = await githubJson(apiUrl, {
          headers: { Authorization: `Bearer ${config.token}` }
        });
        sha = existing && existing.sha ? existing.sha : null;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      const body = {
        message: 'Update TimeKeeper focus state [skip ci]',
        content: encodeUtf8Base64(content),
        branch: config.branch
      };
      if (sha) body.sha = sha;
      try {
        await githubJson(putUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        return apiUrl;
      } catch (error) {
        if (attempt === 0 && isGitHubShaMismatchError(error)) continue;
        throw error;
      }
    }
    return apiUrl;
  }

  async function publishFocusBridgeState(paidFocus, { force = false } = {}) {
    const config = getFocusBridgeConfig();
    if (!config.enabled) return null;
    const state = buildFocusBridgeState(paidFocus);
    const payloadKey = getFocusBridgePayloadKey(state);
    const now = Date.now();
    if (
      !force &&
      payloadKey === focusBridgeLastPayloadKey &&
      now - focusBridgeLastPublishAt < FOCUS_BRIDGE_PUBLISH_MS
    ) {
      return null;
    }
    if (focusBridgePublishPromise) {
      focusBridgeQueuedPublish = { paidFocus, force };
      return focusBridgePublishPromise;
    }
    focusBridgeStatus = {
      ...focusBridgeStatus,
      pending: true,
      error: '',
      checkedAt: new Date().toISOString()
    };
    updateFocusStatusPanel(paidFocus);
    focusBridgePublishPromise = publishGitHubFocusState(config, state)
      .then((apiUrl) => {
        focusBridgeLastPublishAt = Date.now();
        focusBridgeLastPayloadKey = payloadKey;
        focusBridgeStatus = {
          checkedAt: new Date().toISOString(),
          pending: false,
          publishedAt: new Date().toISOString(),
          error: '',
          apiUrl
        };
        updateFocusStatusPanel(paidFocus);
        updateAppHealthPanel();
        return apiUrl;
      })
      .catch((error) => {
        focusBridgeStatus = {
          checkedAt: new Date().toISOString(),
          pending: false,
          publishedAt: focusBridgeStatus.publishedAt,
          error: error && error.message ? error.message : String(error),
          apiUrl: getFocusBridgeApiUrl(config)
        };
        updateFocusStatusPanel(paidFocus);
        updateAppHealthPanel();
        return null;
      })
      .finally(() => {
        focusBridgePublishPromise = null;
        const queued = focusBridgeQueuedPublish;
        focusBridgeQueuedPublish = null;
        if (queued) {
          publishFocusBridgeState(queued.paidFocus, {
            force: queued.force
          });
        }
      });
    return focusBridgePublishPromise;
  }

  async function editFocusBridgeSettings() {
    const config = getFocusBridgeConfig();
    const values = await openFormDialog({
      title: 'Focus Bridge',
      fields: [
        {
          name: 'enabled',
          label: 'Bridge',
          type: 'select',
          value: config.enabled ? 'github' : 'off',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'github', label: 'GitHub focus-state file' }
          ]
        },
        {
          name: 'repository',
          label: 'Repository (owner/repo)',
          value: config.repository,
          placeholder: 'nrik-km/nrik-km.github.io'
        },
        {
          name: 'branch',
          label: 'Branch',
          value: config.branch || 'main'
        },
        {
          name: 'path',
          label: 'State file path',
          value: config.path || 'assets/timekeeper-focus-state.json'
        },
        {
          name: 'token',
          label: 'GitHub token',
          type: 'password',
          value: config.token,
          placeholder: 'Fine-grained token with Contents read/write'
        }
      ],
      submitLabel: 'Save Bridge'
    });
    if (!values) return;
    const next = normalizeFocusBridgeConfig({
      enabled: values.enabled,
      repository: values.repository,
      branch: values.branch,
      path: values.path,
      token: values.token
    });
    if (next.enabled && (!next.repository.includes('/') || !next.token)) {
      showToast('Bridge needs an owner/repo and a GitHub token.');
      return;
    }
    saveFocusBridgeConfig(next);
    focusBridgeStatus = {
      checkedAt: new Date().toISOString(),
      pending: false,
      publishedAt: null,
      error: '',
      apiUrl: getFocusBridgeApiUrl(next)
    };
    if (next.enabled) {
      publishFocusBridgeState(getPaidFocusTotal(), { force: true });
    }
    updateFocusStatusPanel();
    updateAppHealthPanel();
    showToast(
      next.enabled ? 'Focus bridge enabled.' : 'Focus bridge disabled.'
    );
  }

  function getCodexIntegrationConfig() {
    data.codexIntegration = normalizeCodexIntegration(data.codexIntegration);
    return data.codexIntegration;
  }

  function getCodexIntegrationToken() {
    return String(localStorage.getItem(CODEX_INTEGRATION_TOKEN_KEY) || '');
  }

  function saveCodexIntegrationToken(token) {
    const normalized = String(token || '').trim();
    if (normalized) {
      localStorage.setItem(CODEX_INTEGRATION_TOKEN_KEY, normalized);
    } else {
      localStorage.removeItem(CODEX_INTEGRATION_TOKEN_KEY);
    }
  }

  function getCodexTrackedProjects() {
    const seen = new Set();
    const projects = [];
    data.projects.forEach((project) => {
      const name = String(project?.name || '').trim();
      const projectId = String(project?.id || '').trim();
      if (!name || !projectId || isProjectArchived(project)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      projects.push({ name, projectId });
    });
    return projects;
  }

  function getCodexLegacyPathMappings(projects = getCodexTrackedProjects()) {
    return projects.flatMap((project) => [
      {
        matchType: 'pathIncludes',
        match: `GitHub\\${project.name}`,
        projectId: project.projectId
      },
      {
        matchType: 'pathIncludes',
        match: `GitHub\\${project.name}\\`,
        projectId: project.projectId
      },
      {
        matchType: 'pathIncludes',
        match: `GitHub/${project.name}`,
        projectId: project.projectId
      },
      {
        matchType: 'pathIncludes',
        match: `GitHub/${project.name}/`,
        projectId: project.projectId
      }
    ]);
  }

  function findCodexProjectByName(name) {
    const value = String(name || '')
      .trim()
      .toLowerCase();
    if (!value) return null;
    return data.projects.find(
      (project) =>
        !isProjectArchived(project) &&
        String(project.name || '')
          .trim()
          .toLowerCase() === value
    );
  }

  function getCodexGitHubPathApiUrl(
    pathValue,
    config = getCodexIntegrationConfig()
  ) {
    const repository = normalizeGitHubRepository(config.repository);
    if (!repository || !repository.includes('/')) return '';
    const apiPath = normalizeCodexPath(pathValue, '')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return `https://api.github.com/repos/${repository}/contents/${apiPath}?ref=${encodeURIComponent(config.branch || CODEX_DEFAULT_BRANCH)}`;
  }

  function getCodexAuthHeaders() {
    const token = getCodexIntegrationToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function decodeUtf8Base64(value) {
    const binary = atob(String(value || '').replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function buildCodexPublishedConfig() {
    const config = getCodexIntegrationConfig();
    const trackedProjects = getCodexTrackedProjects();
    return {
      version: 2,
      source: 'timekeeper',
      enabled: config.enabled,
      updatedAt: new Date().toISOString(),
      matchMode: 'github-parent-folder',
      focusFactor: CODEX_FOCUS_FACTOR,
      trackedProjects,
      mappings: getCodexLegacyPathMappings(trackedProjects)
    };
  }

  async function putGitHubJsonFile(pathValue, payload, message) {
    const config = getCodexIntegrationConfig();
    const token = getCodexIntegrationToken();
    const apiUrl = getCodexGitHubPathApiUrl(pathValue, config);
    if (!apiUrl) throw new Error('Enter a GitHub repository as owner/repo.');
    if (!token) {
      throw new Error('Enter a GitHub token with Contents read/write access.');
    }
    const putUrl = apiUrl.replace(/\?.*$/, '');
    const content = encodeUtf8Base64(`${JSON.stringify(payload, null, 2)}\n`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sha = null;
      try {
        const existing = await githubJson(apiUrl, {
          headers: { Authorization: `Bearer ${token}` }
        });
        sha = existing && existing.sha ? existing.sha : null;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      const body = {
        message,
        content,
        branch: config.branch
      };
      if (sha) body.sha = sha;
      try {
        await githubJson(putUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        return apiUrl;
      } catch (error) {
        if (attempt === 0 && isGitHubShaMismatchError(error)) continue;
        throw error;
      }
    }
    return apiUrl;
  }

  async function publishCodexIntegrationConfig() {
    const config = getCodexIntegrationConfig();
    if (!config.enabled) {
      showToast('Enable Codex import before publishing config.');
      return null;
    }
    const payload = buildCodexPublishedConfig();
    if (!payload.trackedProjects.length) {
      showToast('Add at least one active TimeKeeper project.');
      return null;
    }
    try {
      const apiUrl = await putGitHubJsonFile(
        config.configPath,
        payload,
        'Update TimeKeeper Codex config [skip ci]'
      );
      codexImportRuntimeStatus = {
        ...codexImportRuntimeStatus,
        checkedAt: new Date().toISOString(),
        error: ''
      };
      updateCodexIntegrationPanel();
      showToast('Codex config published.');
      return apiUrl;
    } catch (error) {
      codexImportRuntimeStatus = {
        ...codexImportRuntimeStatus,
        checkedAt: new Date().toISOString(),
        error: error && error.message ? error.message : String(error)
      };
      updateCodexIntegrationPanel();
      showToast(
        `Codex config publish failed: ${codexImportRuntimeStatus.error}`
      );
      return null;
    }
  }

  async function editCodexIntegrationSettings() {
    const config = getCodexIntegrationConfig();
    const values = await openFormDialog({
      title: 'Codex Integration',
      fields: [
        {
          name: 'enabled',
          label: 'Codex import',
          type: 'select',
          value: config.enabled ? 'on' : 'off',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' }
          ]
        },
        {
          name: 'repository',
          label: 'Repository (owner/repo)',
          value: config.repository || CODEX_DEFAULT_REPOSITORY
        },
        {
          name: 'branch',
          label: 'Branch',
          value: config.branch || CODEX_DEFAULT_BRANCH
        },
        {
          name: 'configPath',
          label: 'Config file path',
          value: config.configPath || CODEX_DEFAULT_CONFIG_PATH
        },
        {
          name: 'inboxPath',
          label: 'Inbox folder path',
          value: config.inboxPath || CODEX_DEFAULT_INBOX_PATH
        },
        {
          name: 'token',
          label: 'GitHub token',
          type: 'password',
          value: getCodexIntegrationToken(),
          placeholder: 'Fine-grained token with Contents read/write'
        }
      ],
      submitLabel: 'Save Codex'
    });
    if (!values) return;
    const next = normalizeCodexIntegration({
      ...config,
      enabled: values.enabled === 'on',
      repository: values.repository,
      branch: values.branch,
      configPath: values.configPath,
      inboxPath: values.inboxPath
    });
    if (next.enabled && !next.repository.includes('/')) {
      showToast('Codex integration needs a GitHub repository as owner/repo.');
      return;
    }
    data.codexIntegration = next;
    saveCodexIntegrationToken(values.token);
    saveData();
    updateCodexIntegrationPanel();
    scheduleCodexAutoImport();
    showToast(
      next.enabled ? 'Codex import enabled.' : 'Codex import disabled.'
    );
  }

  function getCodexExistingExternalIds() {
    const ids = new Set(getCodexIntegrationConfig().importedCodexRecordIds);
    data.entries.forEach((entry) => {
      if (entry && entry.externalId) ids.add(String(entry.externalId));
    });
    return ids;
  }

  function getCodexImportWindowStart(referenceDate = new Date()) {
    return addLocalDays(
      startOfLocalDay(referenceDate),
      -(CODEX_IMPORT_LOOKBACK_DAYS - 1)
    );
  }

  function isCodexRecordInImportWindow(
    record,
    windowStart = getCodexImportWindowStart()
  ) {
    const start = new Date(record?.startTime || '');
    return !Number.isNaN(start.getTime()) && start >= windowStart;
  }

  function getActiveCodexProject(projectId) {
    return data.projects.find(
      (project) =>
        String(project.id) === String(projectId) && !isProjectArchived(project)
    );
  }

  function importCodexInboxPayloads(payloads = []) {
    const config = getCodexIntegrationConfig();
    const importedIds = getCodexExistingExternalIds();
    const windowStart = getCodexImportWindowStart();
    let imported = 0;
    let skipped = 0;
    const nowIso = new Date().toISOString();
    payloads.forEach((payload) => {
      const records = Array.isArray(payload?.records) ? payload.records : [];
      records.forEach((record) => {
        const recordId = String(record?.id || '').trim();
        let projectId = String(record?.timekeeperProjectId || '').trim();
        const namedProject = projectId
          ? null
          : findCodexProjectByName(record?.timekeeperProjectName);
        if (namedProject) projectId = String(namedProject.id);
        const effectiveSeconds = Math.floor(Number(record?.effectiveSeconds));
        const start = new Date(record?.startTime || '');
        const end = new Date(record?.endTime || '');
        if (
          !recordId ||
          importedIds.has(recordId) ||
          !isCodexRecordInImportWindow(record, windowStart) ||
          !projectId ||
          !getActiveCodexProject(projectId) ||
          !Number.isFinite(effectiveSeconds) ||
          effectiveSeconds <= 0 ||
          Number.isNaN(start.getTime()) ||
          Number.isNaN(end.getTime()) ||
          end <= start
        ) {
          skipped += 1;
          return;
        }
        data.entries.push({
          id: uuid(),
          projectId,
          description: String(record.description || 'Codex work').trim(),
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          duration: effectiveSeconds,
          focusFactor: CODEX_FOCUS_FACTOR,
          manualFactor: CODEX_FOCUS_FACTOR,
          isRunning: false,
          createdAt: nowIso,
          source: 'codex',
          externalId: recordId
        });
        importedIds.add(recordId);
        imported += 1;
      });
    });
    config.importedCodexRecordIds = [...importedIds].slice(-1000);
    config.lastImportAt = nowIso;
    config.lastImportSummary = { imported, skipped };
    codexImportRuntimeStatus = {
      pending: false,
      checkedAt: nowIso,
      error: '',
      imported,
      skipped
    };
    if (imported > 0) {
      saveData();
      refreshAllViews();
    } else {
      updateCodexIntegrationPanel();
    }
    return { imported, skipped };
  }

  async function fetchCodexInboxPayloads() {
    const config = getCodexIntegrationConfig();
    const directoryUrl = getCodexGitHubPathApiUrl(config.inboxPath, config);
    if (!directoryUrl)
      throw new Error('Enter a GitHub repository as owner/repo.');
    const directoryPayload = await githubJson(directoryUrl, {
      headers: getCodexAuthHeaders()
    }).catch((error) => {
      if (error.status === 404) return [];
      throw error;
    });
    const items = Array.isArray(directoryPayload) ? directoryPayload : [];
    const jsonItems = items.filter(
      (item) =>
        item &&
        item.type === 'file' &&
        String(item.name || '')
          .toLowerCase()
          .endsWith('.json')
    );
    const payloads = [];
    await Promise.all(
      jsonItems.map(async (item) => {
        const itemPayload = await githubJson(item.url, {
          headers: getCodexAuthHeaders()
        });
        payloads.push(JSON.parse(decodeUtf8Base64(itemPayload.content)));
      })
    );
    return payloads;
  }

  async function importCodexUsage({ quiet = false } = {}) {
    const config = getCodexIntegrationConfig();
    if (!config.enabled) {
      updateCodexIntegrationPanel();
      return { imported: 0, skipped: 0 };
    }
    if (codexImportPromise) return codexImportPromise;
    codexImportRuntimeStatus = {
      ...codexImportRuntimeStatus,
      pending: true,
      checkedAt: new Date().toISOString(),
      error: ''
    };
    updateCodexIntegrationPanel();
    codexImportPromise = fetchCodexInboxPayloads()
      .then((payloads) => {
        const result = importCodexInboxPayloads(payloads);
        if (!quiet && result.imported > 0) {
          showToast(
            `Imported ${result.imported} Codex entr${result.imported === 1 ? 'y' : 'ies'}.`
          );
        } else if (!quiet) {
          showToast('No new Codex entries.');
        }
        return result;
      })
      .catch((error) => {
        codexImportRuntimeStatus = {
          ...codexImportRuntimeStatus,
          pending: false,
          checkedAt: new Date().toISOString(),
          error: error && error.message ? error.message : String(error)
        };
        updateCodexIntegrationPanel();
        if (!quiet)
          showToast(`Codex import failed: ${codexImportRuntimeStatus.error}`);
        return { imported: 0, skipped: 0 };
      })
      .finally(() => {
        codexImportPromise = null;
        updateCodexIntegrationPanel();
      });
    return codexImportPromise;
  }

  function scheduleCodexAutoImport() {
    if (codexImportTimer) {
      clearInterval(codexImportTimer);
      codexImportTimer = null;
    }
    const config = getCodexIntegrationConfig();
    if (!config.enabled) {
      updateCodexIntegrationPanel();
      return;
    }
    importCodexUsage({ quiet: true });
    codexImportTimer = setInterval(() => {
      importCodexUsage({ quiet: true });
    }, CODEX_IMPORT_INTERVAL_MS);
    updateCodexIntegrationPanel();
  }

  function updateCodexIntegrationPanel() {
    const status = document.getElementById('codexIntegrationStatus');
    const summary = document.getElementById('codexIntegrationSummary');
    const publishBtn = document.getElementById('codexPublishConfigBtn');
    const importBtn = document.getElementById('codexImportNowBtn');
    const config = getCodexIntegrationConfig();
    if (publishBtn) publishBtn.disabled = !config.enabled;
    if (importBtn)
      importBtn.disabled = !config.enabled || codexImportRuntimeStatus.pending;
    if (status) {
      if (!config.enabled) {
        status.textContent = 'Codex import is OFF.';
      } else if (codexImportRuntimeStatus.pending) {
        status.textContent = 'Codex import is checking GitHub...';
      } else if (codexImportRuntimeStatus.error) {
        status.textContent = `Codex import error: ${codexImportRuntimeStatus.error}`;
      } else if (config.lastImportAt) {
        status.textContent = `Codex import ON - last checked ${formatRelativeTime(config.lastImportAt)}.`;
      } else {
        status.textContent =
          'Codex import ON - waiting for desktop inbox data.';
      }
    }
    if (!summary) return;
    summary.innerHTML = '';
    const trackedProjects = getCodexTrackedProjects();
    if (!trackedProjects.length) {
      const pill = document.createElement('span');
      pill.className = 'health-pill warn';
      pill.textContent = 'No active TimeKeeper projects';
      summary.appendChild(pill);
    }
    trackedProjects.slice(0, 6).forEach((project) => {
      const pill = document.createElement('span');
      pill.className = 'health-pill';
      pill.textContent = `GitHub/${project.name}/...`;
      summary.appendChild(pill);
    });
    if (trackedProjects.length > 6) {
      const pill = document.createElement('span');
      pill.className = 'health-pill';
      pill.textContent = `+${trackedProjects.length - 6} more projects`;
      summary.appendChild(pill);
    }
    if (config.lastImportSummary) {
      const pill = document.createElement('span');
      pill.className = 'health-pill';
      pill.textContent = `Last import: ${config.lastImportSummary.imported || 0} new, ${config.lastImportSummary.skipped || 0} skipped`;
      summary.appendChild(pill);
    }
  }

  function getFocusBlockedWebsites() {
    data.focusBlockerSites = normalizeFocusBlockedSites(
      data.focusBlockerSites,
      DEFAULT_FOCUS_BLOCKED_WEBSITES
    );
    return data.focusBlockerSites;
  }

  async function editFocusBlockedWebsites() {
    const currentSites = getFocusBlockedWebsites();
    const values = await openFormDialog({
      title: 'Blocked Websites',
      fields: [
        {
          name: 'blockedSites',
          label: 'Domains or URLs, one per line or comma-separated',
          type: 'textarea',
          rows: 9,
          value: currentSites.join('\n'),
          required: true
        }
      ],
      submitLabel: 'Save Sites'
    });
    if (!values) return;
    const normalized = normalizeFocusBlockedSites(values.blockedSites, []);
    if (!normalized.length) {
      showToast('Add at least one valid domain.');
      return;
    }
    data.focusBlockerSites = normalized;
    saveData();
    const paidFocus = getPaidFocusTotal();
    if (paidFocus > FOCUS_BLOCK_THRESHOLD) {
      focusBlockerActive = true;
      focusBlockerLastStartAt = Date.now();
      triggerFocusStart(paidFocus);
      publishFocusBridgeState(paidFocus, { force: true });
      queueFocusBlockerStatusCheck();
    }
    updateFocusStatusPanel(paidFocus);
    updateAppHealthPanel();
    showToast(`Blocked sites updated (${normalized.length}).`);
  }

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
      url.searchParams.set('blockedSites', getFocusBlockedWebsites().join(','));
      url.searchParams.set('replaceDefaultSites', '1');
      return url.toString();
    } catch (err) {
      return rawUrl;
    }
  }

  function triggerImageWebhookGet(url) {
    try {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      focusWebhookImages.add(img);
      img.src = url;
      setTimeout(() => {
        img.src = '';
        focusWebhookImages.delete(img);
      }, 5000);
    } catch (err) {
      // Hidden GET is best-effort; fetch/sendBeacon may already have worked.
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
            triggerImageWebhookGet(url);
          }
        );
      } catch (err) {
        if (navigator.sendBeacon) navigator.sendBeacon(url);
        triggerImageWebhookGet(url);
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
  let focusBlockerActive = null;
  let focusBlockerLastStartAt = 0;
  let focusBlockerStatusRequest = null;
  let focusBlockerDesktopStatus = {
    checkedAt: null,
    reachable: null,
    active: null,
    blockedSites: [],
    error: ''
  };
  function updateFocusStatusPanel(paidFocus = getPaidFocusTotal()) {
    const focusStatus = document.getElementById('runningFocusStatus');
    if (!focusStatus) return;
    focusStatus.innerHTML = '';
    const desiredActive = paidFocus > FOCUS_BLOCK_THRESHOLD;
    const desiredLabel = desiredActive
      ? focusBlockerActive === false
        ? 'start pending'
        : 'start requested'
      : 'off';
    const helperLabel =
      focusBlockerDesktopStatus.reachable === null
        ? 'not checked'
        : focusBlockerDesktopStatus.reachable
          ? focusBlockerDesktopStatus.active
            ? `active (${focusBlockerDesktopStatus.blockedSites.length} sites)`
            : 'reachable, not blocking'
          : 'not reachable';
    const details = document.createElement('details');
    details.className = 'focus-status-details';
    const summary = document.createElement('summary');
    summary.className = 'focus-status-summary';
    const title = document.createElement('span');
    title.className = 'focus-status-title';
    title.textContent = `Desktop blocker: ${helperLabel}`;
    const meta = document.createElement('span');
    meta.className = desiredActive ? 'status-warning' : 'status-muted';
    meta.textContent = `Paid focus: ${formatFocusPercent(paidFocus)} - request: ${desiredLabel}`;
    summary.appendChild(title);
    summary.appendChild(meta);
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'focus-status-body';
    const configuredSites = getFocusBlockedWebsites();
    const sitesSummary = document.createElement('span');
    sitesSummary.className = 'status-muted';
    sitesSummary.textContent = `Configured blocked sites: ${configuredSites.length}`;
    sitesSummary.title = configuredSites.join(', ');
    body.appendChild(sitesSummary);
    const bridgeConfig = getFocusBridgeConfig();
    const bridgeSummary = document.createElement('span');
    bridgeSummary.className = focusBridgeStatus.error
      ? 'status-warning'
      : 'status-muted';
    const bridgeLabel = !bridgeConfig.enabled
      ? 'off'
      : focusBridgeStatus.pending
        ? 'publishing'
        : focusBridgeStatus.error
          ? `error: ${focusBridgeStatus.error}`
          : focusBridgeStatus.publishedAt
            ? `published ${formatRelativeTime(focusBridgeStatus.publishedAt)}`
            : 'enabled';
    bridgeSummary.textContent = `Focus bridge: ${bridgeLabel}`;
    bridgeSummary.title =
      focusBridgeStatus.apiUrl || getFocusBridgeApiUrl(bridgeConfig) || '';
    body.appendChild(bridgeSummary);
    if (focusBlockerDesktopStatus.error) {
      const error = document.createElement('span');
      error.className = 'status-warning';
      error.textContent = focusBlockerDesktopStatus.error;
      body.appendChild(error);
    }
    const actions = document.createElement('div');
    actions.className = 'focus-status-actions';
    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'btn secondary';
    checkButton.textContent = 'Check Desktop Blocker';
    checkButton.addEventListener('click', () => {
      checkFocusBlockerStatus({ quiet: false });
    });
    actions.appendChild(checkButton);
    const editSitesButton = document.createElement('button');
    editSitesButton.type = 'button';
    editSitesButton.className = 'btn secondary';
    editSitesButton.textContent = 'Edit Blocked Sites';
    editSitesButton.addEventListener('click', () => {
      editFocusBlockedWebsites();
    });
    actions.appendChild(editSitesButton);
    const bridgeButton = document.createElement('button');
    bridgeButton.type = 'button';
    bridgeButton.className = 'btn secondary';
    bridgeButton.textContent = 'Focus Bridge';
    bridgeButton.title =
      'Publish focus state to GitHub so the Windows helper can poll it from this desktop.';
    bridgeButton.addEventListener('click', () => {
      editFocusBridgeSettings();
    });
    actions.appendChild(bridgeButton);
    const publishBridgeButton = document.createElement('button');
    publishBridgeButton.type = 'button';
    publishBridgeButton.className = 'btn secondary';
    publishBridgeButton.textContent = 'Publish Bridge';
    publishBridgeButton.disabled =
      !bridgeConfig.enabled || focusBridgeStatus.pending;
    publishBridgeButton.addEventListener('click', () => {
      publishFocusBridgeState(getPaidFocusTotal(), { force: true });
    });
    actions.appendChild(publishBridgeButton);
    const selfTestButton = document.createElement('button');
    selfTestButton.type = 'button';
    selfTestButton.className = 'btn secondary';
    selfTestButton.textContent = 'Self-Test Blocker';
    selfTestButton.title =
      'Temporarily writes and removes a harmless managed hosts-file block to verify desktop permissions.';
    selfTestButton.addEventListener('click', () => {
      runDesktopBlockerSelfTest({ quiet: false });
    });
    actions.appendChild(selfTestButton);
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'btn secondary';
    testButton.textContent = 'Test Blocker';
    testButton.disabled = !desiredActive;
    testButton.title = desiredActive
      ? 'Send a focus start request, then verify the desktop helper status.'
      : 'Start paid focus above 50% to test desktop blocking.';
    testButton.addEventListener('click', () => {
      const currentPaidFocus = getPaidFocusTotal();
      if (currentPaidFocus <= FOCUS_BLOCK_THRESHOLD) {
        showToast('Start paid focus above 50% before testing the blocker.');
        return;
      }
      triggerFocusStart(currentPaidFocus);
      publishFocusBridgeState(currentPaidFocus, { force: true });
      window.setTimeout(() => {
        checkFocusBlockerStatus({ quiet: false });
      }, 800);
    });
    actions.appendChild(testButton);
    body.appendChild(actions);
    details.appendChild(body);
    focusStatus.appendChild(details);
  }

  async function checkFocusBlockerStatus({ quiet = true } = {}) {
    if (focusBlockerStatusRequest) return focusBlockerStatusRequest;
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), FOCUS_STATUS_TIMEOUT_MS)
      : null;
    focusBlockerDesktopStatus = {
      ...focusBlockerDesktopStatus,
      error: '',
      pending: true
    };
    updateFocusStatusPanel();
    focusBlockerStatusRequest = fetch(FOCUS_STATUS_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Desktop helper returned ${response.status}.`);
        }
        const payload = await response.json();
        focusBlockerDesktopStatus = {
          checkedAt: new Date().toISOString(),
          reachable: true,
          active: payload && payload.active === true,
          blockedSites: Array.isArray(payload?.blockedSites)
            ? payload.blockedSites
            : [],
          error: ''
        };
        if (!quiet) {
          showToast(
            focusBlockerDesktopStatus.active
              ? 'Desktop blocker is active.'
              : 'Desktop helper is reachable but not currently blocking.'
          );
        }
        return focusBlockerDesktopStatus;
      })
      .catch(() => {
        focusBlockerDesktopStatus = {
          checkedAt: new Date().toISOString(),
          reachable: false,
          active: false,
          blockedSites: [],
          error:
            'Desktop helper not reachable. Start the focus blocker scheduled task or run npm run focus:blocker as Administrator.'
        };
        if (!quiet) {
          showToast(focusBlockerDesktopStatus.error);
        }
        return focusBlockerDesktopStatus;
      })
      .finally(() => {
        if (timeoutId) window.clearTimeout(timeoutId);
        focusBlockerStatusRequest = null;
        updateFocusStatusPanel();
        updateAppHealthPanel();
      });
    return focusBlockerStatusRequest;
  }

  async function runDesktopBlockerSelfTest({ quiet = false } = {}) {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), FOCUS_STATUS_TIMEOUT_MS)
      : null;
    try {
      const response = await fetch(FOCUS_SELF_TEST_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(
          payload?.error || `Desktop helper returned ${response.status}.`
        );
      }
      focusBlockerDesktopStatus = {
        checkedAt: new Date().toISOString(),
        reachable: true,
        active: payload.restoredActive === true,
        blockedSites: Array.isArray(payload.restoredBlockedSites)
          ? payload.restoredBlockedSites
          : [],
        error: ''
      };
      if (!quiet) {
        showToast('Desktop blocker self-test passed.');
      }
      updateFocusStatusPanel();
      updateAppHealthPanel();
      return payload;
    } catch (error) {
      focusBlockerDesktopStatus = {
        checkedAt: new Date().toISOString(),
        reachable: false,
        active: false,
        blockedSites: [],
        error:
          error && error.message
            ? error.message
            : 'Desktop blocker self-test failed.'
      };
      if (!quiet) {
        showToast(
          `Desktop blocker self-test failed: ${focusBlockerDesktopStatus.error}`
        );
      }
      updateFocusStatusPanel();
      updateAppHealthPanel();
      return null;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  function makeHealthBadge(label, tone = 'amber') {
    const badge = document.createElement('span');
    badge.className = `status-badge ${tone}`;
    badge.textContent = label;
    return badge;
  }

  function getStoredDataSizeLabel() {
    try {
      const raw = localStorage.getItem('timekeeperDataPro') || '';
      if (!raw) return 'empty';
      const bytes = new Blob([raw]).size;
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    } catch {
      return 'unknown size';
    }
  }

  function getAppHealthItems() {
    const localAudit = getLocalDataAudit();
    const localDataHasRepairableIssues = localAudit.repairableCount > 0;
    const localDataNeedsReview =
      !localDataHasRepairableIssues && localAudit.staleRunningEntries > 0;
    const localDataStatus = localDataHasRepairableIssues
      ? 'Issues'
      : localDataNeedsReview
        ? 'Review'
        : 'Saved';
    const localDataTone = localDataHasRepairableIssues
      ? 'red'
      : localDataNeedsReview
        ? 'amber'
        : 'green';
    const localDataDetail =
      `${data.projects.length} projects, ${data.entries.length} entries, revision ${Number(data.backupRevision) || 0}, ${getStoredDataSizeLabel()}.` +
      (localAudit.totalIssues ? ` ${localAudit.issueParts.join('; ')}.` : '');
    const localDataActions = [];
    if (localDataHasRepairableIssues) {
      localDataActions.push({
        label: 'Repair Data',
        onClick: () => repairLocalData()
      });
    }
    if (localAudit.staleRunningEntries > 0) {
      localDataActions.push({
        label: 'Review Timers',
        onClick: () => activateSection('timer')
      });
    }
    const backupName = backupDirHandle
      ? backupDirHandle.name || data.backupDirName || ''
      : data.backupDirName || '';
    const updatedAt = data.updatedAt ? new Date(data.updatedAt) : null;
    const backupAt = data.lastBackupAt ? new Date(data.lastBackupAt) : null;
    const verifiedAt = data.lastBackupVerifiedAt
      ? new Date(data.lastBackupVerifiedAt)
      : null;
    const hasVerifiedBackup = verifiedAt && !Number.isNaN(verifiedAt.getTime());
    const backupIsStale =
      needsBackup ||
      (updatedAt &&
        !Number.isNaN(updatedAt.getTime()) &&
        (!backupAt ||
          Number.isNaN(backupAt.getTime()) ||
          updatedAt.getTime() > backupAt.getTime()));
    const folderAccessSupported = !!window.showDirectoryPicker;
    let backupLabel = 'Off';
    let backupTone = 'amber';
    let backupDetail = 'Choose a cloud-synced folder for automatic backups.';
    if (backupConflict) {
      backupLabel = 'Conflict';
      backupTone = 'red';
      backupDetail = formatBackupConflictWarning(backupConflict);
    } else if (!folderAccessSupported) {
      backupLabel = 'Manual';
      backupDetail = 'Folder auto-sync is unavailable in this browser.';
    } else if (autoSyncEnabled && backupDirHandle) {
      if (backupPermissionState === 'granted') {
        backupLabel = backupIsStale ? 'Pending' : 'Synced';
        backupTone = backupIsStale ? 'amber' : 'green';
        backupDetail = data.lastBackupAt
          ? `Last backup ${formatRelativeTime(data.lastBackupAt)}${backupName ? ` to ${backupName}` : ''}.`
          : 'Backup is enabled; first write is pending.';
        if (hasVerifiedBackup) {
          backupDetail += ` Verified ${formatRelativeTime(data.lastBackupVerifiedAt)}.`;
        }
      } else {
        backupLabel = 'Needs access';
        backupTone = 'red';
        backupDetail = backupName
          ? `Re-authorize ${backupName} to resume backups.`
          : 'Re-authorize the backup folder to resume backups.';
      }
    } else if (backupDirHandle && backupPermissionState === 'granted') {
      backupLabel = 'Ready';
      backupTone = 'amber';
      backupDetail = backupName
        ? `${backupName} is selected, but auto-sync is off.`
        : 'A backup folder is selected, but auto-sync is off.';
    } else if (autoSyncEnabled) {
      backupLabel = 'Broken';
      backupTone = 'red';
      backupDetail = 'Auto-sync is on, but no writable backup folder is ready.';
    }

    const snapshotLabel = data.lastBackupSnapshotAt ? 'Current' : 'Missing';
    const snapshotTone = data.lastBackupSnapshotAt ? 'green' : 'amber';
    const snapshotDetail = data.lastBackupSnapshotAt
      ? `Latest snapshot ${formatRelativeTime(data.lastBackupSnapshotAt)}.`
      : 'No timestamped snapshot has been written yet.';

    const cachedPayload = getCachedStravaFeedPayload();
    const stravaCount = cachedStravaActivities.length;
    const stravaUpdated =
      cachedPayload && cachedPayload.updated_utc
        ? formatRelativeTime(cachedPayload.updated_utc)
        : '';
    const stravaError =
      cachedPayload && typeof cachedPayload.error === 'string'
        ? cachedPayload.error.trim()
        : '';
    const stravaLabel =
      stravaCount > 0 ? (stravaError ? 'Stale' : 'Loaded') : 'Empty';
    const stravaTone =
      stravaCount > 0 ? (stravaError ? 'amber' : 'green') : 'red';
    const stravaDetail =
      stravaCount > 0
        ? `${stravaCount} activities${stravaUpdated ? `, updated ${stravaUpdated}` : ''}${stravaError ? `; latest refresh failed: ${stravaError}` : ''}.`
        : 'Import a Strava export or publish assets/strava.json.';

    const paidFocus = getPaidFocusTotal();
    const desiredFocusBlock = paidFocus > FOCUS_BLOCK_THRESHOLD;
    const helperChecked = !!focusBlockerDesktopStatus.checkedAt;
    let blockerLabel = 'Idle';
    let blockerTone = 'green';
    let blockerDetail = `Paid focus ${formatFocusPercent(paidFocus)}.`;
    if (desiredFocusBlock) {
      if (
        focusBlockerDesktopStatus.reachable &&
        focusBlockerDesktopStatus.active
      ) {
        blockerLabel = 'Active';
        blockerTone = 'green';
        blockerDetail = `Blocking ${focusBlockerDesktopStatus.blockedSites.length} sites at ${formatFocusPercent(paidFocus)} paid focus.`;
      } else if (focusBlockerDesktopStatus.reachable === false) {
        blockerLabel = 'Offline';
        blockerTone = 'red';
        blockerDetail = focusBlockerDesktopStatus.error;
      } else if (
        focusBlockerDesktopStatus.reachable &&
        !focusBlockerDesktopStatus.active
      ) {
        blockerLabel = 'Not blocking';
        blockerTone = 'red';
        blockerDetail = `Helper is reachable but not active at ${formatFocusPercent(paidFocus)} paid focus.`;
      } else {
        blockerLabel = 'Check';
        blockerTone = 'amber';
        blockerDetail = `Paid focus ${formatFocusPercent(paidFocus)} should activate the desktop blocker.`;
      }
    } else if (focusBlockerDesktopStatus.active) {
      blockerLabel = 'Unexpected';
      blockerTone = 'red';
      blockerDetail = `Desktop helper still reports active while paid focus is ${formatFocusPercent(paidFocus)}.`;
    } else if (helperChecked) {
      blockerDetail = focusBlockerDesktopStatus.reachable
        ? `Helper checked ${formatRelativeTime(focusBlockerDesktopStatus.checkedAt)}.`
        : focusBlockerDesktopStatus.error;
      blockerTone = focusBlockerDesktopStatus.reachable ? 'green' : 'amber';
    }

    const bridgeConfig = getFocusBridgeConfig();
    let bridgeLabel = 'Off';
    let bridgeTone = 'amber';
    let bridgeDetail =
      'Enable the GitHub focus bridge when Android/GitHub Pages should control this desktop.';
    if (bridgeConfig.enabled) {
      bridgeLabel = 'Ready';
      bridgeDetail =
        focusBridgeStatus.apiUrl || getFocusBridgeApiUrl(bridgeConfig);
      if (focusBridgeStatus.pending) {
        bridgeLabel = 'Publishing';
        bridgeTone = 'amber';
      } else if (focusBridgeStatus.error) {
        bridgeLabel = 'Error';
        bridgeTone = 'red';
        bridgeDetail = focusBridgeStatus.error;
      } else if (focusBridgeStatus.publishedAt) {
        bridgeLabel = 'Published';
        bridgeTone = 'green';
        bridgeDetail = `Last published ${formatRelativeTime(focusBridgeStatus.publishedAt)}. Desktop helper should poll ${focusBridgeStatus.apiUrl || getFocusBridgeApiUrl(bridgeConfig)}.`;
      }
    }

    let offlineLabel = 'Pending';
    let offlineTone = 'amber';
    let offlineDetail = 'Offline app cache is not ready yet.';
    if (offlineShellStatus === 'active') {
      offlineLabel = 'Ready';
      offlineTone = 'green';
      offlineDetail =
        'Installed app shell is controlled by the service worker.';
    } else if (offlineShellStatus === 'ready-after-reload') {
      offlineLabel = 'Ready';
      offlineTone = 'amber';
      offlineDetail =
        'Offline cache is installed and will control the next reload.';
    } else if (offlineShellStatus === 'unsupported') {
      offlineLabel = 'Unavailable';
      offlineDetail =
        'Open the app over HTTP(S) in a service-worker capable browser.';
    } else if (offlineShellStatus === 'failed') {
      offlineLabel = 'Failed';
      offlineTone = 'red';
      offlineDetail =
        offlineShellError || 'Service worker registration failed.';
    } else if (offlineShellStatus === 'registering') {
      offlineLabel = 'Installing';
      offlineDetail = 'Offline app cache registration is in progress.';
    }

    return [
      {
        label: 'Local Data',
        status: localDataStatus,
        tone: localDataTone,
        detail: localDataDetail,
        actions: localDataActions
      },
      {
        label: 'Backup Sync',
        status: backupLabel,
        tone: backupTone,
        detail: backupDetail,
        actions: [
          {
            label: 'Verify',
            onClick: () => verifyBackupRoundTrip()
          }
        ]
      },
      {
        label: 'Snapshots',
        status: snapshotLabel,
        tone: snapshotTone,
        detail: snapshotDetail
      },
      {
        label: 'Strava Feed',
        status: stravaLabel,
        tone: stravaTone,
        detail: stravaDetail
      },
      {
        label: 'Desktop Blocker',
        status: blockerLabel,
        tone: blockerTone,
        detail: blockerDetail,
        actions: [
          {
            label: 'Check Blocker',
            onClick: () => checkFocusBlockerStatus({ quiet: false })
          },
          {
            label: 'Self-Test',
            onClick: () => runDesktopBlockerSelfTest({ quiet: false })
          }
        ]
      },
      {
        label: 'Focus Bridge',
        status: bridgeLabel,
        tone: bridgeTone,
        detail: bridgeDetail,
        actions: [
          {
            label: 'Configure',
            onClick: () => editFocusBridgeSettings()
          },
          {
            label: 'Publish',
            onClick: () =>
              publishFocusBridgeState(getPaidFocusTotal(), { force: true })
          }
        ]
      },
      {
        label: 'Offline App',
        status: offlineLabel,
        tone: offlineTone,
        detail: offlineDetail
      }
    ];
  }

  function updateAppHealthPanel() {
    const panel = document.getElementById('appHealthPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const items = getAppHealthItems();
    const needsAttention = items.filter((item) => item.tone !== 'green');
    const details = document.createElement('details');
    details.className = 'app-health-details';
    const summary = document.createElement('summary');
    summary.className = 'app-health-summary';
    const heading = document.createElement('span');
    heading.className = 'app-health-summary-title';
    heading.textContent = 'App Health';
    const summaryText = document.createElement('span');
    summaryText.className = 'app-health-summary-text';
    summaryText.textContent = needsAttention.length
      ? `${needsAttention.length} check${needsAttention.length === 1 ? '' : 's'} need attention`
      : 'All checks OK';
    summary.appendChild(heading);
    summary.appendChild(summaryText);
    details.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'app-health-grid';
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'app-health-item';
      const copy = document.createElement('div');
      copy.className = 'app-health-copy';
      const label = document.createElement('div');
      label.className = 'app-health-label';
      label.textContent = item.label;
      const detail = document.createElement('div');
      detail.className = 'app-health-detail';
      detail.textContent = item.detail;
      copy.appendChild(label);
      copy.appendChild(detail);
      row.appendChild(copy);
      row.appendChild(makeHealthBadge(item.status, item.tone));
      if (Array.isArray(item.actions) && item.actions.length) {
        const actions = document.createElement('div');
        actions.className = 'app-health-actions';
        item.actions.forEach((actionDef) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn secondary';
          button.textContent = actionDef.label;
          button.addEventListener('click', actionDef.onClick);
          actions.appendChild(button);
        });
        row.appendChild(actions);
      }
      grid.appendChild(row);
    });
    details.appendChild(grid);
    panel.appendChild(details);
  }

  function queueFocusBlockerStatusCheck() {
    window.setTimeout(() => {
      checkFocusBlockerStatus({ quiet: true });
    }, 800);
  }

  function updateFocusBlocker() {
    const total = getPaidFocusTotal();
    // Activate blocker if we cross the 50% threshold, deactivate if we drop below or equal.
    // The webhook receives the paid focus total and the website block list so the local
    // blocker can deny distracting domains while focused paid work is active.
    const shouldHeartbeat =
      focusBlockerActive === true &&
      total > FOCUS_BLOCK_THRESHOLD &&
      Date.now() - focusBlockerLastStartAt >= FOCUS_BLOCKER_HEARTBEAT_MS;
    const shouldStopHeartbeat =
      focusBlockerActive === false &&
      total <= FOCUS_BLOCK_THRESHOLD &&
      Date.now() - focusBlockerLastStartAt >= FOCUS_BLOCKER_HEARTBEAT_MS;
    if (
      (focusBlockerActive !== true && total > FOCUS_BLOCK_THRESHOLD) ||
      shouldHeartbeat
    ) {
      const forceBridgePublish = focusBlockerActive !== true;
      focusBlockerActive = true;
      focusBlockerLastStartAt = Date.now();
      triggerFocusStart(total);
      publishFocusBridgeState(total, { force: forceBridgePublish });
      queueFocusBlockerStatusCheck();
    } else if (
      (focusBlockerActive !== false && total <= FOCUS_BLOCK_THRESHOLD) ||
      shouldStopHeartbeat
    ) {
      const forceBridgePublish = focusBlockerActive !== false;
      focusBlockerActive = false;
      focusBlockerLastStartAt = Date.now();
      triggerFocusStop(total);
      publishFocusBridgeState(total, { force: forceBridgePublish });
      queueFocusBlockerStatusCheck();
    }
    updateFocusStatusPanel(total);
    updateAppHealthPanel();
  }
  setInterval(updateFocusBlocker, FOCUS_BLOCKER_HEARTBEAT_MS);

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
      const prefix = value >= 0 ? '+' : '-';
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
        currentMultiplier.toFixed(2) + 'x',
        'Weekly budget ' + formatAmount(currentBudget)
      );
      const projectedDelta = projectedBudget - weeklyBaseBudget;
      createRow(
        'Projected (if week ended today)',
        projectedMultiplier.toFixed(2) + 'x',
        `${formatSignedCurrency(projectedDelta)} | ${formatSignedCredits(projectedCredits)}`
      );
      const nextDelta = nextBudget - weeklyBaseBudget;
      let nextSub = formatSignedCurrency(nextDelta);
      if (lastWeek) {
        if (lastWeek.paused) {
          nextSub += ' | Last week paused';
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
          nextSub += ` | Last week ${scheduledLabel} scheduled`;
          if (lastExpected !== null) {
            nextSub += ` (baseline ${formatPoints(lastExpected)} pts)`;
          }
          if (
            Number.isFinite(lastWeek.scheduleDeltaEnd) &&
            Math.abs(lastWeek.scheduleDeltaEnd) >= 1
          ) {
            nextSub +=
              lastWeek.scheduleDeltaEnd >= 0
                ? ` | Ahead by ${formatPoints(lastWeek.scheduleDeltaEnd)} pts overall`
                : ` | Behind by ${formatPoints(Math.abs(lastWeek.scheduleDeltaEnd))} pts overall`;
          }
          if (
            Number.isFinite(lastWeek.creditsEarned) &&
            lastWeek.creditsEarned !== 0
          ) {
            nextSub += ' | ' + formatSignedCredits(lastWeek.creditsEarned);
          }
        }
      }
      if (pausedThisWeek) {
        nextSub += ' | This week paused';
      }
      createRow('Next week (locked)', nextMultiplier.toFixed(2) + 'x', nextSub);

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
      createRow('Workout plan', planValue, planSubParts.join(' | '));

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
      const pointsSub = pointsSubParts.join(' | ');
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
          ? intensityParts.join(' | ')
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
          'Streak ' +
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
      const nextAction = document.createElement('div');
      nextAction.className = `mobile-next-action${pausedThisWeek ? ' muted' : workoutPlan.scheduleDelta <= -1 ? ' risk' : ''}`;
      if (pausedThisWeek) {
        nextAction.textContent =
          'Next: week paused, no workout points required.';
      } else if (workoutPlan.requiredPoints > workoutPlan.actualPoints) {
        nextAction.textContent = `Next: log ${formatPoints(
          Math.max(0, workoutPlan.requiredPoints - workoutPlan.actualPoints)
        )} pts to hit this week's scheduled target.`;
      } else {
        nextAction.textContent =
          'Next: target covered; optional workouts improve next week and credits.';
      }
      fragment.appendChild(nextAction);
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
          'Unlocked - waiting for weekend (+' + boostPercent + '%)';
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
    const weeklyStravaEntries = applyStravaExertionOverrides(
      Array.isArray(window.stravaActivitiesCache)
        ? window.stravaActivitiesCache
        : []
    )
      .filter((activity) => {
        if (!activity || !activity.start_date) return false;
        const dt = new Date(activity.start_date);
        return !isNaN(dt) && dt >= monday && dt < nextMonday;
      })
      .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
    const weeklyActivityRows = [
      ...weeklyEntries.map((entry) => ({
        source: 'manual',
        timestamp: entry.timestamp,
        entry
      })),
      ...weeklyStravaEntries.map((activity) => ({
        source: 'strava',
        timestamp: activity.start_date,
        activity
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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
          const name = document.createElement('strong');
          name.textContent = preset.name;
          info.appendChild(name);
          info.appendChild(
            document.createTextNode(
              ` - ${getIntensitySummary(preset.intensity)}`
            )
          );
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
          editBtn.addEventListener('click', async () => {
            const values = await openFormDialog({
              title: 'Edit Workout Preset',
              fields: [
                {
                  name: 'name',
                  label: 'Preset Name',
                  value: preset.name || '',
                  required: true
                },
                {
                  name: 'intensity',
                  label: 'Intensity',
                  type: 'select',
                  value: normalizeIntensity(preset.intensity),
                  options: getWorkoutIntensityOptions(preset.intensity)
                }
              ],
              submitLabel: 'Save Preset'
            });
            if (!values) return;
            const trimmed = values.name.trim();
            if (!trimmed) {
              showToast('Preset name cannot be empty.');
              return;
            }
            const normalized = parseWorkoutIntensityInput(values.intensity);
            if (!normalized) {
              showToast('Choose a valid workout intensity.');
              return;
            }
            const snapshot = cloneData();
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
            offerUndo('Workout preset updated.', snapshot);
          });
          actions.appendChild(editBtn);
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.fontSize = '0.75rem';
          deleteBtn.addEventListener('click', async () => {
            const ok = await requestConfirm({
              title: 'Delete Preset',
              message: 'Delete this preset? Existing entries stay recorded.',
              confirmLabel: 'Delete',
              danger: true
            });
            if (!ok) return;
            const snapshot = cloneData();
            deleteWorkoutPreset(preset.id);
            saveData();
            updateFitnessCards();
            updateTodoSection();
            offerUndo('Workout preset deleted.', snapshot);
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
      const totalWorkoutCount = weeklyActivityRows.length;
      if (weeklyPlan.paused) {
        headerInfo.textContent = `This week: ${totalWorkoutCount} workout${totalWorkoutCount === 1 ? '' : 's'} | Week paused`;
      } else {
        headerInfo.textContent = `This week: ${totalWorkoutCount} workout${totalWorkoutCount === 1 ? '' : 's'} | ${formatPoints(weeklyPlan.actualPoints)} / ${formatPoints(weeklyPlan.requiredPoints)} pts scheduled`;
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
      if (weeklyActivityRows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = pausedThisWeek
          ? 'Week paused - no workouts required.'
          : 'No workouts logged yet this week.';
        entriesContent.appendChild(empty);
      } else {
        weeklyActivityRows.forEach((activityRow) => {
          if (activityRow.source === 'strava') {
            const activity = activityRow.activity;
            const row = document.createElement('div');
            row.className = 'workout-entry-row';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.borderBottom = '1px solid #e2e8f0';
            row.style.padding = '0.5rem 0';
            const info = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = activity.name || 'Strava activity';
            info.appendChild(name);
            const score = resolveStravaExertion(
              activity,
              cachedStravaScoreScale
            );
            const details = [
              'Strava',
              activity.type || 'Activity',
              score === null ? 'Unscored' : `${formatExertion(score)} pts`,
              formatWorkoutTimestamp(activity.start_date)
            ].filter(Boolean);
            info.appendChild(
              document.createTextNode(` - ${details.join(' - ')}`)
            );
            row.appendChild(info);
            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '0.4rem';
            const activityUrl = safeExternalUrl(activity.url);
            if (activityUrl) {
              const openLink = document.createElement('a');
              openLink.className = 'btn secondary';
              openLink.textContent = 'Open';
              openLink.href = activityUrl;
              openLink.target = '_blank';
              openLink.rel = 'noopener noreferrer';
              openLink.style.fontSize = '0.75rem';
              actions.appendChild(openLink);
            }
            row.appendChild(actions);
            entriesContent.appendChild(row);
            return;
          }
          const entry = activityRow.entry;
          const row = document.createElement('div');
          row.className = 'workout-entry-row';
          row.style.display = 'flex';
          row.style.justifyContent = 'space-between';
          row.style.alignItems = 'center';
          row.style.borderBottom = '1px solid #e2e8f0';
          row.style.padding = '0.5rem 0';
          const info = document.createElement('div');
          const name = document.createElement('strong');
          name.textContent = entry.name;
          info.appendChild(name);
          info.appendChild(
            document.createTextNode(
              ` - ${getIntensitySummary(entry.intensity)} - ${formatWorkoutTimestamp(entry.timestamp)}`
            )
          );
          row.appendChild(info);
          const actions = document.createElement('div');
          actions.style.display = 'flex';
          actions.style.gap = '0.4rem';
          const editBtn = document.createElement('button');
          editBtn.className = 'btn secondary';
          editBtn.textContent = 'Edit';
          editBtn.style.fontSize = '0.75rem';
          editBtn.addEventListener('click', async () => {
            const normalizedIntensity = normalizeIntensity(entry.intensity);
            const customPoints = parseCustomIntensity(normalizedIntensity);
            const values = await openFormDialog({
              title: 'Edit Workout',
              fields: [
                {
                  name: 'name',
                  label: 'Workout Name',
                  value: entry.name || '',
                  required: true
                },
                {
                  name: 'intensity',
                  label: 'Intensity',
                  type: 'select',
                  value: customPoints === null ? normalizedIntensity : 'custom',
                  options: [
                    { value: 'intense', label: 'Intense' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'light', label: 'Light' },
                    { value: 'custom', label: 'Custom points' }
                  ]
                },
                {
                  name: 'customPoints',
                  label: 'Custom Points',
                  type: 'number',
                  min: 0.01,
                  step: 0.01,
                  value:
                    customPoints === null
                      ? ''
                      : formatCustomIntensityValue(customPoints),
                  visibleWhen: (controls) =>
                    controls.intensity && controls.intensity.value === 'custom'
                },
                {
                  name: 'timestamp',
                  label: 'When',
                  type: 'datetime-local',
                  value: formatTimestampForInput(entry.timestamp),
                  required: true
                }
              ],
              submitLabel: 'Save Workout'
            });
            if (!values) return;
            const trimmed = values.name.trim();
            if (!trimmed) {
              showToast('Workout name cannot be empty.');
              return;
            }
            let newIntensity = values.intensity;
            if (newIntensity === 'custom') {
              const customValue = sanitizeCustomPoints(values.customPoints);
              if (customValue === null) {
                showToast('Enter valid custom workout points.');
                return;
              }
              newIntensity = makeCustomIntensity(customValue);
            }
            const parsed = parseDateTimeInput(values.timestamp);
            if (!parsed) {
              showToast('Invalid date or time.');
              return;
            }
            const snapshot = cloneData();
            updateWorkoutEntry(entry.id, {
              name: trimmed,
              intensity: newIntensity,
              timestamp: parsed.toISOString()
            });
            offerUndo('Workout updated.', snapshot);
          });
          actions.appendChild(editBtn);
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.fontSize = '0.75rem';
          deleteBtn.addEventListener('click', async () => {
            const ok = await requestConfirm({
              title: 'Delete Workout',
              message: 'Delete this workout entry?',
              confirmLabel: 'Delete',
              danger: true
            });
            if (!ok) return;
            const snapshot = cloneData();
            deleteWorkoutEntry(entry.id);
            offerUndo('Workout deleted.', snapshot);
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
        info.textContent = `${payment.name || 'Recurring payment'} - ${amountLabel}`;
        li.appendChild(info);

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '0.4rem';

        const editBtn = document.createElement('button');
        editBtn.className = 'btn secondary';
        editBtn.style.fontSize = '0.7rem';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', async () => {
          const values = await openFormDialog({
            title: 'Edit Recurring Payment',
            fields: [
              {
                name: 'name',
                label: 'Payment Name',
                value: payment.name || '',
                required: true
              },
              {
                name: 'amount',
                label: 'Monthly Amount (SEK)',
                type: 'number',
                min: 0,
                step: 0.01,
                value: payment.amount || 0,
                required: true
              }
            ],
            submitLabel: 'Save Payment'
          });
          if (!values) return;
          const trimmedName = values.name.trim();
          if (!trimmedName) {
            showToast('Payment name cannot be empty.');
            return;
          }
          const newAmount = parseFloat(values.amount);
          if (!Number.isFinite(newAmount) || newAmount < 0) {
            showToast('Enter a valid amount.');
            return;
          }
          const snapshot = cloneData();
          payment.name = trimmedName;
          payment.amount = newAmount;
          saveData();
          updateGrocerySection();
          offerUndo('Recurring payment updated.', snapshot);
        });
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn danger';
        deleteBtn.style.fontSize = '0.7rem';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
          const ok = await requestConfirm({
            title: 'Remove Payment',
            message: 'Remove this recurring payment?',
            confirmLabel: 'Remove',
            danger: true
          });
          if (!ok) return;
          const snapshot = cloneData();
          data.monthlyRecurringPayments = data.monthlyRecurringPayments.filter(
            (p) => p.id !== payment.id
          );
          saveData();
          updateGrocerySection();
          offerUndo('Recurring payment removed.', snapshot);
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
        // Details span: name - cost - frequency - purchase date
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
            creditNote += `, credits -${formatCurrency(appliedCreditsNum, -1).replace(' kr', ' SEK')}`;
          }
          parts.push(creditNote);
        }
        const freqLabel = freq.charAt(0).toUpperCase() + freq.slice(1);
        parts.push(freqLabel);
        if (dateStr) parts.push(dateStr);
        detailsSpan.textContent = parts.join(' - ');
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
        editArchBtn.addEventListener('click', async () => {
          const values = await openFormDialog({
            title: 'Edit Purchase',
            fields: [
              {
                name: 'cost',
                label: 'Cost (SEK)',
                type: 'number',
                min: 0,
                step: 0.01,
                value: archItem.cost || 0,
                required: true
              }
            ],
            submitLabel: 'Save Purchase'
          });
          if (!values) return;
          const newCostVal = parseFloat(values.cost);
          if (!Number.isFinite(newCostVal) || newCostVal < 0) {
            showToast('Enter a valid cost.');
            return;
          }
          const snapshot = cloneData();
          archItem.cost = newCostVal;
          // Update purchase date to now if none exists
          if (!archItem.purchasedDate) {
            archItem.purchasedDate = new Date().toISOString();
          }
          saveData();
          updateGrocerySection();
          offerUndo('Purchase updated.', snapshot);
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
        deleteArchBtn.addEventListener('click', async () => {
          const ok = await requestConfirm({
            title: 'Delete Purchase',
            message: 'Delete this archived purchase?',
            confirmLabel: 'Delete',
            danger: true
          });
          if (!ok) return;
          const snapshot = cloneData();
          data.groceries.splice(archIndex, 1);
          saveData();
          updateGrocerySection();
          offerUndo('Archived purchase deleted.', snapshot);
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
    const budgetNextAction = document.createElement('div');
    const weeklyRemaining = Math.max(0, weeklyDynamicBudget - weeklySpent);
    budgetNextAction.className = `mobile-next-action${
      weeklyRemaining <= 0
        ? ' risk'
        : weeklySpent > weeklyExpectedSpent
          ? ' warm'
          : ''
    }`;
    budgetNextAction.textContent = `Next: ${formatSek(
      weeklyRemaining
    )} left this week; ${weeklySpent > weeklyExpectedSpent ? 'spending is ahead of expected pace' : 'spending is within expected pace'}.`;
    summaryCard.appendChild(budgetNextAction);
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
      'x (' +
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
    editBudgetsBtn.addEventListener('click', async () => {
      const values = await openFormDialog({
        title: 'Edit Grocery Budgets',
        fields: [
          {
            name: 'weekly',
            label: 'Weekly Budget (SEK)',
            type: 'number',
            min: 0,
            step: 1,
            value: data.groceryBudgetWeekly || 0
          },
          {
            name: 'monthly',
            label: 'Monthly Budget (SEK)',
            type: 'number',
            min: 0,
            step: 1,
            value: data.groceryBudgetMonthly || 0
          },
          {
            name: 'biannual',
            label: 'Biannual Budget (SEK)',
            type: 'number',
            min: 0,
            step: 1,
            value: data.groceryBudgetBiYearly || 0
          }
        ],
        submitLabel: 'Save Budgets'
      });
      if (!values) return;
      const weekly = parseFloat(values.weekly);
      const monthly = parseFloat(values.monthly);
      const biannual = parseFloat(values.biannual);
      if (
        !Number.isFinite(weekly) ||
        weekly < 0 ||
        !Number.isFinite(monthly) ||
        monthly < 0 ||
        !Number.isFinite(biannual) ||
        biannual < 0
      ) {
        showToast('Enter valid non-negative budgets.');
        return;
      }
      const snapshot = cloneData();
      data.groceryBudgetWeekly = weekly;
      data.groceryBudgetMonthly = monthly;
      data.groceryBudgetBiYearly = biannual;
      saveData();
      updateGrocerySection();
      offerUndo('Grocery budgets updated.', snapshot);
    });
    controlsDiv.appendChild(editBudgetsBtn);
    // Edit start date button
    const editStartBtn = document.createElement('button');
    editStartBtn.className = 'btn secondary';
    editStartBtn.style.fontSize = '0.75rem';
    editStartBtn.textContent = 'Set Start Date';
    editStartBtn.addEventListener('click', async () => {
      const values = await openFormDialog({
        title: 'Set Budget Start Date',
        fields: [
          {
            name: 'startDate',
            label: 'Start Date',
            type: 'date',
            value: data.groceryBudgetStartDate || '',
            required: true
          }
        ],
        submitLabel: 'Save Date'
      });
      if (!values) return;
      const parsed = parseLocalDateString(values.startDate);
      if (!parsed) {
        showToast('Enter a valid start date.');
        return;
      }
      const normalized = formatLocalDateString(parsed);
      if (data.groceryBudgetStartDate !== normalized) {
        const snapshot = cloneData();
        data.groceryBudgetStartDate = normalized;
        saveData();
        offerUndo('Budget start date updated.', snapshot);
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
      buyBtn.addEventListener('click', async () => {
        const values = await openFormDialog({
          title: 'Log Purchase',
          fields: [
            {
              name: 'cost',
              label: 'Cost (SEK)',
              type: 'number',
              min: 0,
              step: 0.01,
              value: 0,
              required: true
            }
          ],
          submitLabel: 'Buy'
        });
        if (!values) return;
        const parsedCost = parseFloat(values.cost);
        if (!Number.isFinite(parsedCost) || parsedCost < 0) {
          showToast('Enter a valid cost.');
          return;
        }
        logGroceryPurchase(item, parsedCost);
      });
      btnGroup.appendChild(buyBtn);
      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'btn secondary';
      editBtn.textContent = 'Edit';
      editBtn.style.fontSize = '0.7rem';
      editBtn.addEventListener('click', async () => {
        const values = await openFormDialog({
          title: 'Edit Grocery Item',
          fields: [
            {
              name: 'name',
              label: 'Item Name',
              value: item.name || '',
              required: true
            },
            {
              name: 'frequency',
              label: 'Frequency',
              type: 'select',
              value: freq,
              options: [
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'biannual', label: 'Biannual' }
              ]
            },
            {
              name: 'category',
              label: 'Category',
              type: 'select',
              value: item.category || 'standard',
              options: [
                { value: 'standard', label: 'Standard' },
                { value: 'treat', label: 'Treat' },
                { value: 'essential', label: 'Essential' }
              ]
            }
          ],
          submitLabel: 'Save Item'
        });
        if (!values) return;
        const trimmedName = values.name.trim();
        if (!trimmedName) {
          showToast('Item name is required.');
          return;
        }
        const snapshot = cloneData();
        item.name = trimmedName;
        item.frequency = ['weekly', 'monthly', 'biannual'].includes(
          values.frequency
        )
          ? values.frequency
          : 'weekly';
        item.category = ['standard', 'treat', 'essential'].includes(
          values.category
        )
          ? values.category
          : 'standard';
        saveData();
        updateGrocerySection();
        offerUndo('Grocery item updated.', snapshot);
      });
      btnGroup.appendChild(editBtn);
      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = 'Delete';
      delBtn.style.fontSize = '0.7rem';
      delBtn.addEventListener('click', async () => {
        const ok = await requestConfirm({
          title: 'Delete Grocery Item',
          message: 'Delete this grocery item?',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        const snapshot = cloneData();
        data.groceries.splice(index, 1);
        saveData();
        updateGrocerySection();
        offerUndo('Grocery item deleted.', snapshot);
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
            'Weekend Boost applied: -' + boostPercentDisplay + '% from credits';
        } else if (boostUnlocked) {
          note.textContent =
            'Weekend Boost unlocked: +' +
            boostPercentDisplay +
            '% on Treats this weekend';
        } else {
          note.textContent =
            'Treat item - unlock +' + boostPercentDisplay + '% by Friday 18:00';
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
      meta.textContent = `Used ${usedHoursNow.toFixed(1)}h / ${project.budgetHours.toFixed(1)}h | Expected by now ${expectedHoursNow.toFixed(1)}h | ${scheduleDelta >= 0 ? 'Behind' : 'Ahead'} ${Math.abs(scheduleDelta).toFixed(1)}h`;
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

  function applyMobileChartCollapses() {
    const chartCards = Array.from(
      document.querySelectorAll(
        '#dashboard #weeklyScatterCard, #dashboard #monthlyScatterCard, #dashboard #heatmapCard, #dashboard #burndownCard, #analytics > .card'
      )
    );
    chartCards.forEach((card) => {
      card.classList.add('mobile-chart-card');
      const summaryText = getMobileChartSummary(card);
      let summary = card.querySelector(':scope > .mobile-chart-summary');
      if (!summary) {
        summary = document.createElement('p');
        summary.className = 'mobile-chart-summary';
        const heading = card.querySelector('h3, h4');
        if (heading && heading.nextSibling) {
          card.insertBefore(summary, heading.nextSibling);
        } else {
          card.insertBefore(summary, card.firstChild);
        }
      }
      summary.textContent = summaryText;
      let detail = card.querySelector(':scope > .mobile-chart-detail');
      if (!detail) {
        detail = document.createElement('button');
        detail.type = 'button';
        detail.className = 'btn secondary mobile-chart-detail';
        detail.textContent = 'Details';
        detail.addEventListener('click', () => {
          openMobileChartDetail(card);
        });
        summary.after(detail);
      }
      let toggle = card.querySelector(':scope > .mobile-chart-toggle');
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn secondary mobile-chart-toggle';
        toggle.addEventListener('click', () => {
          const open = !card.classList.contains('mobile-chart-open');
          card.classList.toggle('mobile-chart-open', open);
          toggle.textContent = open ? 'Close chart' : 'Open chart';
        });
        const heading = card.querySelector('h3, h4');
        if (heading && heading.nextSibling) {
          card.insertBefore(toggle, heading.nextSibling);
        } else {
          card.insertBefore(toggle, card.firstChild);
        }
      }
      if (!card.classList.contains('mobile-chart-open')) {
        toggle.textContent = 'Open chart';
      }
    });
  }

  function getMobileChartSummary(card) {
    const heading =
      card.querySelector('h3, h4')?.textContent?.trim() || 'Chart';
    const chartCanvas = card.querySelector('canvas');
    if (chartCanvas && window.Chart && typeof Chart.getChart === 'function') {
      const chart = Chart.getChart(chartCanvas);
      if (chart && chart.data) {
        const datasets = Array.isArray(chart.data.datasets)
          ? chart.data.datasets
          : [];
        const points = datasets.reduce((total, dataset) => {
          const rows = Array.isArray(dataset.data) ? dataset.data.length : 0;
          return total + rows;
        }, 0);
        if (datasets.length || points) {
          return `${heading}: ${datasets.length || 1} series, ${points} points.`;
        }
      }
    }
    const table = card.querySelector('table');
    if (table) {
      const rows = Math.max(
        0,
        table.querySelectorAll('tbody tr, tr').length - 1
      );
      return rows
        ? `${heading}: ${rows} rows available.`
        : `${heading}: table summary available.`;
    }
    const text = card.textContent.replace(/\s+/g, ' ').trim();
    return text && text !== heading
      ? `${heading}: tap for details.`
      : `${heading}: no chart data yet.`;
  }

  function openMobileChartDetail(card) {
    const heading =
      card.querySelector('h3, h4')?.textContent?.trim() || 'Chart details';
    const sheet = createMobileSheet(heading, {
      className: 'mobile-chart-detail-sheet',
      description: getMobileChartSummary(card)
    });
    const copy = document.createElement('p');
    copy.className = 'mobile-flow-description';
    copy.textContent =
      'Open the full chart when you need the desktop-style view.';
    sheet.body.appendChild(copy);
    sheet.addAction('Open full chart', 'primary', () => {
      card.classList.add('mobile-chart-open');
      const toggle = card.querySelector(':scope > .mobile-chart-toggle');
      if (toggle) toggle.textContent = 'Close chart';
      sheet.close();
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    sheet.addAction('Close', 'secondary', sheet.close);
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

  function parseBackupSnapshotTimestamp(fileName) {
    const match = String(fileName || '').match(
      /^timekeeper-data-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/
    );
    if (!match) return null;
    const [, date, hours, minutes, seconds, millis] = match;
    const parsed = new Date(
      `${date}T${hours}:${minutes}:${seconds}.${millis}Z`
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function getBackupDataSummary(payload) {
    const projects = Array.isArray(payload?.projects)
      ? payload.projects.length
      : 0;
    const entries = Array.isArray(payload?.entries)
      ? payload.entries.length
      : 0;
    const revision = Number(payload?.backupRevision) || 0;
    const updatedAt =
      typeof payload?.updatedAt === 'string' && payload.updatedAt
        ? payload.updatedAt
        : null;
    return { projects, entries, revision, updatedAt };
  }

  function normalizeBackupSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const revision = Number(summary.revision);
    const projects = Number(summary.projects);
    const entries = Number(summary.entries);
    const updatedAt =
      typeof summary.updatedAt === 'string' && summary.updatedAt
        ? summary.updatedAt
        : typeof summary.dataUpdatedAt === 'string' && summary.dataUpdatedAt
          ? summary.dataUpdatedAt
          : null;
    const writtenAt =
      typeof summary.writtenAt === 'string' && summary.writtenAt
        ? summary.writtenAt
        : null;
    return {
      source: summary.source || 'backup',
      revision: Number.isFinite(revision) ? revision : 0,
      projects: Number.isFinite(projects) ? projects : 0,
      entries: Number.isFinite(entries) ? entries : 0,
      updatedAt,
      writtenAt
    };
  }

  async function readLatestBackupSummary(directoryHandle = backupDirHandle) {
    if (!directoryHandle) return null;
    try {
      const manifest = JSON.parse(
        await readTextFile(directoryHandle, BACKUP_MANIFEST_FILENAME)
      );
      const summary = normalizeBackupSummary({
        source: BACKUP_MANIFEST_FILENAME,
        revision: manifest.backupRevision,
        projects: manifest.projects,
        entries: manifest.entries,
        updatedAt: manifest.dataUpdatedAt,
        writtenAt: manifest.writtenAt
      });
      if (summary) return summary;
    } catch {
      // Older backups may not have a manifest; fall back to the latest data file.
    }
    try {
      const latest = JSON.parse(
        await readTextFile(directoryHandle, BACKUP_LATEST_FILENAME)
      );
      return normalizeBackupSummary({
        source: BACKUP_LATEST_FILENAME,
        ...getBackupDataSummary(latest),
        writtenAt: latest.lastBackupAt || null
      });
    } catch {
      return null;
    }
  }

  function getNewerBackupConflict(summary, localData = data) {
    const backupSummary = normalizeBackupSummary(summary);
    if (!backupSummary) return null;
    const localRevision = Number(localData?.backupRevision) || 0;
    const localProjects = Array.isArray(localData?.projects)
      ? localData.projects.length
      : 0;
    const localEntries = Array.isArray(localData?.entries)
      ? localData.entries.length
      : 0;
    const localUpdatedAt =
      typeof localData?.updatedAt === 'string' && localData.updatedAt
        ? localData.updatedAt
        : null;
    const remoteUpdatedTime = backupSummary.updatedAt
      ? new Date(backupSummary.updatedAt).getTime()
      : NaN;
    const localUpdatedTime = localUpdatedAt
      ? new Date(localUpdatedAt).getTime()
      : NaN;
    let reason = '';
    if (backupSummary.revision > localRevision) {
      reason = 'revision';
    } else if (
      backupSummary.revision >= localRevision &&
      Number.isFinite(remoteUpdatedTime) &&
      (!Number.isFinite(localUpdatedTime) ||
        remoteUpdatedTime > localUpdatedTime + 1000)
    ) {
      reason = 'updatedAt';
    } else if (
      backupSummary.revision >= localRevision &&
      localProjects + localEntries === 0 &&
      backupSummary.projects + backupSummary.entries > 0
    ) {
      reason = 'non-empty-backup';
    }
    if (!reason) return null;
    return {
      ...backupSummary,
      reason,
      localRevision,
      localUpdatedAt,
      localProjects,
      localEntries
    };
  }

  async function detectBackupConflict(directoryHandle = backupDirHandle) {
    const summary = await readLatestBackupSummary(directoryHandle);
    return getNewerBackupConflict(summary);
  }

  const BACKUP_CONFLICT_WARNING_PREFIX = 'Backup folder has newer data';

  function formatBackupConflictWarning(conflict = backupConflict) {
    if (!conflict) return '';
    const revisionText = `revision ${conflict.revision}`;
    const changedText = conflict.updatedAt
      ? `, changed ${formatRelativeTime(conflict.updatedAt)}`
      : '';
    return `${BACKUP_CONFLICT_WARNING_PREFIX} (${revisionText}${changedText}). Restore Latest Backup before syncing, or use Backup Now and confirm overwrite.`;
  }

  function setBackupConflict(conflict) {
    backupConflict = conflict || null;
    if (backupConflict) {
      backupWarningMessage = formatBackupConflictWarning(backupConflict);
    } else if (
      backupWarningMessage &&
      backupWarningMessage.startsWith(BACKUP_CONFLICT_WARNING_PREFIX)
    ) {
      backupWarningMessage = '';
    }
  }

  function formatBackupSnapshotLabel(item) {
    if (item.timestamp && !Number.isNaN(item.timestamp.getTime())) {
      return item.timestamp.toLocaleString();
    }
    return item.name;
  }

  async function getBackupSnapshotDirHandle({ create = false } = {}) {
    if (!backupDirHandle) return null;
    try {
      return await backupDirHandle.getDirectoryHandle(BACKUP_SNAPSHOT_DIR, {
        create
      });
    } catch (err) {
      return null;
    }
  }

  async function readBackupSnapshotSummaries() {
    const snapshotDirHandle = await getBackupSnapshotDirHandle();
    if (!snapshotDirHandle || !snapshotDirHandle.entries) return [];
    const items = [];
    for await (const [name, handle] of snapshotDirHandle.entries()) {
      if (
        handle.kind !== 'file' ||
        !/^timekeeper-data-\d{4}-\d{2}-\d{2}T.*\.json$/.test(name)
      ) {
        continue;
      }
      const timestamp = parseBackupSnapshotTimestamp(name);
      let summary = { projects: 0, entries: 0, revision: 0, updatedAt: null };
      try {
        const text = await readTextFile(snapshotDirHandle, name);
        summary = getBackupDataSummary(JSON.parse(text));
      } catch {
        // Keep the snapshot visible even if its summary cannot be read.
      }
      items.push({ name, timestamp, ...summary });
    }
    items.sort((a, b) => {
      const timeA = a.timestamp ? a.timestamp.getTime() : 0;
      const timeB = b.timestamp ? b.timestamp.getTime() : 0;
      if (timeA !== timeB) return timeB - timeA;
      return String(b.name).localeCompare(String(a.name));
    });
    return items;
  }

  function renderBackupSnapshotsPanel() {
    const panel = document.getElementById('backupSnapshotsPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'backup-snapshots-header';
    const title = document.createElement('h4');
    title.textContent = 'Snapshot History';
    header.appendChild(title);
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn secondary';
    refreshBtn.textContent =
      backupSnapshotState === 'loading' ? 'Refreshing...' : 'Refresh Snapshots';
    refreshBtn.disabled =
      backupSnapshotState === 'loading' ||
      !backupDirHandle ||
      backupPermissionState !== 'granted';
    refreshBtn.addEventListener('click', () => {
      refreshBackupSnapshots({ quiet: false });
    });
    header.appendChild(refreshBtn);
    panel.appendChild(header);

    const defaultMessage = !backupDirHandle
      ? 'Select a backup folder to view timestamped snapshots.'
      : backupPermissionState !== 'granted'
        ? 'Grant backup folder access to view snapshots.'
        : '';
    const visibleMessage = backupSnapshotMessage || defaultMessage;
    if (visibleMessage) {
      const message = document.createElement('p');
      message.className =
        backupSnapshotState === 'error' ? 'status-warning' : 'status-muted';
      message.textContent = visibleMessage;
      panel.appendChild(message);
    }

    if (backupSnapshotItems.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'backup-snapshot-list';
    backupSnapshotItems.slice(0, BACKUP_SNAPSHOT_KEEP).forEach((item) => {
      const row = document.createElement('li');
      row.className = 'backup-snapshot-row';
      const meta = document.createElement('div');
      meta.className = 'backup-snapshot-meta';
      const name = document.createElement('strong');
      name.textContent = formatBackupSnapshotLabel(item);
      meta.appendChild(name);
      const detail = document.createElement('span');
      detail.className = 'status-muted';
      detail.textContent = `${item.projects} projects, ${item.entries} entries, revision ${item.revision || 0}`;
      meta.appendChild(detail);
      if (item.updatedAt) {
        const updated = document.createElement('span');
        updated.className = 'status-muted';
        updated.textContent = `Data changed ${formatRelativeTime(item.updatedAt)}`;
        meta.appendChild(updated);
      }
      row.appendChild(meta);
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn secondary';
      restoreBtn.textContent = 'Restore Snapshot';
      restoreBtn.addEventListener('click', () => {
        restoreBackupSnapshotFromDir(item.name);
      });
      row.appendChild(restoreBtn);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }

  async function refreshBackupSnapshots({ quiet = true } = {}) {
    if (!backupDirHandle) {
      backupSnapshotItems = [];
      backupSnapshotState = 'idle';
      backupSnapshotMessage = 'Select a backup folder to view snapshots.';
      renderBackupSnapshotsPanel();
      return [];
    }
    const permissionGranted =
      await ensureBackupPermissionWithPrompt(backupDirHandle);
    if (!permissionGranted) {
      backupSnapshotItems = [];
      backupSnapshotState = 'error';
      backupSnapshotMessage =
        'Permission to access the backup folder was not granted.';
      renderBackupSnapshotsPanel();
      return [];
    }
    backupSnapshotState = 'loading';
    backupSnapshotMessage = 'Loading backup snapshots...';
    renderBackupSnapshotsPanel();
    try {
      const items = await readBackupSnapshotSummaries();
      backupSnapshotItems = items;
      backupSnapshotState = 'ready';
      backupSnapshotMessage = items.length
        ? `${items.length} snapshot${items.length === 1 ? '' : 's'} available.`
        : 'No timestamped snapshots found yet.';
      renderBackupSnapshotsPanel();
      if (!quiet && items.length === 0) {
        showToast('No backup snapshots found yet.');
      }
      return items;
    } catch (err) {
      console.error('Reading backup snapshots failed:', err);
      backupSnapshotItems = [];
      backupSnapshotState = 'error';
      backupSnapshotMessage =
        'Could not read backup snapshots from the selected folder.';
      renderBackupSnapshotsPanel();
      return [];
    }
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

  function assertBackupPayloadMatchesCurrent(payload, sourceLabel) {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${sourceLabel} is not a JSON object.`);
    }
    if (!Array.isArray(payload.projects) || !Array.isArray(payload.entries)) {
      throw new Error(`${sourceLabel} is missing projects or entries.`);
    }
    const expectedRevision = Number(data.backupRevision) || 0;
    const actualRevision = Number(payload.backupRevision) || 0;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `${sourceLabel} revision ${actualRevision} does not match local revision ${expectedRevision}.`
      );
    }
    if (payload.projects.length !== data.projects.length) {
      throw new Error(
        `${sourceLabel} project count does not match local data.`
      );
    }
    if (payload.entries.length !== data.entries.length) {
      throw new Error(`${sourceLabel} entry count does not match local data.`);
    }
  }

  function assertBackupManifestMatchesCurrent(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Backup manifest is not a JSON object.');
    }
    if (manifest.latestFile !== BACKUP_LATEST_FILENAME) {
      throw new Error('Backup manifest points at the wrong latest file.');
    }
    if (manifest.snapshotDirectory !== BACKUP_SNAPSHOT_DIR) {
      throw new Error('Backup manifest points at the wrong snapshot folder.');
    }
    const expectedRevision = Number(data.backupRevision) || 0;
    const actualRevision = Number(manifest.backupRevision) || 0;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `Backup manifest revision ${actualRevision} does not match local revision ${expectedRevision}.`
      );
    }
    if (Number(manifest.projects) !== data.projects.length) {
      throw new Error(
        'Backup manifest project count does not match local data.'
      );
    }
    if (Number(manifest.entries) !== data.entries.length) {
      throw new Error('Backup manifest entry count does not match local data.');
    }
  }

  async function verifyBackupRoundTrip({ promptOnConflict = true } = {}) {
    try {
      if (!backupDirHandle) {
        backupPermissionState = 'missing';
        backupWarningMessage =
          'Choose a backup folder before verifying backup.';
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
      const saved = await saveBackupToDir({ promptOnConflict });
      if (!saved) return false;

      const latest = JSON.parse(
        await readTextFile(backupDirHandle, BACKUP_LATEST_FILENAME)
      );
      assertBackupPayloadMatchesCurrent(latest, BACKUP_LATEST_FILENAME);

      const manifest = JSON.parse(
        await readTextFile(backupDirHandle, BACKUP_MANIFEST_FILENAME)
      );
      assertBackupManifestMatchesCurrent(manifest);

      if (!manifest.latestSnapshotFile) {
        throw new Error('Backup manifest does not list a latest snapshot.');
      }
      const snapshotDirHandle = await getBackupSnapshotDirHandle();
      if (!snapshotDirHandle) {
        throw new Error('Backup snapshot folder could not be opened.');
      }
      const snapshot = JSON.parse(
        await readTextFile(snapshotDirHandle, manifest.latestSnapshotFile)
      );
      assertBackupPayloadMatchesCurrent(snapshot, manifest.latestSnapshotFile);

      data.lastBackupVerifiedAt = new Date().toISOString();
      persistDataToLocalStorage();
      backupWarningMessage = '';
      updateAutoSyncStatus();
      showToast('Backup verified successfully.');
      return true;
    } catch (err) {
      console.error('Backup verification failed:', err);
      backupWarningMessage =
        err && err.message
          ? `Backup verification failed: ${err.message}`
          : 'Backup verification failed. Check the backup folder and try again.';
      updateAutoSyncStatus();
      showToast('Backup verification failed.');
      return false;
    }
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
  async function saveBackupToDir({
    force = false,
    promptOnConflict = false
  } = {}) {
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
        const conflict = force ? null : await detectBackupConflict();
        if (conflict) {
          if (promptOnConflict) {
            const ok = await requestConfirm({
              title: 'Overwrite Newer Backup',
              message:
                formatBackupConflictWarning(conflict) +
                ' Overwriting replaces the latest backup file in the selected folder.',
              confirmLabel: 'Overwrite Backup',
              danger: true
            });
            if (!ok) {
              setBackupConflict(conflict);
              updateAutoSyncStatus();
              return false;
            }
          } else {
            setBackupConflict(conflict);
            autoSyncEnabled = false;
            localStorage.setItem('autoSyncEnabledPro', 'false');
            needsBackup = true;
            updateAutoSyncStatus();
            return false;
          }
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
        setBackupConflict(null);
        backupWarningMessage = '';
        updateAutoSyncStatus();
        refreshBackupSnapshots({ quiet: true }).catch((err) => {
          console.error('Refreshing backup snapshots failed:', err);
        });
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
      const conflict = await detectBackupConflict(dirHandle);
      if (conflict) {
        persistDataToLocalStorage();
        setBackupConflict(conflict);
        if (activateSync) {
          autoSyncEnabled = false;
          localStorage.setItem('autoSyncEnabledPro', 'false');
          const toggle = document.getElementById('autoSyncToggle');
          if (toggle) toggle.checked = false;
        }
        updateAutoSyncStatus();
        await refreshBackupSnapshots({ quiet: true });
        return false;
      }
      setBackupConflict(null);
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
      await refreshBackupSnapshots({ quiet: true });
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

  function isMobileViewport() {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 640px)').matches
    );
  }

  // Navigation
  const navList = document.getElementById('navList');
  const defaultSectionId = 'timer';
  const sectionIds = new Set(
    Array.from(document.querySelectorAll('.section')).map(
      (section) => section.id
    )
  );
  let activeSectionId = null;

  function updateSectionHash(sectionId) {
    if (!sectionIds.has(sectionId) || !window.history) return;
    const nextHash = `#${encodeURIComponent(sectionId)}`;
    if (window.location.hash === nextHash) return;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${nextHash}`
    );
  }

  function shouldShowTodayCommandPanel(sectionId = activeSectionId) {
    return sectionId === 'dashboard';
  }

  function syncTodayCommandPanelVisibility(sectionId = activeSectionId) {
    const panel = document.getElementById('todayCommandPanel');
    if (!panel) return;
    panel.classList.toggle('hidden', !shouldShowTodayCommandPanel(sectionId));
  }

  function updateMobileMoreActiveState(sectionId) {
    const moreItem = navList.querySelector('.mobile-more-nav-item');
    if (!moreItem) return;
    const primarySections = new Set([
      'dashboard',
      'timer',
      'entries',
      'analytics'
    ]);
    moreItem.classList.toggle('active', !primarySections.has(sectionId));
  }

  function showSection(sectionId, navItem = null, options = {}) {
    if (!sectionId || !sectionIds.has(sectionId)) return;
    const { updateHash = true, resetScroll = true } = options;
    activeSectionId = sectionId;
    navList
      .querySelectorAll('li')
      .forEach((item) => item.classList.remove('active'));
    const item =
      navItem || navList.querySelector(`li[data-section="${sectionId}"]`);
    if (item) item.classList.add('active');
    updateMobileMoreActiveState(sectionId);
    document.querySelectorAll('.section').forEach((sec) => {
      sec.style.display = 'none';
    });
    document.getElementById(sectionId).style.display = 'block';
    if (sectionId !== 'entries') {
      closeManualEntryForm({ reset: false, updateNowBar: false });
    }
    syncTodayCommandPanelVisibility(sectionId);
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
    applyMobileChartCollapses();
    renderMobileSyncStatus();
    renderMobileNowBar();
    if (updateHash) updateSectionHash(sectionId);
    if (resetScroll && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }

  navList.querySelectorAll('li[data-section]').forEach((li) => {
    li.addEventListener('click', () => {
      showSection(li.getAttribute('data-section'), li);
    });
  });

  function activateSection(sectionId) {
    showSection(sectionId);
  }

  function openMobileMoreMenu() {
    const options = [
      ['projects', 'Projects'],
      ['importExport', 'Backup / Sync'],
      ['todo', 'Workouts'],
      ['grocery', 'Finances']
    ];
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop mobile-more-backdrop';
    const panel = document.createElement('div');
    panel.className = 'modal-panel mobile-more-panel';
    panel.role = 'dialog';
    panel.setAttribute('aria-modal', 'true');
    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.id = 'mobile-more-title';
    title.className = 'modal-title';
    title.textContent = 'More';
    panel.setAttribute('aria-labelledby', title.id);
    header.appendChild(title);
    const body = document.createElement('div');
    body.className = 'modal-body mobile-more-list';
    const close = () => backdrop.remove();
    options.forEach(([sectionId, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-more-button';
      button.textContent = label;
      button.addEventListener('click', () => {
        close();
        activateSection(sectionId);
      });
      body.appendChild(button);
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    panel.appendChild(header);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    const first = body.querySelector('button');
    if (first) first.focus();
  }

  function createMobileSheet(
    titleText,
    { className = '', description = '' } = {}
  ) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop mobile-flow-backdrop';
    const panel = document.createElement('div');
    panel.className = `modal-panel mobile-flow-panel${className ? ` ${className}` : ''}`;
    panel.role = 'dialog';
    panel.tabIndex = -1;
    panel.setAttribute('aria-modal', 'true');
    const titleId = `mobile-flow-title-${uuid()}`;
    panel.setAttribute('aria-labelledby', titleId);
    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.id = titleId;
    title.className = 'modal-title';
    title.textContent = titleText;
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn secondary';
    closeBtn.textContent = 'Close';
    header.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = 'modal-body mobile-flow-body';
    if (description) {
      const paragraph = document.createElement('p');
      paragraph.className = 'mobile-flow-description';
      paragraph.textContent = description;
      body.appendChild(paragraph);
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions mobile-flow-actions';
    const close = () => backdrop.remove();
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    const addAction = (label, variant = 'secondary', onClick = close) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${variant}`;
      button.textContent = label;
      button.addEventListener('click', onClick);
      actions.appendChild(button);
      return button;
    };
    const firstFocus = body.querySelector(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (firstFocus instanceof HTMLElement) firstFocus.focus();
    else panel.focus();
    return { backdrop, panel, body, actions, close, addAction };
  }

  function createMobileField(labelText, control) {
    const label = document.createElement('label');
    label.className = 'mobile-sheet-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(control);
    return label;
  }

  function createMobileSelect(options, selectedValue = '') {
    const select = document.createElement('select');
    options.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    });
    if (selectedValue) select.value = selectedValue;
    return select;
  }

  function getWorkoutQuickTimestamp(dateKey) {
    const when = new Date();
    if (dateKey === 'yesterday') {
      when.setDate(when.getDate() - 1);
      when.setHours(18, 0, 0, 0);
    }
    return when;
  }

  function openMobileWorkoutSheet(seedPreset = null) {
    const summary = getWorkoutMobileSummary();
    const sheet = createMobileSheet('Log workout', {
      className: 'mobile-workout-sheet',
      description: `${summary.label} - ${summary.state}`
    });
    const summaryBox = document.createElement('div');
    summaryBox.className = `mobile-next-action${summary.tone ? ` ${summary.tone}` : ''}`;
    summaryBox.textContent = `${summary.detail}. Next: ${summary.label}.`;
    sheet.body.appendChild(summaryBox);

    const presets = ensureWorkoutData()
      .presets.slice()
      .sort((a, b) => {
        const recent = getRecentManualWorkoutEntry();
        if (recent) {
          if (a.id === recent.presetId) return -1;
          if (b.id === recent.presetId) return 1;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      })
      .slice(0, 4);
    if (presets.length) {
      const quickSection = document.createElement('div');
      quickSection.className = 'mobile-today-section';
      const title = document.createElement('div');
      title.className = 'mobile-today-section-title';
      title.textContent = 'One-tap presets';
      quickSection.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'mobile-domain-action-grid';
      presets.forEach((preset) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mobile-domain-action';
        const label = document.createElement('strong');
        label.textContent = preset.name;
        const detail = document.createElement('span');
        detail.textContent = getIntensitySummary(preset.intensity);
        button.appendChild(label);
        button.appendChild(detail);
        button.addEventListener('click', () => {
          logWorkoutShortcut(preset);
          sheet.close();
        });
        grid.appendChild(button);
      });
      quickSection.appendChild(grid);
      sheet.body.appendChild(quickSection);
    }

    const structured = document.createElement('div');
    structured.className = 'mobile-quick-log-structured';
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Workout name';
    nameInput.value = seedPreset ? seedPreset.name || '' : '';
    structured.appendChild(createMobileField('Workout', nameInput));

    const seedIntensity = seedPreset
      ? normalizeIntensity(seedPreset.intensity)
      : 'medium';
    const seedCustomPoints = parseCustomIntensity(seedIntensity);
    const intensitySelect = createMobileSelect(
      [
        { value: 'intense', label: 'Intense' },
        { value: 'medium', label: 'Medium' },
        { value: 'light', label: 'Light' },
        { value: 'custom', label: 'Custom points' }
      ],
      seedCustomPoints === null ? seedIntensity : 'custom'
    );
    structured.appendChild(createMobileField('Intensity', intensitySelect));

    const customInput = document.createElement('input');
    customInput.type = 'number';
    customInput.min = '0.01';
    customInput.step = '0.01';
    customInput.placeholder = 'Points';
    if (seedCustomPoints !== null) {
      customInput.value = formatCustomIntensityValue(seedCustomPoints);
    }
    const customField = createMobileField('Custom points', customInput);
    structured.appendChild(customField);

    let dateKey = 'today';
    const chips = document.createElement('div');
    chips.className = 'mobile-date-chip-row';
    [
      ['today', 'Today'],
      ['yesterday', 'Yesterday']
    ].forEach(([value, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `btn secondary mobile-date-chip${value === dateKey ? ' active' : ''}`;
      chip.textContent = label;
      chip.addEventListener('click', () => {
        dateKey = value;
        chips.querySelectorAll('.mobile-date-chip').forEach((button) => {
          button.classList.toggle('active', button === chip);
        });
        renderWorkoutPreview();
      });
      chips.appendChild(chip);
    });
    structured.appendChild(chips);

    const preview = document.createElement('div');
    preview.className = 'mobile-quick-log-preview';
    preview.setAttribute('aria-live', 'polite');

    function getWorkoutPayload() {
      const trimmed = nameInput.value.trim();
      if (!trimmed) return { ok: false, reason: 'Enter a workout name.' };
      let intensity = intensitySelect.value;
      if (intensity === 'custom') {
        const customPoints = sanitizeCustomPoints(customInput.value);
        if (customPoints === null) {
          return { ok: false, reason: 'Enter valid custom points.' };
        }
        intensity = makeCustomIntensity(customPoints);
      }
      return {
        ok: true,
        name: trimmed,
        intensity,
        timestamp: getWorkoutQuickTimestamp(dateKey)
      };
    }

    function renderWorkoutPreview() {
      customField.classList.toggle(
        'hidden',
        intensitySelect.value !== 'custom'
      );
      const payload = getWorkoutPayload();
      if (!payload.ok) {
        preview.className = 'mobile-quick-log-preview risk';
        preview.textContent = payload.reason;
        return;
      }
      preview.className = 'mobile-quick-log-preview';
      preview.textContent = `${payload.name} - ${getIntensitySummary(
        payload.intensity
      )} - ${formatWorkoutTimestamp(payload.timestamp)}`;
    }

    [nameInput, intensitySelect, customInput].forEach((input) => {
      input.addEventListener('input', renderWorkoutPreview);
      input.addEventListener('change', renderWorkoutPreview);
    });
    sheet.body.appendChild(structured);
    sheet.body.appendChild(preview);
    renderWorkoutPreview();

    sheet.addAction('Log workout', 'primary', () => {
      const payload = getWorkoutPayload();
      if (!payload.ok) {
        showToast(payload.reason);
        renderWorkoutPreview();
        return;
      }
      const snapshot = cloneData();
      const entry = logWorkoutEntry(payload);
      if (!entry) {
        showToast('Could not log workout.');
        return;
      }
      offerUndo('Workout logged.', snapshot);
      provideHaptic('beep');
      renderTodayCommandPanel();
      sheet.close();
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function openMobileWealthSnapshotSheet() {
    const sheet = createMobileSheet('Wealth snapshot', {
      className: 'mobile-wealth-sheet',
      description: 'Add a quick wealth data point.'
    });
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = formatDateInputValue(new Date());
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.step = '1';
    amountInput.placeholder = 'Amount (SEK)';
    const noteInput = document.createElement('input');
    noteInput.placeholder = 'Note';
    sheet.body.appendChild(createMobileField('Date', dateInput));
    sheet.body.appendChild(createMobileField('Amount', amountInput));
    sheet.body.appendChild(createMobileField('Note', noteInput));
    sheet.addAction('Add point', 'primary', () => {
      const snapshot = cloneData();
      const result = addWealthHistoryEntry(
        dateInput.value,
        amountInput.value,
        noteInput.value
      );
      if (!result.ok) {
        showToast(
          result.reason === 'date'
            ? 'Enter a valid date.'
            : 'Enter a valid amount.'
        );
        return;
      }
      renderWealthHistoryTable();
      updateWealthDashboard();
      renderTodayCommandPanel();
      offerUndo('Wealth point added.', snapshot);
      sheet.close();
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function openMobileRecurringPaymentSheet() {
    const sheet = createMobileSheet('Recurring payment', {
      className: 'mobile-recurring-sheet',
      description: 'Add a fixed monthly payment.'
    });
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Name';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.step = '0.01';
    amountInput.placeholder = 'Amount (SEK)';
    sheet.body.appendChild(createMobileField('Name', nameInput));
    sheet.body.appendChild(createMobileField('Amount', amountInput));
    sheet.addAction('Add payment', 'primary', () => {
      const name = nameInput.value.trim();
      const amount = Number(amountInput.value);
      if (!name) {
        showToast('Please enter a payment name.');
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        showToast('Enter a valid amount.');
        return;
      }
      const snapshot = cloneData();
      ensureMonthlyRecurringPayments().push({ id: uuid(), name, amount });
      saveData();
      updateGrocerySection();
      renderTodayCommandPanel();
      offerUndo('Recurring payment added.', snapshot);
      sheet.close();
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function openMobileFinanceSheet() {
    const snapshot = getFinanceBudgetSnapshot();
    const recent = getRecentArchivedPurchase();
    const sheet = createMobileSheet('Finance quick actions', {
      className: 'mobile-finance-sheet',
      description: `Weekly left ${formatSek(snapshot.weekly.remaining)}. Credits ${formatSek(
        snapshot.wellnessCredits
      )}.`
    });
    const summary = document.createElement('div');
    summary.className = 'mobile-next-action';
    summary.textContent = `Weekly ${formatSek(
      snapshot.weekly.spent
    )} / ${formatSek(snapshot.weekly.budget)}. Monthly ${formatSek(
      snapshot.monthly.spent
    )} / ${formatSek(snapshot.monthly.budget)}.`;
    sheet.body.appendChild(summary);

    if (recent) {
      const repeatButton = document.createElement('button');
      repeatButton.type = 'button';
      repeatButton.className = 'mobile-domain-action';
      const repeatLabel = document.createElement('strong');
      repeatLabel.textContent = 'Repeat recent';
      const repeatDetail = document.createElement('span');
      repeatDetail.textContent = `${recent.name} - ${formatSek(
        Number.isFinite(Number(recent.originalCost))
          ? Number(recent.originalCost)
          : Number(recent.cost) || 0
      )}`;
      repeatButton.appendChild(repeatLabel);
      repeatButton.appendChild(repeatDetail);
      repeatButton.addEventListener('click', () => {
        repeatRecentPurchase();
        sheet.close();
      });
      sheet.body.appendChild(repeatButton);
    }

    const activeItems = (Array.isArray(data.groceries) ? data.groceries : [])
      .filter((item) => item && !item.archived)
      .sort((a, b) => {
        const freqOrder = { weekly: 0, monthly: 1, biannual: 2 };
        const freqA = freqOrder[a.frequency] ?? 0;
        const freqB = freqOrder[b.frequency] ?? 0;
        if (freqA !== freqB) return freqA - freqB;
        return String(a.name || '').localeCompare(
          String(b.name || ''),
          undefined,
          {
            sensitivity: 'base'
          }
        );
      });
    const itemSelect = createMobileSelect([
      { value: 'custom', label: 'New expense' },
      ...activeItems.map((item) => ({ value: item.id, label: item.name }))
    ]);
    const customNameInput = document.createElement('input');
    customNameInput.placeholder = 'Expense name';
    const frequencySelect = createMobileSelect(
      [
        { value: 'weekly', label: 'Weekly' },
        { value: 'monthly', label: 'Monthly' },
        { value: 'biannual', label: 'Biannual' }
      ],
      'weekly'
    );
    const categorySelect = createMobileSelect(
      [
        { value: 'standard', label: 'Standard' },
        { value: 'treat', label: 'Treat' },
        { value: 'essential', label: 'Essential' }
      ],
      'standard'
    );
    const costInput = document.createElement('input');
    costInput.type = 'number';
    costInput.min = '0';
    costInput.step = '0.01';
    costInput.placeholder = 'Cost (SEK)';
    const customNameField = createMobileField('New expense', customNameInput);
    const frequencyField = createMobileField('Frequency', frequencySelect);
    const categoryField = createMobileField('Category', categorySelect);
    sheet.body.appendChild(createMobileField('Purchase', itemSelect));
    sheet.body.appendChild(customNameField);
    sheet.body.appendChild(frequencyField);
    sheet.body.appendChild(categoryField);
    sheet.body.appendChild(createMobileField('Cost', costInput));

    const preview = document.createElement('div');
    preview.className = 'mobile-quick-log-preview';
    preview.setAttribute('aria-live', 'polite');
    sheet.body.appendChild(preview);

    function getSelectedPurchaseItem() {
      if (itemSelect.value === 'custom') {
        return {
          id: null,
          name: customNameInput.value.trim(),
          frequency: frequencySelect.value,
          category: categorySelect.value
        };
      }
      return activeItems.find((item) => String(item.id) === itemSelect.value);
    }

    function renderPurchasePreview() {
      const custom = itemSelect.value === 'custom';
      [customNameField, frequencyField, categoryField].forEach((field) => {
        field.classList.toggle('hidden', !custom);
      });
      const item = getSelectedPurchaseItem();
      const cost = Number(costInput.value);
      if (!item || !String(item.name || '').trim()) {
        preview.className = 'mobile-quick-log-preview risk';
        preview.textContent = 'Choose an item or enter a new expense.';
        return;
      }
      if (!Number.isFinite(cost) || cost < 0) {
        preview.className = 'mobile-quick-log-preview risk';
        preview.textContent = 'Enter a valid cost.';
        return;
      }
      const purchase = computePurchaseCost(item, cost);
      preview.className = 'mobile-quick-log-preview';
      preview.textContent = `${item.name} - ${formatSek(
        purchase.cost
      )} counted${purchase.creditsUsed > 0 ? ` after ${formatSek(purchase.creditsUsed)} credits` : ''}.`;
    }

    [
      itemSelect,
      customNameInput,
      frequencySelect,
      categorySelect,
      costInput
    ].forEach((input) => {
      input.addEventListener('input', renderPurchasePreview);
      input.addEventListener('change', renderPurchasePreview);
    });
    renderPurchasePreview();

    sheet.addAction('Log purchase', 'primary', () => {
      const selected = getSelectedPurchaseItem();
      const cost = Number(costInput.value);
      if (!selected || !String(selected.name || '').trim()) {
        showToast('Choose an item or enter a new expense.');
        return;
      }
      if (!Number.isFinite(cost) || cost < 0) {
        showToast('Enter a valid cost.');
        return;
      }
      if (itemSelect.value === 'custom') {
        createAndLogGroceryPurchase({
          name: selected.name,
          frequency: selected.frequency,
          category: selected.category,
          cost
        });
      } else {
        logGroceryPurchase(selected, cost);
      }
      sheet.close();
    });
    sheet.addAction('Wealth snapshot', 'secondary', () => {
      sheet.close();
      openMobileWealthSnapshotSheet();
    });
    sheet.addAction('Recurring', 'secondary', () => {
      sheet.close();
      openMobileRecurringPaymentSheet();
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function openMobileRunningTimerSheet(entryId) {
    const entry = data.entries.find(
      (candidate) =>
        String(candidate.id) === String(entryId) && candidate.isRunning
    );
    if (!entry) return;
    const project = getEntryProject(entry);
    const sheet = createMobileSheet('Running timer', {
      className: 'mobile-running-timer-sheet',
      description: `${project ? project.name : 'Unknown project'} - ${formatDuration(
        Math.floor(getRunningEntryEffectiveSeconds(entry))
      )}`
    });
    const projectSelect = createMobileSelect(
      getActiveProjects().map((candidate) => ({
        value: candidate.id,
        label: candidate.name
      })),
      entry.projectId
    );
    const descriptionInput = document.createElement('input');
    descriptionInput.value = entry.description || '';
    descriptionInput.placeholder = 'Description';
    const startInput = document.createElement('input');
    startInput.type = 'datetime-local';
    startInput.value = toDateTimeInputValue(entry.startTime);
    const factorSelect = document.createElement('select');
    factorSelect.setAttribute('aria-label', 'Timer focus');
    appendCompactFocusFactorOptions(factorSelect);
    factorSelect.value = ensureCurrentCompactFocusOption(
      factorSelect,
      getEntryActiveFactor(entry, getRunningEntries().length)
    );
    sheet.body.appendChild(createMobileField('Project', projectSelect));
    sheet.body.appendChild(createMobileField('Description', descriptionInput));
    sheet.body.appendChild(createMobileField('Start time', startInput));
    sheet.body.appendChild(createMobileField('Focus', factorSelect));

    const quickGrid = document.createElement('div');
    quickGrid.className = 'mobile-domain-action-grid';
    [
      ['-5m', () => adjustRunningTimerElapsed(entry.id, -300)],
      ['+5m', () => adjustRunningTimerElapsed(entry.id, 300)],
      [
        isTimerPaused(entry) ? 'Resume' : 'Pause',
        () => {
          if (isTimerPaused(entry)) resumeTimer(entry.id);
          else pauseTimer(entry.id);
          sheet.close();
        }
      ]
    ].forEach(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary';
      button.textContent = label;
      button.addEventListener('click', action);
      quickGrid.appendChild(button);
    });
    sheet.body.appendChild(quickGrid);

    sheet.addAction('Save changes', 'primary', () => {
      const parsedStart = parseDateTimeInput(startInput.value);
      if (!parsedStart) {
        showToast('Enter a valid start time.');
        return;
      }
      const selectedProject = data.projects.find(
        (candidate) => String(candidate.id) === String(projectSelect.value)
      );
      if (!selectedProject) {
        showToast('Choose a valid project.');
        return;
      }
      const duplicateProject = getRunningEntries().some(
        (candidate) =>
          candidate.id !== entry.id &&
          String(candidate.projectId) === String(selectedProject.id)
      );
      if (duplicateProject) {
        showToast('A timer is already running for that project.');
        return;
      }
      const snapshot = cloneData();
      const now = new Date();
      accumulateRunningEntry(entry, now, getRunningEntries().length);
      entry.projectId = selectedProject.id;
      entry.description = descriptionInput.value.trim();
      entry.startTime = parsedStart.toISOString();
      entry.lastUpdateTime = now.toISOString();
      const selectedFactor = normalizeFocusFactor(factorSelect.value);
      entry.factor = selectedFactor;
      entry.focusFactor = selectedFactor;
      entry.manualFactor = selectedFactor;
      rebalanceActiveRunningFactors(now);
      saveData();
      refreshAllViews();
      offerUndo('Timer updated.', snapshot);
      sheet.close();
    });
    sheet.addAction('Stop', 'danger', () => {
      sheet.close();
      stopSingleTimer(entry.id);
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function ensureMobileMoreNav() {
    if (!navList || navList.querySelector('.mobile-more-nav-item')) return;
    const item = document.createElement('li');
    item.className = 'mobile-more-nav-item';
    item.textContent = 'More';
    item.addEventListener('click', openMobileMoreMenu);
    navList.appendChild(item);
  }

  ensureMobileMoreNav();

  function buildCommandResults(query) {
    const normalized = query.trim().toLowerCase();
    const sectionCommands = [
      ['timer', 'Open Timer'],
      ['dashboard', 'Open Dashboard'],
      ['projects', 'Open Projects'],
      ['entries', 'Open Entries'],
      ['importExport', 'Open Backup / Import'],
      ['todo', 'Open Workouts'],
      ['grocery', 'Open Finances'],
      ['analytics', 'Open Reports']
    ].map(([sectionId, label]) => ({
      label,
      meta: 'Navigate',
      action: () => activateSection(sectionId)
    }));
    const projectCommands = getActiveProjects().flatMap((project) => [
      {
        label: `Start timer: ${project.name}`,
        meta: 'Timer',
        action: () => {
          activateSection('timer');
          startProjectTimer(project.id, { overrideFactor: null });
        }
      },
      {
        label: `Show project: ${project.name}`,
        meta: project.client || 'Project',
        action: () => activateSection('projects')
      }
    ]);
    const pinnedTimerCommands = ensureTimerPresets()
      .map((preset) => {
        const project = data.projects.find(
          (candidate) => String(candidate.id) === String(preset.projectId)
        );
        if (!project || isProjectArchived(project)) return null;
        return {
          label: `Start pinned timer: ${formatTimerPresetLabel(
            project,
            preset.description,
            preset.focusFactor
          )}`,
          meta: 'Pinned Timer',
          action: () => {
            activateSection('timer');
            startProjectTimer(project.id, {
              description: preset.description,
              overrideFactor: preset.focusFactor
            });
          }
        };
      })
      .filter(Boolean);
    const utilityCommands = [
      {
        label: 'Backup now',
        meta: 'Backup',
        action: () => {
          activateSection('importExport');
          const button = document.getElementById('backupNowBtn');
          if (button && !button.disabled) button.click();
        }
      },
      {
        label: 'Verify backup',
        meta: 'Backup',
        action: () => {
          activateSection('importExport');
          const button = document.getElementById('verifyBackupBtn');
          if (button && !button.disabled) button.click();
        }
      },
      {
        label: 'Export data',
        meta: 'Backup',
        action: () => downloadData()
      },
      {
        label: 'Sync setup',
        meta: 'Backup',
        action: () => {
          activateSection('importExport');
          openMobileSyncWizard();
        }
      },
      {
        label: 'Review yesterday',
        meta: 'Entries',
        action: () => openEntryReviewSheet('yesterday')
      },
      {
        label: 'Review this week',
        meta: 'Entries',
        action: () => openEntryReviewSheet('week')
      }
    ];
    return [
      ...sectionCommands,
      ...pinnedTimerCommands,
      ...projectCommands,
      ...utilityCommands
    ]
      .filter((command) =>
        [command.label, command.meta]
          .join(' ')
          .toLowerCase()
          .includes(normalized)
      )
      .slice(0, 12);
  }

  function openCommandPalette() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('div');
    panel.className = 'modal-panel command-palette';
    const body = document.createElement('div');
    body.className = 'modal-body';
    const input = document.createElement('input');
    input.className = 'command-input';
    input.type = 'search';
    input.placeholder = 'Search commands, projects, or sections';
    const list = document.createElement('div');
    list.className = 'command-list';
    const close = () => backdrop.remove();
    const render = () => {
      list.innerHTML = '';
      const results = buildCommandResults(input.value);
      if (!results.length) {
        const empty = document.createElement('p');
        empty.className = 'status-muted';
        empty.textContent = 'No commands found.';
        list.appendChild(empty);
        return;
      }
      results.forEach((result) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'command-result';
        const label = document.createElement('span');
        label.textContent = result.label;
        const meta = document.createElement('span');
        meta.className = 'status-muted';
        meta.textContent = result.meta;
        button.appendChild(label);
        button.appendChild(meta);
        button.addEventListener('click', () => {
          close();
          result.action();
        });
        list.appendChild(button);
      });
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Enter') {
        const first = buildCommandResults(input.value)[0];
        if (first) {
          close();
          first.action();
        }
      }
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    body.appendChild(input);
    body.appendChild(list);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    render();
    input.focus();
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
    }
  });

  // Shared runtime helpers imported from ./shared/runtime-helpers.mjs.
  const STRAVA_FEED_CACHE_KEY = 'timekeeperStravaFeedCache';
  let cachedStravaActivities = [];
  let cachedStravaScoreScale = STRAVA_SCORE_DEFAULT_SCALE;

  function getCachedStravaFeedPayload() {
    try {
      const raw = localStorage.getItem(STRAVA_FEED_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return null;
      if (!Array.isArray(parsed.activities) || parsed.activities.length === 0) {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function saveCachedStravaFeedPayload(data) {
    if (!data || typeof data !== 'object') return;
    const activities = Array.isArray(data.activities) ? data.activities : [];
    if (activities.length === 0) return;
    try {
      localStorage.setItem(
        STRAVA_FEED_CACHE_KEY,
        JSON.stringify({
          updated_utc: data.updated_utc || null,
          cached_utc: new Date().toISOString(),
          activities
        })
      );
    } catch (error) {
      // Cache failures should not break workout rendering.
    }
  }

  function setActiveStravaActivities(activities) {
    const normalizedActivities = Array.isArray(activities) ? activities : [];
    cachedStravaActivities = normalizedActivities;
    window.stravaActivitiesCache = normalizedActivities;
    const updatedActivities =
      applyStravaExertionOverrides(normalizedActivities);
    refreshStravaScoreScale(updatedActivities);
    return updatedActivities;
  }

  function primeStravaCacheFromBrowserStorage() {
    const cached = getCachedStravaFeedPayload();
    if (!cached) return false;
    const activities = Array.isArray(cached.activities)
      ? cached.activities
      : [];
    if (!activities.length) return false;
    setActiveStravaActivities(activities);
    return true;
  }

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
      const activityUrl = safeExternalUrl(activity.url);
      const title = document.createElement(activityUrl ? 'a' : 'span');
      title.className = 'strava-title';
      title.textContent = activity.name || 'Untitled activity';
      if (activityUrl) {
        title.href = activityUrl;
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
          showToast('Enter a value of 0 or higher.');
          return;
        }
        saveStravaExertionOverride(activity.id, parsed);
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
        updateTodoSection();
      });
      clearButton.addEventListener('click', () => {
        saveStravaExertionOverride(activity.id, null);
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
        updateTodoSection();
      });
      faultyButton.addEventListener('click', () => {
        setStravaActivityFaulty(activity.id, !isStravaActivityFaulty(activity));
        const updatedActivities = applyStravaExertionOverrides(
          cachedStravaActivities
        );
        refreshStravaScoreScale(updatedActivities);
        renderStravaActivities(updatedActivities);
        updateFitnessCards();
        updateTodoSection();
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
    const renderPayload = (data, options = {}) => {
      const activities = Array.isArray(data?.activities) ? data.activities : [];
      const error =
        typeof data?.error === 'string' && data.error.trim()
          ? data.error.trim()
          : '';
      if (activities.length === 0) {
        status.textContent =
          error ||
          (options.fromCache
            ? 'No cached Strava activities available yet.'
            : 'No activities available yet.');
        list.innerHTML = '';
        return false;
      }
      const updatedText = data.updated_utc
        ? `${options.fromCache ? 'Cached' : 'Updated'} ${formatRelativeTime(data.updated_utc)}`
        : options.fromCache
          ? 'Using cached activities'
          : 'Latest activities';
      status.textContent = error
        ? `${updatedText} - latest refresh failed: ${error}`
        : `${updatedText}${options.refreshing ? ' - refreshing latest...' : ''}`;
      const updatedActivities = setActiveStravaActivities(activities);
      renderStravaActivities(updatedActivities);
      updateFitnessCards();
      updateTodoSection();
      updateAppHealthPanel();
      if (!options.fromCache) {
        saveCachedStravaFeedPayload(data);
      }
      return true;
    };
    const cached = getCachedStravaFeedPayload();
    const renderedCache =
      cached && renderPayload(cached, { fromCache: true, refreshing: true });
    if (!renderedCache) {
      status.textContent = 'Loading latest activities...';
      list.innerHTML = '';
    }
    try {
      const response = await fetch('assets/strava.json', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load Strava feed.');
      }
      const data = await response.json();
      if (!renderPayload(data)) {
        const fallback = getCachedStravaFeedPayload();
        if (fallback) {
          renderPayload(fallback, { fromCache: true });
        }
      }
    } catch (error) {
      const fallback = getCachedStravaFeedPayload();
      if (fallback && renderPayload(fallback, { fromCache: true })) {
        return;
      }
      status.textContent =
        'Strava feed not available yet. Run the GitHub Action or import a Strava export to publish activities.';
      updateAppHealthPanel();
    }
  }

  function isCodexTimeEntry(entry) {
    const source = String(entry?.source || '')
      .trim()
      .toLowerCase();
    if (source.includes('codex')) return true;
    const externalId = String(entry?.externalId || '')
      .trim()
      .toLowerCase();
    if (externalId.startsWith('codex-') || externalId.startsWith('codex:')) {
      return true;
    }
    const description = String(entry?.description || '')
      .trim()
      .toLowerCase();
    return description.startsWith('codex:');
  }

  function getCompletedProjectEntries(projectId, options = {}) {
    const includeCodexEntries = options.includeCodexEntries !== false;
    return data.entries.filter(
      (entry) =>
        entry.projectId === projectId &&
        !entry.isRunning &&
        (includeCodexEntries || !isCodexTimeEntry(entry))
    );
  }

  // Compute statistics per project
  function computeProjectStats(project, options = {}) {
    const now = new Date();
    const entries = getCompletedProjectEntries(project.id, options);
    const totalHours = sumEntryHours(entries);
    const remainingHours = project.budgetHours - totalHours;
    const created = getProjectStartDate(project);
    const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const todayEndExclusive = addLocalDays(todayStart, 1);
    const planningSnapshot = getProjectPlanningSnapshot(
      project,
      entries,
      todayStart
    );
    const requiredDailyPace = Math.max(
      0,
      Number(planningSnapshot.dailyRate) || 0
    );
    const paceRemainingWorkdays = Math.max(
      0,
      Number(planningSnapshot.remainingWorkdays) || 0
    );
    const paceRemainingHours = Math.max(
      0,
      Number(planningSnapshot.remainingHours) || 0
    );
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
    if (isWeeklyPaceProject(project)) {
      const weeklyTargetConst = getProjectPlannedHoursForPeriod(
        project,
        entries,
        weekStart,
        startNextWeek
      );
      const monthlyTargetConst = getProjectPlannedHoursForPeriod(
        project,
        entries,
        monthStart,
        startNextMonth
      );
      const rollingTargetStart = maxDate(rollingBounds.start, created);
      const rollingWorkdays = rollingTargetStart
        ? countWorkdays(rollingTargetStart, rollingBounds.endExclusive)
        : 0;
      const rolling30TargetConst =
        (getProjectWeeklyExpectedHours(project) / 5) * rollingWorkdays;
      const weeklyRemaining = Math.max(0, weeklyTargetConst - weeklyHours);
      return {
        totalHours,
        totalExpectedToDate: weeklyTargetConst,
        totalScheduleDeficit: weeklyRemaining,
        remainingHours: weeklyRemaining,
        usedPct:
          weeklyTargetConst > 0 ? (weeklyHours / weeklyTargetConst) * 100 : 0,
        daysLeft: Infinity,
        daysPassed,
        status: weeklyRemaining > 0.01 ? 'behind-schedule' : 'on-track',
        statusColor: weeklyRemaining > 0.01 ? 'red' : 'green',
        reason:
          weeklyRemaining > 0.01
            ? 'Below the expected weekly pace.'
            : 'On weekly pace.',
        weeklyExpected: weeklyTargetConst,
        monthlyExpected: monthlyTargetConst,
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
        weeklyCommitmentHours: weeklyTargetConst,
        weeklyTargetBeforeRollingCredit: weeklyTargetConst,
        rolling30SurplusHours: 0,
        monthlyTargetConst,
        requiredDailyPace,
        paceRemainingWorkdays,
        paceRemainingHours
      };
    }
    // Period targets are anchored to the period start. They should not move
    // during the week/month just because yesterday was over or under target.
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
    const rollingTargetStart = maxDate(rollingBounds.start, created);
    const rolling30TargetConst = rollingTargetStart
      ? getProjectPlannedHoursForPeriod(
          project,
          entries,
          rollingTargetStart,
          rollingBounds.endExclusive
        )
      : 0;
    const rolling30SurplusHours = 0;
    const weeklyTargetBeforeRollingCredit = weeklyTargetConst;
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
        weeklyCommitmentHours: 0,
        weeklyTargetBeforeRollingCredit: 0,
        rolling30SurplusHours: 0,
        monthlyTargetConst: 0,
        requiredDailyPace,
        paceRemainingWorkdays,
        paceRemainingHours
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
      weeklyCommitmentHours: weeklyTargetConst,
      weeklyTargetBeforeRollingCredit,
      rolling30SurplusHours,
      monthlyTargetConst,
      requiredDailyPace,
      paceRemainingWorkdays,
      paceRemainingHours
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

  function getProjectCompletedHoursForPeriod(
    projectId,
    start,
    end,
    options = {}
  ) {
    const projectEntries = getCompletedProjectEntries(projectId, options);
    return sumEntryHours(projectEntries, start, end);
  }

  function getProjectDailyPlan(project, stats, context, options = {}) {
    const weekContext = context || getCurrentWeekPlanningContext();
    const projectStats = stats || computeProjectStats(project, options);
    const todayHours = getProjectCompletedHoursForPeriod(
      project.id,
      weekContext.todayStart,
      weekContext.todayEnd,
      options
    );
    const weekHoursBeforeToday = getProjectCompletedHoursForPeriod(
      project.id,
      weekContext.startWeek,
      weekContext.todayStart,
      options
    );
    const weeklyTarget = Math.max(
      0,
      Number(projectStats.weeklyTargetConst) || 0
    );
    const requiredDailyPace = Math.max(
      0,
      Number(projectStats.requiredDailyPace) || 0
    );
    const todayIsWorkday =
      countWorkdays(weekContext.todayStart, weekContext.todayEnd) > 0;
    const remainingAtStartOfDay = Math.max(
      0,
      weeklyTarget - weekHoursBeforeToday
    );
    const dailyTarget =
      todayIsWorkday && weekContext.workDaysLeftInWeek > 0
        ? remainingAtStartOfDay / weekContext.workDaysLeftInWeek
        : 0;
    return {
      todayHours,
      requiredDailyPace,
      weeklyCommitmentHours: weeklyTarget,
      dailyTarget,
      recommendedToday: dailyTarget,
      remainingToday: Math.max(0, dailyTarget - todayHours),
      weeklyRemaining: Math.max(
        0,
        weeklyTarget - weekHoursBeforeToday - todayHours
      )
    };
  }

  function getDailyPlanRecommendedRemaining(dailyPlan) {
    const adjusted = Number(dailyPlan?.recommendedRemainingToday);
    if (Number.isFinite(adjusted)) return Math.max(0, adjusted);
    return Math.max(0, Number(dailyPlan?.remainingToday) || 0);
  }

  function applyPortfolioDailyCredit(dailyPlans) {
    if (!dailyPlans || !dailyPlans.size) return dailyPlans;
    let portfolioDailyTarget = 0;
    let portfolioTodayHours = 0;
    dailyPlans.forEach((plan) => {
      portfolioDailyTarget += Math.max(0, Number(plan.dailyTarget) || 0);
      portfolioTodayHours += Math.max(0, Number(plan.todayHours) || 0);
    });
    const portfolioRemainingToday = Math.max(
      0,
      portfolioDailyTarget - portfolioTodayHours
    );
    dailyPlans.forEach((plan) => {
      plan.portfolioRemainingToday = portfolioRemainingToday;
      plan.recommendedRemainingToday = Math.min(
        Math.max(0, Number(plan.remainingToday) || 0),
        portfolioRemainingToday
      );
    });
    return dailyPlans;
  }

  function getProjectRecommendationPressure(item, dailyPlan) {
    const remainingToday = getDailyPlanRecommendedRemaining(dailyPlan);
    if (remainingToday <= 0.01) return 0;
    const requiredDailyPace = Math.max(
      0,
      Number(dailyPlan?.requiredDailyPace ?? item.stats.requiredDailyPace) || 0
    );
    const remainingWorkdaysRaw = Number(item.stats.paceRemainingWorkdays);
    const remainingWorkdays =
      Number.isFinite(remainingWorkdaysRaw) && remainingWorkdaysRaw > 0
        ? remainingWorkdaysRaw
        : 1;
    const positiveScheduleDeficit = Math.max(
      0,
      Number(item.stats.totalScheduleDeficit) || 0
    );
    const deficitPerWorkday = positiveScheduleDeficit / remainingWorkdays;
    const urgencyLoad = requiredDailyPace / remainingWorkdays;
    return remainingToday + requiredDailyPace + deficitPerWorkday + urgencyLoad;
  }

  function getRecommendedProjectEntry(perProjectStats, dailyPlanByProjectId) {
    let recommendedProjectEntry = null;
    let bestPressure = -Infinity;
    let bestRemainingToday = 0;
    let bestWeeklyRemaining = 0;
    perProjectStats.forEach((item) => {
      const dailyPlan =
        dailyPlanByProjectId &&
        dailyPlanByProjectId.get(String(item.project.id));
      const plan = dailyPlan || getProjectDailyPlan(item.project, item.stats);
      const remainingToday = getDailyPlanRecommendedRemaining(plan);
      const weeklyRemaining = Math.max(0, Number(plan.weeklyRemaining) || 0);
      const pressure = getProjectRecommendationPressure(item, plan);
      if (
        remainingToday > 0.01 &&
        (pressure > bestPressure + 0.01 ||
          (Math.abs(pressure - bestPressure) <= 0.01 &&
            (remainingToday > bestRemainingToday + 0.01 ||
              (Math.abs(remainingToday - bestRemainingToday) <= 0.01 &&
                weeklyRemaining > bestWeeklyRemaining + 0.01))))
      ) {
        bestPressure = pressure;
        bestRemainingToday = remainingToday;
        bestWeeklyRemaining = weeklyRemaining;
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
    // Start of this week (Monday 00:00) - the weekly period resets on Mondays. We calculate
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
    // deadline. The sum of these per-project targets represents the number of hours
    // you should aim to work this week and this month across all projects.
    let weeklyTarget = 0;
    let monthTarget = 0;
    let rollingTarget = 0;
    let dailyTarget = 0;
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project, now)
    );
    const weekContext = getCurrentWeekPlanningContext(now);
    activeProjects.forEach((project) => {
      const sp = computeProjectStats(project);
      weeklyTarget += sp.weeklyTargetConst || 0;
      monthTarget += sp.monthlyTargetConst || 0;
      rollingTarget += sp.rolling30TargetConst || 0;
      dailyTarget += getProjectDailyPlan(project, sp, weekContext).dailyTarget;
    });
    const rollingBounds = getRollingWindowBounds(now);
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
    applyPortfolioDailyCredit(dailyPlanByProjectId);
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
    // only Monday-Friday as working days. Use countWorkdays() to determine the total number of
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
      ? 'Week paused - no workouts required'
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
        icon: 'Day',
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
        icon: 'Week',
        // Progress label expresses hours progress relative to target and time progress relative to the week
        progressLabel:
          (stats.weeklyProgress || 0).toFixed(1) +
          '% of weekly commitment in ' +
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
        icon: 'Fit',
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
      // Append per-project breakdowns underneath each card. For Today, display today's hours
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
    updateAppHealthPanel();
    renderProjectOverview();
    renderDetailedBreakdown();
    // Render daily hours heatmap and update burndown chart
    renderHeatmap();
    updateBurndownSelect();
    // Previously there was a separate Recommendations card here. It has been removed in favor of integrating suggestions directly into other sections.
    renderTodayCommandPanel();

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
        starM.textContent = '*';
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
        (isWeeklyPaceProject(project)
          ? `h total | ${stats.weeklyHours.toFixed(1)} / ${stats.weeklyTargetConst.toFixed(1)}h this week`
          : `h / ${project.budgetHours.toFixed(1)}h | ${stats.requiredDailyPace.toFixed(1)}h/day pace`);
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
        totalProjectDaysProg > 0 && Number.isFinite(totalProjectDaysProg)
          ? (stats.daysPassed / totalProjectDaysProg) * 100
          : stats.weeklyTargetConst > 0
            ? (stats.weeklyHours / stats.weeklyTargetConst) * 100
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
      '<tr><th>Project</th><th>Client</th><th>Hours</th><th>Budget</th><th>Status</th><th>Daily Pace</th><th>This Week</th><th>Last Week</th><th>30-Day Pace</th><th>Revenue</th></tr>';
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
      const projectName = escapeHtml(project.name);
      const projectClient = escapeHtml(project.client || '-');
      const statusColor = safeStatusColor(stats.statusColor);
      const statusTitle = stats.reason
        ? ` title="${escapeHtml(stats.reason)}"`
        : '';
      tr.innerHTML = `
              <td data-label="Project">${projectName}</td>
              <td data-label="Client">${projectClient}</td>
              <td data-label="Hours">${stats.totalHours.toFixed(1)}h</td>
              <td data-label="Budget">${isWeeklyPaceProject(project) ? `${getProjectWeeklyExpectedHours(project).toFixed(1)}h/week` : `${project.budgetHours.toFixed(1)}h`}</td>
              <td data-label="Status"><span class="status-badge ${statusColor}"${statusTitle}>${statusLabel}</span></td>
              <td data-label="Daily Pace">${stats.requiredDailyPace.toFixed(1)}h/workday</td>
              <td data-label="This Week">${stats.weeklyHours.toFixed(1)} / ${stats.weeklyCommitmentHours.toFixed(1)}h (commitment)</td>
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

  function isProjectArchived(project) {
    return !!(project && (project.archived || project.isActive === false));
  }

  function getActiveProjects() {
    return data.projects.filter((project) => !isProjectArchived(project));
  }

  function getProjectScheduleType(project) {
    return isWeeklyPaceProject(project) ? 'weekly' : 'deadline';
  }

  function getProjectDialogFields(project) {
    const scheduleType = getProjectScheduleType(project);
    const rounding = Number.isFinite(Number(project.roundingMinutes))
      ? String(project.roundingMinutes)
      : '0';
    const roundingOptions = [
      { value: '0', label: 'None' },
      { value: '5', label: '5 minutes' },
      { value: '10', label: '10 minutes' },
      { value: '15', label: '15 minutes' }
    ];
    if (!roundingOptions.some((option) => option.value === rounding)) {
      roundingOptions.push({ value: rounding, label: `${rounding} minutes` });
    }
    return [
      {
        name: 'name',
        label: 'Project Name',
        value: project.name || '',
        required: true
      },
      {
        name: 'client',
        label: 'Client',
        value: project.client || ''
      },
      {
        name: 'scheduleType',
        label: 'Project Type',
        type: 'select',
        value: scheduleType,
        options: [
          { value: 'deadline', label: 'Deadline budget' },
          { value: 'weekly', label: 'Weekly pace, no deadline' }
        ]
      },
      {
        name: 'budgetHours',
        label: 'Budget Hours',
        type: 'number',
        min: 0,
        step: 0.1,
        value: project.budgetHours || 0,
        visibleWhen: (controls) =>
          controls.scheduleType && controls.scheduleType.value === 'deadline'
      },
      {
        name: 'weeklyExpectedHours',
        label: 'Expected Hours / Week',
        type: 'number',
        min: 0,
        step: 0.1,
        value: getProjectWeeklyExpectedHours(project) || 0,
        visibleWhen: (controls) =>
          controls.scheduleType && controls.scheduleType.value === 'weekly'
      },
      {
        name: 'hourlyRate',
        label: 'Hourly Rate',
        type: 'number',
        min: 0,
        step: 0.01,
        value: project.hourlyRate || 0,
        required: true
      },
      {
        name: 'startDate',
        label: 'Start Date',
        type: 'date',
        value:
          project.startDate ||
          formatLocalDateString(getProjectStartDate(project))
      },
      {
        name: 'deadline',
        label: 'Deadline',
        type: 'date',
        value: project.deadline || '',
        visibleWhen: (controls) =>
          controls.scheduleType && controls.scheduleType.value === 'deadline'
      },
      {
        name: 'roundingMinutes',
        label: 'Rounding',
        type: 'select',
        value: rounding,
        options: roundingOptions
      }
    ];
  }

  function applyProjectDialogValues(project, values) {
    const name = String(values.name || '').trim();
    const scheduleType =
      values.scheduleType === 'weekly' ? 'weekly' : 'deadline';
    const budgetHours = Number(values.budgetHours);
    const weeklyExpectedHours = Number(values.weeklyExpectedHours);
    const hourlyRate = Number(values.hourlyRate);
    const startDate = String(values.startDate || '').trim();
    const deadline = String(values.deadline || '').trim();
    const roundingMinutes = Number.parseInt(values.roundingMinutes, 10);
    if (!name) {
      showToast('Project name is required.');
      return false;
    }
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      showToast('Enter a valid hourly rate.');
      return false;
    }
    if (startDate && !parseLocalDateString(startDate)) {
      showToast('Enter a valid start date.');
      return false;
    }
    if (scheduleType === 'deadline') {
      if (!Number.isFinite(budgetHours) || budgetHours < 0) {
        showToast('Enter valid budget hours.');
        return false;
      }
      if (!deadline || !parseLocalDateString(deadline)) {
        showToast('Enter a valid deadline.');
        return false;
      }
    }
    if (
      scheduleType === 'weekly' &&
      (!Number.isFinite(weeklyExpectedHours) || weeklyExpectedHours < 0)
    ) {
      showToast('Enter valid expected weekly hours.');
      return false;
    }
    project.name = name;
    project.client = String(values.client || '').trim() || null;
    project.scheduleType = scheduleType;
    project.budgetHours =
      scheduleType === 'deadline' ? Math.max(0, budgetHours) : 0;
    project.weeklyExpectedHours =
      scheduleType === 'weekly' ? Math.max(0, weeklyExpectedHours) : 0;
    project.hourlyRate = hourlyRate;
    project.startDate = startDate || formatLocalDateString(new Date());
    project.deadline = scheduleType === 'deadline' ? deadline : '';
    project.roundingMinutes = Number.isFinite(roundingMinutes)
      ? roundingMinutes
      : 0;
    return true;
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
    const projectsToRender = data.projects.filter(
      (project) => showArchivedProjects || !isProjectArchived(project)
    );
    if (projectsToRender.length === 0) {
      const p = document.createElement('p');
      p.textContent =
        'No active projects. Show archived projects to review older work.';
      container.appendChild(p);
      return;
    }
    projectsToRender.forEach((project) => {
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
      const isWeeklyProject = isWeeklyPaceProject(project);
      const expectedProgressPct =
        stats.daysPassed + stats.daysLeft > 0 && Number.isFinite(stats.daysLeft)
          ? (stats.daysPassed / (stats.daysPassed + stats.daysLeft)) * 100
          : stats.weeklyTargetConst > 0
            ? Math.min(100, (stats.weeklyHours / stats.weeklyTargetConst) * 100)
            : 0;
      const projectIdAttr = escapeHtml(project.id);
      const projectName = escapeHtml(project.name);
      const projectClient = escapeHtml(project.client || '-');
      const statusColor = isProjectArchived(project)
        ? 'amber'
        : safeStatusColor(stats.statusColor);
      const statusTitle = stats.reason
        ? ` title="${escapeHtml(stats.reason)}"`
        : '';
      const budgetLine = isWeeklyProject
        ? `<p style="margin:0 0 0.25rem 0;"><strong>Expected:</strong> ${getProjectWeeklyExpectedHours(project).toFixed(1)}h/week @ ${formatCurrency(project.hourlyRate)}</p>`
        : `<p style="margin:0 0 0.25rem 0;"><strong>Budget:</strong> ${project.budgetHours.toFixed(1)}h @ ${formatCurrency(project.hourlyRate)}</p>`;
      const deadlineLine = isWeeklyProject
        ? '<p style="margin:0.25rem 0;"><strong>Deadline:</strong> None</p>'
        : `<p style="margin:0.25rem 0;"><strong>Deadline:</strong> ${formatDate(project.deadline)}</p>`;
      const paceLine = `<p style="margin:0.25rem 0;"><strong>Required pace:</strong> ${stats.requiredDailyPace.toFixed(1)}h/workday</p>`;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
              <h3 style="margin:0 0 0.5rem 0; font-size:1.1rem; font-weight:600;">${projectName}</h3>
              <p style="margin:0 0 0.25rem 0;"><strong>Client:</strong> ${projectClient}</p>
              ${budgetLine}
              ${paceLine}
              <div style="margin:0.5rem 0;">
                <!-- Dual progress bars showing actual hours vs expected timeline progress -->
                <div style="display:flex; flex-direction:column; gap:0.2rem; margin-bottom:0.25rem;">
                  <!-- Actual hours consumed (blue) -->
                  <div class="progress-bar"><div class="fill" style="width:${Math.min(100, stats.usedPct).toFixed(1)}%;"></div></div>
                  <!-- Expected progress based on time elapsed relative to deadline (black) -->
                  <div class="progress-bar"><div class="fill" style="width:${expectedProgressPct.toFixed(1)}%; background-color:#000000;"></div></div>
                </div>
                <small>${stats.totalHours.toFixed(1)}h logged${isWeeklyProject ? ` &bullet; ${stats.weeklyHours.toFixed(1)}h this week` : ` (${stats.usedPct.toFixed(1)}%) &bullet; Expected ${expectedProgressPct.toFixed(1)}%`}</small>
              </div>
              <div style="margin:0.5rem 0;">
                <div class="progress-bar" style="margin-bottom:0.25rem;"><div class="fill" style="width:${stats.weeklyTargetConst ? (stats.weeklyHours / stats.weeklyTargetConst) * 100 : 0}%"></div></div>
                <small>This week: ${stats.weeklyHours.toFixed(1)} / ${stats.weeklyCommitmentHours.toFixed(1)}h (commitment)</small>
              </div>
              <div style="margin:0.5rem 0;">
                <div class="progress-bar" style="margin-bottom:0.25rem;"><div class="fill" style="width:${stats.rolling30TargetConst ? (stats.rolling30Hours / stats.rolling30TargetConst) * 100 : 0}%"></div></div>
                <small>30-day pace: ${stats.rolling30Hours.toFixed(1)} / ${stats.rolling30TargetConst.toFixed(1)}h${isRecommendedMonthly ? ' (Recommended)' : ''}</small>
              </div>
              <p style="margin:0.25rem 0;"><strong>Start Date:</strong> ${formatDate(project.startDate || project.createdAt)}</p>
              ${deadlineLine}
              <p style="margin:0.25rem 0;"><strong>Status:</strong> <span class="status-badge ${statusColor}"${statusTitle}>${isProjectArchived(project) ? 'Archived' : statusLabel}</span></p>
              <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
                <button class="btn secondary edit-btn" data-id="${projectIdAttr}">Edit</button>
                <button class="btn secondary archive-btn" data-id="${projectIdAttr}">${isProjectArchived(project) ? 'Restore' : 'Archive'}</button>
                <button class="btn danger delete-btn" data-id="${projectIdAttr}">Delete</button>
              </div>
            `;
      // Edit button handler
      const editBtn = card.querySelector('.edit-btn');
      editBtn.addEventListener('click', async () => {
        const values = await openFormDialog({
          title: 'Edit Project',
          fields: getProjectDialogFields(project),
          submitLabel: 'Save Project'
        });
        if (!values) return;
        const snapshot = cloneData();
        if (!applyProjectDialogValues(project, values)) return;
        saveData();
        refreshAllViews();
        offerUndo('Project updated.', snapshot);
      });
      const archiveBtn = card.querySelector('.archive-btn');
      archiveBtn.addEventListener('click', () => {
        const snapshot = cloneData();
        const archived = !isProjectArchived(project);
        project.archived = archived;
        project.isActive = !archived;
        saveData();
        refreshAllViews();
        offerUndo(
          archived ? 'Project archived.' : 'Project restored.',
          snapshot
        );
      });
      // Delete button handler
      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', async () => {
        const ok = await requestConfirm({
          title: 'Delete Project',
          message: 'Delete this project and all of its entries?',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        const snapshot = cloneData();
        data.projects = data.projects.filter((p) => p.id !== project.id);
        data.entries = data.entries.filter((e) => e.projectId !== project.id);
        saveData();
        refreshAllViews();
        offerUndo('Project deleted.', snapshot);
      });
      container.appendChild(card);
    });
  }

  // Create new project
  function updateProjectFormScheduleFields() {
    const typeInput = document.getElementById('projectScheduleTypePro');
    const budgetInput = document.getElementById('projectBudgetPro');
    const weeklyInput = document.getElementById('projectWeeklyHoursPro');
    const deadlineInput = document.getElementById('projectDeadlinePro');
    const isWeekly = typeInput && typeInput.value === 'weekly';
    if (budgetInput) {
      budgetInput.required = !isWeekly;
      budgetInput.style.display = isWeekly ? 'none' : '';
      const budgetLabel = document.querySelector(
        'label[for="projectBudgetPro"]'
      );
      if (budgetLabel) budgetLabel.style.display = isWeekly ? 'none' : '';
    }
    if (weeklyInput) {
      weeklyInput.required = !!isWeekly;
      weeklyInput.style.display = isWeekly ? '' : 'none';
      const weeklyLabel = document.querySelector(
        'label[for="projectWeeklyHoursPro"]'
      );
      if (weeklyLabel) weeklyLabel.style.display = isWeekly ? '' : 'none';
    }
    if (deadlineInput) {
      deadlineInput.required = !isWeekly;
      deadlineInput.style.display = isWeekly ? 'none' : '';
      const deadlineLabel = document.querySelector(
        'label[for="projectDeadlinePro"]'
      );
      if (deadlineLabel) deadlineLabel.style.display = isWeekly ? 'none' : '';
    }
  }
  const projectScheduleTypeInput = document.getElementById(
    'projectScheduleTypePro'
  );
  if (projectScheduleTypeInput) {
    projectScheduleTypeInput.addEventListener(
      'change',
      updateProjectFormScheduleFields
    );
    updateProjectFormScheduleFields();
  }
  const showArchivedProjectsToggle = document.getElementById(
    'showArchivedProjectsToggle'
  );
  if (showArchivedProjectsToggle) {
    showArchivedProjectsToggle.checked = showArchivedProjects;
    showArchivedProjectsToggle.addEventListener('change', () => {
      showArchivedProjects = showArchivedProjectsToggle.checked;
      updateProjectsPage();
    });
  }
  document.getElementById('projectFormPro').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('projectNamePro').value.trim();
    const client = document.getElementById('projectClientPro').value.trim();
    const scheduleType =
      document.getElementById('projectScheduleTypePro')?.value === 'weekly'
        ? 'weekly'
        : 'deadline';
    const budgetInputValue = document.getElementById('projectBudgetPro').value;
    const budget = parseFloat(budgetInputValue);
    const weeklyExpectedHours = parseFloat(
      document.getElementById('projectWeeklyHoursPro')?.value || ''
    );
    const rate = parseFloat(document.getElementById('projectRatePro').value);
    const startDateInput = document.getElementById('projectStartDatePro').value;
    const deadline = document.getElementById('projectDeadlinePro').value;
    if (!name) return;
    if (scheduleType === 'deadline' && (!deadline || !Number.isFinite(budget)))
      return;
    if (scheduleType === 'weekly' && !Number.isFinite(weeklyExpectedHours))
      return;
    const startDate = startDateInput || formatLocalDateString(new Date());
    const newProject = {
      id: uuid(),
      name,
      client: client || null,
      scheduleType,
      budgetHours:
        scheduleType === 'deadline'
          ? budget
          : Number.isFinite(budget)
            ? Math.max(0, budget)
            : 0,
      weeklyExpectedHours:
        scheduleType === 'weekly' ? Math.max(0, weeklyExpectedHours) : 0,
      hourlyRate: rate,
      startDate,
      deadline: scheduleType === 'deadline' ? deadline : '',
      createdAt: new Date().toISOString(),
      color: getUniqueColor(),
      isActive: true,
      archived: false,
      // Store rounding preference for this project; roundingMinutes is the interval in minutes (0 means no rounding)
      roundingMinutes:
        parseInt(document.getElementById('projectRoundingPro').value, 10) || 0
    };
    data.projects.push(newProject);
    saveData();
    e.target.reset();
    updateProjectFormScheduleFields();
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
        showToast('Please enter a payment name.');
        nameInput.focus();
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        showToast('Enter a valid amount.');
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
        showToast('Please enter an item name.');
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
        showToast(
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

  const TIMER_LONG_RUNNING_WARNING_MS = 4 * 60 * 60 * 1000;

  function getRunningTimerWarnings(entry, now = new Date()) {
    if (!entry || !entry.startTime) return [];
    const start = new Date(entry.startTime);
    if (Number.isNaN(start.getTime())) return [];
    const warnings = [];
    if (start < startOfLocalDay(now)) {
      warnings.push(
        'Started before today. Check whether this timer was left running overnight.'
      );
    }
    const wallClockMs = now.getTime() - start.getTime();
    if (!isTimerPaused(entry) && wallClockMs >= TIMER_LONG_RUNNING_WARNING_MS) {
      warnings.push(
        `Running for ${formatDuration(Math.floor(wallClockMs / 1000))} wall-clock. Check it is still active.`
      );
    }
    return warnings;
  }

  function getRunningEntryEffectiveSeconds(entry, now = new Date()) {
    const paused = isTimerPaused(entry);
    const last = entry.lastUpdateTime
      ? new Date(entry.lastUpdateTime)
      : new Date(entry.startTime);
    const previous = Number(entry.effectiveSeconds) || 0;
    if (paused || Number.isNaN(last.getTime())) return previous;
    const factor = getEntryActiveFactor(entry, getRunningEntries().length);
    return Math.max(0, previous + ((now - last) / 1000) * factor);
  }

  function appendCompactFocusFactorOptions(selectEl) {
    FOCUS_FACTOR_OPTIONS.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = String(option.value);
      opt.textContent = formatFocusPercent(option.value);
      selectEl.appendChild(opt);
    });
  }

  function ensureCurrentCompactFocusOption(selectEl, factor) {
    const value = String(normalizeFocusFactor(factor));
    const exists = Array.from(selectEl.options).some(
      (option) => option.value === value
    );
    if (exists) return value;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = formatFocusPercent(value);
    selectEl.appendChild(opt);
    return value;
  }

  function updateRunningTimerFactor(entryId, value) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry) return;
    const selectedFactor = normalizeFocusFactor(value);
    const snapshot = cloneData();
    const now = new Date();
    const runningEntries = getRunningEntries();
    const runningCount = runningEntries.length || 1;
    runningEntries.forEach((runningEntry) => {
      accumulateRunningEntry(runningEntry, now, runningCount);
    });
    entry.manualFactor = selectedFactor;
    entry.factor = selectedFactor;
    entry.focusFactor = selectedFactor;
    rebalanceActiveRunningFactors(now);
    saveData();
    refreshAllViews();
    provideHaptic('beep');
    offerUndo(
      `Timer focus set to ${formatFocusPercent(selectedFactor)}.`,
      snapshot
    );
  }

  function createRunningFactorSelect(entry, runningCount) {
    const select = document.createElement('select');
    select.className = 'running-factor-select';
    select.setAttribute('aria-label', 'Timer focus');
    select.title = 'Adjust timer focus';
    appendCompactFocusFactorOptions(select);
    select.value = ensureCurrentCompactFocusOption(
      select,
      getEntryActiveFactor(entry, runningCount)
    );
    select.addEventListener('change', () => {
      updateRunningTimerFactor(entry.id, select.value);
    });
    return select;
  }

  function adjustRunningTimerElapsed(entryId, actualSeconds) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry || !Number.isFinite(actualSeconds) || actualSeconds === 0) {
      return;
    }
    const now = new Date();
    const currentFactor = accumulateRunningEntry(
      entry,
      now,
      getRunningEntries().length
    );
    const delta = actualSeconds * currentFactor;
    entry.effectiveSeconds = Math.max(0, (entry.effectiveSeconds || 0) + delta);
    saveData();
    updateTimerSection();
    provideHaptic('beep');
  }

  function createRunningTimerNudgeButton(entry, seconds, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn secondary';
    button.textContent = label;
    button.addEventListener('click', () => {
      adjustRunningTimerElapsed(entry.id, seconds);
    });
    return button;
  }

  function renderMobileNowBar(now = new Date()) {
    const bar = document.getElementById('mobileNowBar');
    if (!bar) return;
    if (
      !isMobileViewport() ||
      activeSectionId === 'timer' ||
      isManualEntryFormOpen()
    ) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      delete bar.dataset.renderKey;
      return;
    }
    const runningEntries = getRunningEntries();
    if (!runningEntries.length) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      delete bar.dataset.renderKey;
      return;
    }
    const activeEntries = getActiveRunningEntries();
    const entry = activeEntries[0] || runningEntries[0];
    const project = getEntryProject(entry);
    const focus = getEntryActiveFactor(entry, runningEntries.length);
    const effective = getRunningEntryEffectiveSeconds(entry, now);
    const paused = isTimerPaused(entry);
    const labelText =
      runningEntries.length > 1
        ? `${runningEntries.length} timers`
        : project
          ? project.name
          : 'Running timer';
    const detailText = `${formatDuration(Math.floor(effective))} - ${formatFocusPercent(focus)}${paused ? ' - paused' : ''}`;
    const renderKey = [
      entry.id,
      runningEntries.map((runningEntry) => runningEntry.id).join(','),
      paused ? 'paused' : 'active',
      runningEntries.length > 1 ? 'multi' : 'single'
    ].join('|');
    bar.classList.remove('hidden');

    if (bar.dataset.renderKey === renderKey) {
      const label = bar.querySelector('.mobile-now-label');
      if (label) label.textContent = labelText;
      const detail = bar.querySelector('.mobile-now-summary strong');
      if (detail) detail.textContent = detailText;
      const select = bar.querySelector('.running-factor-select');
      if (select && document.activeElement !== select) {
        select.value = ensureCurrentCompactFocusOption(select, focus);
      }
      return;
    }

    bar.dataset.renderKey = renderKey;
    bar.innerHTML = '';

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'mobile-now-summary';
    summary.addEventListener('click', () =>
      openMobileRunningTimerSheet(entry.id)
    );
    const label = document.createElement('span');
    label.className = 'mobile-now-label';
    label.textContent =
      runningEntries.length > 1
        ? `${runningEntries.length} timers`
        : project
          ? project.name
          : 'Running timer';
    const detail = document.createElement('strong');
    detail.textContent = `${formatDuration(Math.floor(effective))} - ${formatFocusPercent(focus)}${paused ? ' - paused' : ''}`;
    summary.appendChild(label);
    summary.appendChild(detail);
    bar.appendChild(summary);

    const controls = document.createElement('div');
    controls.className = 'mobile-now-controls';
    controls.appendChild(
      createRunningFactorSelect(entry, runningEntries.length)
    );
    controls.appendChild(createRunningTimerNudgeButton(entry, -300, '-5m'));
    controls.appendChild(createRunningTimerNudgeButton(entry, 300, '+5m'));
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn danger';
    stopBtn.textContent = runningEntries.length > 1 ? 'Stop All' : 'Stop';
    stopBtn.addEventListener('click', () => {
      if (runningEntries.length > 1) stopAllTimers();
      else stopSingleTimer(entry.id);
    });
    controls.appendChild(stopBtn);
    bar.appendChild(controls);
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
      if (startDiv.parentNode === runningDiv.parentNode) {
        startDiv.parentNode.insertBefore(runningDiv, startDiv);
      }
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
      // Display the sum of all active focus factors.
      const totalFactorP = document.createElement('p');
      totalFactorP.innerHTML =
        '<strong>Total Focus:</strong> <span id="runningTotalFactor"></span>';
      totalFactorP.style.marginBottom = '0.5rem';
      toolbar.appendChild(totalFactorP);
      const focusStatusPanel = document.createElement('div');
      focusStatusPanel.className = 'focus-status-panel';
      focusStatusPanel.id = 'runningFocusStatus';
      toolbar.appendChild(focusStatusPanel);
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
      updateFocusStatusPanel(getPaidFocusTotal());
      // Render each running entry
      runningEntries.forEach((entry) => {
        const project = data.projects.find((p) => p.id === entry.projectId);
        const row = document.createElement('div');
        row.className = 'timer-running-row';
        row.style.marginBottom = '0.75rem';
        // Project name
        const nameP = document.createElement('p');
        appendLabeledText(nameP, 'Project:', project ? project.name : '');
        row.appendChild(nameP);
        if (entry.description) {
          const descriptionP = document.createElement('p');
          appendLabeledText(descriptionP, 'Description:', entry.description);
          row.appendChild(descriptionP);
        }
        // Started time
        const startP = document.createElement('p');
        appendLabeledText(startP, 'Started:', formatDateTime(entry.startTime));
        row.appendChild(startP);
        const timerWarnings = getRunningTimerWarnings(entry);
        if (timerWarnings.length) {
          const warningList = document.createElement('div');
          warningList.className = 'timer-warning';
          warningList.setAttribute('role', 'status');
          timerWarnings.forEach((warningText) => {
            const warning = document.createElement('div');
            warning.textContent = warningText;
            warningList.appendChild(warning);
          });
          row.appendChild(warningList);
        }
        // Elapsed time
        const elapsedP = document.createElement('p');
        elapsedP.innerHTML = '<strong>Elapsed:</strong> ';
        const elapsedSpan = document.createElement('span');
        elapsedSpan.id = 'runningElapsed-' + entry.id;
        elapsedSpan.textContent = '';
        elapsedP.appendChild(elapsedSpan);
        row.appendChild(elapsedP);
        // Factor display (for example, 100%, 150%, or 50%).
        const factorP = document.createElement('p');
        factorP.innerHTML = '<strong>Factor:</strong> ';
        const factorSpan = document.createElement('span');
        factorSpan.id = 'runningFactor-' + entry.id;
        factorSpan.textContent = '';
        factorP.appendChild(factorSpan);
        row.appendChild(factorP);
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
          adjustRunningTimerElapsed(entry.id, -300);
        });
        nudgeDiv.appendChild(minusBtn);
        // Plus 5 minutes button
        const plusBtn = document.createElement('button');
        plusBtn.className = 'btn secondary';
        plusBtn.textContent = '+5m';
        plusBtn.style.padding = '0.25rem 0.5rem';
        plusBtn.style.fontSize = '0.75rem';
        plusBtn.addEventListener('click', () => {
          adjustRunningTimerElapsed(entry.id, 300);
        });
        nudgeDiv.appendChild(plusBtn);
        row.appendChild(nudgeDiv);
        const runningControls = document.createElement('div');
        runningControls.className = 'timer-actions';
        const projectSwitch = document.createElement('select');
        const currentOption = document.createElement('option');
        currentOption.value = entry.projectId;
        currentOption.textContent = project ? project.name : 'Current project';
        projectSwitch.appendChild(currentOption);
        getActiveProjects().forEach((candidate) => {
          if (String(candidate.id) === String(entry.projectId)) return;
          const option = document.createElement('option');
          option.value = candidate.id;
          option.textContent = candidate.name;
          projectSwitch.appendChild(option);
        });
        projectSwitch.value = entry.projectId;
        projectSwitch.title = 'Switch this running timer to another project';
        projectSwitch.setAttribute('aria-label', 'Switch timer project');
        projectSwitch.addEventListener('change', () => {
          switchRunningTimerProject(entry.id, projectSwitch.value);
        });
        runningControls.appendChild(projectSwitch);
        runningControls.appendChild(
          createRunningFactorSelect(entry, runningEntries.length)
        );
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'btn secondary';
        pauseBtn.textContent = isTimerPaused(entry) ? 'Resume' : 'Pause';
        pauseBtn.addEventListener('click', () => {
          if (isTimerPaused(entry)) {
            resumeTimer(entry.id);
          } else {
            pauseTimer(entry.id);
          }
        });
        runningControls.appendChild(pauseBtn);
        const editTimerBtn = document.createElement('button');
        editTimerBtn.className = 'btn secondary';
        editTimerBtn.textContent = 'Edit';
        editTimerBtn.addEventListener('click', () => {
          editRunningTimer(entry.id);
        });
        runningControls.appendChild(editTimerBtn);
        // Stop button
        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn danger';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => {
          stopSingleTimer(entry.id);
        });
        runningControls.appendChild(stopBtn);
        row.appendChild(runningControls);
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
        renderMobileNowBar(now);
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
          const paused = isTimerPaused(entry);
          const last = entry.lastUpdateTime
            ? new Date(entry.lastUpdateTime)
            : new Date(entry.startTime);
          const prev = entry.effectiveSeconds || 0;
          const factor = getEntryActiveFactor(entry, runningEntries.length);
          const extra = paused ? 0 : ((now - last) / 1000) * factor;
          const effective = prev + extra;
          totalElapsedSeconds += effective;
          if (!paused) totalFactor += factor;
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
            elapsedSpan.textContent =
              formatDuration(Math.floor(effective)) +
              (paused ? ' (paused)' : '');
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
      if (startDiv.parentNode === runningDiv.parentNode) {
        startDiv.parentNode.insertBefore(startDiv, runningDiv);
      }
      renderMobileNowBar();
    }
    // update project selects
    updateProjectSelects();
    renderTodayCommandPanel();
  }

  function pauseTimer(entryId) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry || isTimerPaused(entry)) return;
    const now = new Date();
    accumulateRunningEntry(entry, now, getRunningEntries().length);
    entry.pausedAt = now.toISOString();
    rebalanceActiveRunningFactors(now);
    saveData();
    updateTimerSection();
    updateFocusBlocker();
  }

  function resumeTimer(entryId) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry || !isTimerPaused(entry)) return;
    const now = new Date();
    delete entry.pausedAt;
    entry.lastUpdateTime = now.toISOString();
    rebalanceActiveRunningFactors(now);
    saveData();
    updateTimerSection();
    updateFocusBlocker();
  }

  function switchRunningTimerProject(entryId, projectId) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry || !projectId) return;
    if (
      getRunningEntries().some(
        (other) =>
          other.id !== entryId && String(other.projectId) === String(projectId)
      )
    ) {
      showToast('A timer is already running for that project.');
      updateTimerSection();
      return;
    }
    const now = new Date();
    const snapshot = cloneData();
    accumulateRunningEntry(entry, now, getRunningEntries().length);
    entry.projectId = projectId;
    entry.lastUpdateTime = now.toISOString();
    saveData();
    refreshAllViews();
    offerUndo('Timer moved to another project.', snapshot);
  }

  async function editRunningTimer(entryId) {
    const entry = data.entries.find((e) => e.id === entryId && e.isRunning);
    if (!entry) return;
    const currentFactor = getEntryActiveFactor(
      entry,
      getRunningEntries().length
    );
    const factorOptions = FOCUS_FACTOR_OPTIONS.map((option) => ({
      value: String(option.value),
      label: option.label
    }));
    if (
      !factorOptions.some((option) => option.value === String(currentFactor))
    ) {
      factorOptions.push({
        value: String(currentFactor),
        label: `${formatFocusPercent(currentFactor)} - current`
      });
    }
    const values = await openFormDialog({
      title: 'Edit Running Timer',
      fields: [
        {
          name: 'description',
          label: 'Description',
          value: entry.description || ''
        },
        {
          name: 'startTime',
          label: 'Start Time',
          type: 'datetime-local',
          value: toDateTimeInputValue(entry.startTime),
          required: true
        },
        {
          name: 'focusFactor',
          label: 'Focus',
          type: 'select',
          value: String(currentFactor),
          options: factorOptions
        }
      ],
      submitLabel: 'Save Timer'
    });
    if (!values) return;
    const parsedStart = parseDateTimeInput(values.startTime);
    if (!parsedStart) {
      showToast('Enter a valid start time.');
      return;
    }
    const now = new Date();
    if (parsedStart > now) {
      showToast('Start time cannot be in the future.');
      return;
    }
    const snapshot = cloneData();
    const previousFactor = getEntryActiveFactor(
      entry,
      getRunningEntries().length
    );
    entry.description = String(values.description || '').trim();
    entry.startTime = parsedStart.toISOString();
    entry.lastUpdateTime = isTimerPaused(entry)
      ? entry.lastUpdateTime || now.toISOString()
      : now.toISOString();
    const selectedFactor = normalizeFocusFactor(values.focusFactor);
    entry.manualFactor = selectedFactor;
    entry.factor = selectedFactor;
    entry.focusFactor = selectedFactor;
    if (!isTimerPaused(entry)) {
      const activeFactor = getEntryActiveFactor(
        entry,
        getRunningEntries().length
      );
      entry.effectiveSeconds =
        Math.max(0, (now - parsedStart) / 1000) * activeFactor;
    } else {
      entry.effectiveSeconds =
        entry.effectiveSeconds ||
        Math.max(0, (now - parsedStart) / 1000) * previousFactor;
    }
    saveData();
    refreshAllViews();
    offerUndo('Timer updated.', snapshot);
  }

  // Stop a single running timer by id
  function stopSingleTimer(entryId) {
    const toStop = data.entries.find((e) => e.id === entryId && e.isRunning);
    // Provide tactile feedback when stopping a timer
    provideHaptic('long');
    if (!toStop) return;
    const snapshot = cloneData();
    const now = new Date();
    // Gather all running entries including the one to stop
    const runningEntries = getRunningEntries();
    const n = runningEntries.length;
    // First update effective seconds for all running entries using their current factor
    runningEntries.forEach((e) => {
      accumulateRunningEntry(e, now, n);
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
    delete toStop.pausedAt;
    const remaining = runningEntries.filter((e) => e.id !== entryId);
    remaining.forEach((e) => {
      e.factor = getEntryActiveFactor(e, remaining.length || 1);
      e.focusFactor = e.factor;
      e.lastUpdateTime = now.toISOString();
    });
    // Persist and refresh
    saveData();
    updateTimerSection();
    updateDashboard();
    updateEntriesTable();
    // Do not immediately save backup here; periodic auto-sync will handle exporting
    // Recompute focus blocker activation after stopping this timer. If the total
    // factor has dropped below or equal to 50%, the blocker will be disabled.
    updateFocusBlocker();
    offerUndo('Timer stopped.', snapshot);
  }
  let timerInterval = null;
  // Chart instances for weekly and monthly scatter plots
  let weeklyScatterChart = null;
  let monthlyScatterChart = null;
  function startProjectTimer(
    projectId,
    {
      description = '',
      initialHours = 0,
      overrideFactor = null,
      resetStartControls = false
    } = {}
  ) {
    if (!projectId) return;
    const projectToStart = data.projects.find(
      (project) => String(project.id) === String(projectId)
    );
    if (!projectToStart || isProjectArchived(projectToStart)) {
      showToast('Restore the project before starting a timer.');
      return;
    }
    // Check if there's already a running timer for this project
    const runningEntries = getRunningEntries();
    // Prevent starting multiple timers for the same project. Compare string representations of IDs to avoid mismatches.
    if (runningEntries.some((e) => String(e.projectId) === String(projectId))) {
      showToast(
        'A timer is already running for this project. You cannot start another timer for the same project.'
      );
      return;
    }
    // No immediate focus start here; activation of focus mode will be handled
    // by updateFocusBlocker() based on the total factor of running timers.

    // Provide tactile feedback when starting a timer
    provideHaptic('long');
    const now = new Date();
    const newEntryFactor = normalizeFocusFactor(overrideFactor);
    // Update all existing running entries without mutating their explicit focus.
    runningEntries.forEach((e) => {
      accumulateRunningEntry(e, now, runningEntries.length);
    });
    // Create new entry for the selected project
    const realStart = new Date(now.getTime() - initialHours * 3600 * 1000);
    const newEntry = {
      id: uuid(),
      projectId,
      description: String(description || '').trim(),
      startTime: realStart.toISOString(),
      endTime: null,
      duration: null,
      isRunning: true,
      createdAt: now.toISOString(),
      effectiveSeconds: initialHours * 3600,
      lastUpdateTime: now.toISOString(),
      factor: newEntryFactor,
      focusFactor: newEntryFactor,
      manualFactor: newEntryFactor
    };
    data.entries.push(newEntry);
    if (resetStartControls) {
      // Reset initial input and focus factor selection
      document.getElementById('timerDescriptionPro').value = '';
      document.getElementById('timerInitialPro').value = '';
      document.getElementById('startFactorPro').value =
        String(DEFAULT_FOCUS_FACTOR);
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
    const description = document.getElementById('timerDescriptionPro').value;
    // Hours already spent when starting the timer (pre-filled time)
    const initialHours =
      parseFloat(document.getElementById('timerInitialPro').value) || 0;
    const overrideFactor = document.getElementById('startFactorPro').value;
    startProjectTimer(projectId, {
      description,
      initialHours,
      overrideFactor,
      resetStartControls: true
    });
  });
  const pinTimerPresetBtn = document.getElementById('pinTimerPresetBtnPro');
  if (pinTimerPresetBtn) {
    pinTimerPresetBtn.addEventListener('click', () => {
      pinCurrentTimerPreset();
    });
  }
  document.getElementById('stopTimerBtnPro').addEventListener('click', () => {
    stopAllTimers();
  });

  // Stop all running timers at once, updating their weighted durations consistently
  function stopAllTimers() {
    const runningList = getRunningEntries();
    if (runningList.length === 0) return;
    const snapshot = cloneData();
    const now = new Date();
    const n = runningList.length;
    // Update effective seconds for all entries using their current factors
    runningList.forEach((e) => {
      accumulateRunningEntry(e, now, n);
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
      delete e.pausedAt;
    });
    saveData();
    updateTimerSection();
    updateDashboard();
    updateEntriesTable();
    // Do not immediately save backup here; periodic auto-sync will handle exporting
    // After stopping all timers, recompute focus blocker activation based on total factor
    updateFocusBlocker();
    offerUndo(
      runningList.length > 1 ? 'Timers stopped.' : 'Timer stopped.',
      snapshot
    );
  }

  function getStartFormTimerPreset() {
    const projectSelect = document.getElementById('timerProjectPro');
    const descriptionInput = document.getElementById('timerDescriptionPro');
    const factorSelect = document.getElementById('startFactorPro');
    const projectId = projectSelect ? projectSelect.value : '';
    const project = data.projects.find(
      (candidate) => String(candidate.id) === String(projectId)
    );
    if (!project || isProjectArchived(project)) return null;
    return {
      project,
      projectId: project.id,
      description: String(
        descriptionInput ? descriptionInput.value : ''
      ).trim(),
      focusFactor: normalizeFocusFactor(factorSelect ? factorSelect.value : 1)
    };
  }

  function pinCurrentTimerPreset() {
    const preset = getStartFormTimerPreset();
    if (!preset) {
      showToast('Choose an active project before pinning a timer.');
      return;
    }
    ensureTimerPresets();
    const now = new Date().toISOString();
    const key = makeTimerPresetKey(
      preset.projectId,
      preset.description,
      preset.focusFactor
    );
    const existing = data.timerPresets.find(
      (item) =>
        makeTimerPresetKey(
          item.projectId,
          item.description,
          item.focusFactor
        ) === key
    );
    if (existing) {
      existing.updatedAt = now;
    } else {
      data.timerPresets.unshift({
        id: uuid(),
        projectId: preset.projectId,
        description: preset.description,
        focusFactor: preset.focusFactor,
        createdAt: now,
        updatedAt: now
      });
    }
    saveData();
    updateProjectSelects();
    showToast(existing ? 'Pinned timer updated.' : 'Timer pinned.');
  }

  function removeTimerPreset(presetId) {
    ensureTimerPresets();
    const snapshot = cloneData();
    const before = data.timerPresets.length;
    data.timerPresets = data.timerPresets.filter(
      (preset) => String(preset.id) !== String(presetId)
    );
    if (data.timerPresets.length === before) return;
    saveData();
    updateProjectSelects();
    offerUndo('Pinned timer removed.', snapshot);
  }

  function moveTimerPreset(presetId, direction) {
    ensureTimerPresets();
    const index = data.timerPresets.findIndex(
      (preset) => String(preset.id) === String(presetId)
    );
    const targetIndex = index + direction;
    if (
      index < 0 ||
      targetIndex < 0 ||
      targetIndex >= data.timerPresets.length
    ) {
      return;
    }
    const snapshot = cloneData();
    const [preset] = data.timerPresets.splice(index, 1);
    data.timerPresets.splice(targetIndex, 0, preset);
    preset.updatedAt = new Date().toISOString();
    saveData();
    updateProjectSelects();
    renderTodayCommandPanel();
    offerUndo('Favorite timer reordered.', snapshot);
  }

  async function editTimerPreset(presetId) {
    ensureTimerPresets();
    const preset = data.timerPresets.find(
      (candidate) => String(candidate.id) === String(presetId)
    );
    if (!preset) return;
    const currentProject = data.projects.find(
      (project) => String(project.id) === String(preset.projectId)
    );
    const projectOptions = getActiveProjects().map((project) => ({
      value: project.id,
      label: project.name
    }));
    if (
      currentProject &&
      !projectOptions.some(
        (option) => String(option.value) === String(currentProject.id)
      )
    ) {
      projectOptions.unshift({
        value: currentProject.id,
        label: `${currentProject.name} (archived)`
      });
    }
    const values = await openFormDialog({
      title: 'Edit Favorite Timer',
      fields: [
        {
          name: 'projectId',
          label: 'Project',
          type: 'select',
          value: preset.projectId,
          options: projectOptions,
          required: true
        },
        {
          name: 'description',
          label: 'Description',
          value: preset.description || ''
        },
        {
          name: 'focusFactor',
          label: 'Focus',
          type: 'select',
          value: String(normalizeFocusFactor(preset.focusFactor)),
          options: FOCUS_FACTOR_OPTIONS.map((option) => ({
            value: String(option.value),
            label: option.label
          }))
        }
      ],
      submitLabel: 'Save Favorite'
    });
    if (!values) return;
    const project = data.projects.find(
      (candidate) => String(candidate.id) === String(values.projectId)
    );
    if (!project) {
      showToast('Choose a valid project.');
      return;
    }
    const snapshot = cloneData();
    preset.projectId = project.id;
    preset.description = String(values.description || '').trim();
    preset.focusFactor = normalizeFocusFactor(values.focusFactor);
    preset.updatedAt = new Date().toISOString();
    saveData();
    updateProjectSelects();
    renderTodayCommandPanel();
    offerUndo('Favorite timer updated.', snapshot);
  }

  function getStartableTimerProject(projectId, runningProjectIds) {
    const project = data.projects.find(
      (candidate) => String(candidate.id) === String(projectId)
    );
    if (!project || isProjectArchived(project)) return null;
    if (runningProjectIds.has(String(project.id))) return null;
    return project;
  }

  function getTimerShortcutKey({
    project,
    projectId,
    description,
    focusFactor
  }) {
    return makeTimerPresetKey(
      project ? project.id : projectId,
      description,
      focusFactor
    );
  }

  function getPinnedTimerShortcuts(runningProjectIds) {
    return ensureTimerPresets()
      .map((preset) => {
        const project = getStartableTimerProject(
          preset.projectId,
          runningProjectIds
        );
        if (!project) return null;
        return {
          id: preset.id,
          source: 'pinned',
          project,
          description: String(preset.description || '').trim(),
          focusFactor: normalizeFocusFactor(preset.focusFactor)
        };
      })
      .filter(Boolean);
  }

  function getLastStoppedTimerShortcut(runningProjectIds) {
    const entry = data.entries
      .slice()
      .filter(
        (candidate) => !candidate.isRunning && !isCodexTimeEntry(candidate)
      )
      .sort((a, b) => {
        const aTime = new Date(a.endTime || a.createdAt || a.startTime || 0);
        const bTime = new Date(b.endTime || b.createdAt || b.startTime || 0);
        return bTime - aTime;
      })[0];
    if (!entry) return null;
    const project = getStartableTimerProject(
      entry.projectId,
      runningProjectIds
    );
    if (!project) return null;
    return {
      source: 'last',
      project,
      description: String(entry.description || '').trim(),
      focusFactor: getEntryFocusFactor(entry, 1)
    };
  }

  function getYesterdayTimerShortcuts(
    runningProjectIds,
    { limit = 2, excludeKeys = new Set() } = {}
  ) {
    const today = startOfLocalDay(new Date());
    const yesterday = addLocalDays(today, -1);
    const seen = new Set(excludeKeys);
    const shortcuts = [];
    data.entries
      .slice()
      .filter((entry) => !entry.isRunning && !isCodexTimeEntry(entry))
      .sort((a, b) => {
        const aTime = new Date(a.endTime || a.createdAt || a.startTime || 0);
        const bTime = new Date(b.endTime || b.createdAt || b.startTime || 0);
        return bTime - aTime;
      })
      .forEach((entry) => {
        if (shortcuts.length >= limit) return;
        const start = new Date(entry.startTime);
        if (Number.isNaN(start.getTime())) return;
        if (start < yesterday || start >= today) return;
        const project = getStartableTimerProject(
          entry.projectId,
          runningProjectIds
        );
        if (!project) return;
        const shortcut = {
          source: 'yesterday',
          project,
          description: String(entry.description || '').trim(),
          focusFactor: getEntryFocusFactor(entry, 1)
        };
        const key = getTimerShortcutKey(shortcut);
        if (seen.has(key)) return;
        seen.add(key);
        shortcuts.push(shortcut);
      });
    return shortcuts;
  }

  function getRecentTimerShortcuts(
    runningProjectIds,
    { limit = 4, excludeKeys = new Set() } = {}
  ) {
    const shortcuts = [];
    const seen = new Set(excludeKeys);
    data.entries
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.createdAt || a.startTime || 0).getTime();
        const bTime = new Date(b.createdAt || b.startTime || 0).getTime();
        return bTime - aTime;
      })
      .forEach((entry) => {
        if (shortcuts.length >= limit) return;
        if (entry.isRunning || isCodexTimeEntry(entry)) return;
        const project = getStartableTimerProject(
          entry.projectId,
          runningProjectIds
        );
        if (!project) return;
        const description = String(entry.description || '').trim();
        const focusFactor = getEntryFocusFactor(entry, 1);
        const shortcut = {
          source: 'recent',
          project,
          description,
          focusFactor
        };
        const key = getTimerShortcutKey(shortcut);
        if (seen.has(key)) return;
        seen.add(key);
        shortcuts.push(shortcut);
      });
    return shortcuts;
  }

  function getMostUsedTimerShortcuts(
    runningProjectIds,
    { limit = 3, excludeKeys = new Set(), minCount = 1 } = {}
  ) {
    const groups = new Map();
    data.entries.forEach((entry) => {
      if (entry.isRunning || isCodexTimeEntry(entry)) return;
      const project = getStartableTimerProject(
        entry.projectId,
        runningProjectIds
      );
      if (!project) return;
      const description = String(entry.description || '').trim();
      const focusFactor = getEntryFocusFactor(entry, 1);
      const shortcut = {
        source: 'used',
        project,
        description,
        focusFactor
      };
      const key = getTimerShortcutKey(shortcut);
      if (excludeKeys.has(key)) return;
      const entryTime = new Date(
        entry.createdAt || entry.endTime || entry.startTime || 0
      ).getTime();
      const duration = Number(entry.duration) || 0;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.duration += duration;
        existing.lastTime = Math.max(existing.lastTime, entryTime || 0);
      } else {
        groups.set(key, {
          ...shortcut,
          count: 1,
          duration,
          lastTime: entryTime || 0
        });
      }
    });
    return Array.from(groups.values())
      .filter((shortcut) => shortcut.count >= minCount)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (b.duration !== a.duration) return b.duration - a.duration;
        return b.lastTime - a.lastTime;
      })
      .slice(0, limit);
  }

  function getStartableTimerShortcuts({
    recommendation = null,
    runningProjectIds = null,
    limit = 3
  } = {}) {
    const runningIds =
      runningProjectIds ||
      new Set(getRunningEntries().map((entry) => String(entry.projectId)));
    const shortcuts = [];
    const seen = new Set();
    const addShortcut = (shortcut) => {
      if (!shortcut || shortcuts.length >= limit) return;
      const key = getTimerShortcutKey(shortcut);
      if (seen.has(key)) return;
      seen.add(key);
      shortcuts.push(shortcut);
    };

    if (recommendation && recommendation.project) {
      const project = getStartableTimerProject(
        recommendation.project.id,
        runningIds
      );
      if (project) {
        addShortcut({
          source: 'recommended',
          project,
          description: '',
          focusFactor: DEFAULT_FOCUS_FACTOR
        });
      }
    }

    getPinnedTimerShortcuts(runningIds).forEach(addShortcut);
    getMostUsedTimerShortcuts(runningIds, {
      limit,
      excludeKeys: seen,
      minCount: 2
    }).forEach(addShortcut);
    addShortcut(getLastStoppedTimerShortcut(runningIds));
    getYesterdayTimerShortcuts(runningIds, {
      limit,
      excludeKeys: seen
    }).forEach(addShortcut);
    getRecentTimerShortcuts(runningIds, {
      limit,
      excludeKeys: seen
    }).forEach(addShortcut);

    if (shortcuts.length < limit) {
      getActiveProjects().forEach((project) => {
        const startableProject = getStartableTimerProject(
          project.id,
          runningIds
        );
        if (!startableProject) return;
        addShortcut({
          source: 'project',
          project: startableProject,
          description: '',
          focusFactor: DEFAULT_FOCUS_FACTOR
        });
      });
    }
    return shortcuts;
  }

  function startTimerShortcut(shortcut, { navigate = false } = {}) {
    if (!shortcut || !shortcut.project) return;
    if (navigate) activateSection('timer');
    const timerSelect = document.getElementById('timerProjectPro');
    if (timerSelect) timerSelect.value = shortcut.project.id;
    return startProjectTimer(shortcut.project.id, {
      description: shortcut.description,
      overrideFactor: shortcut.focusFactor
    });
  }

  // Update project selects for timer and manual forms
  function updateProjectSelects() {
    const timerSelect = document.getElementById('timerProjectPro');
    const manualSelect = document.getElementById('manualProjectPro');
    const entryFilterSelect = document.getElementById('entryProjectFilter');
    const startBtn = document.getElementById('startTimerBtnPro');
    const pinTimerPresetBtn = document.getElementById('pinTimerPresetBtnPro');
    timerSelect.innerHTML = '';
    manualSelect.innerHTML = '';
    if (entryFilterSelect) {
      const selectedFilter = entryProjectFilter || entryFilterSelect.value;
      entryFilterSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All projects';
      entryFilterSelect.appendChild(allOption);
      data.projects.forEach((project) => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = isProjectArchived(project)
          ? `${project.name} (archived)`
          : project.name;
        entryFilterSelect.appendChild(option);
      });
      entryProjectFilter = selectedFilter;
    }
    const activeProjects = getActiveProjects();
    if (entryFilterSelect) {
      const filterStillExists = data.projects.some(
        (p) => String(p.id) === String(entryProjectFilter)
      );
      if (entryProjectFilter && !filterStillExists) {
        entryProjectFilter = '';
      }
      entryFilterSelect.value = entryProjectFilter;
    }
    if (activeProjects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent =
        data.projects.length === 0
          ? '-- no projects --'
          : '-- no active projects --';
      timerSelect.appendChild(opt);
      manualSelect.appendChild(opt.cloneNode(true));
      if (entryFilterSelect && data.projects.length === 0) {
        entryProjectFilter = '';
        entryFilterSelect.value = '';
      }
      startBtn.disabled = true;
      if (pinTimerPresetBtn) pinTimerPresetBtn.disabled = true;
      renderTimerHints(timerSelect, null, new Map(), new Set());
      return;
    }
    // Never recommend (or auto-select) a project that already has a running timer,
    // since we prevent starting the same timer twice.
    const runningProjectIds = new Set(
      getRunningEntries().map((e) => String(e.projectId))
    );
    const weekContext = getCurrentWeekPlanningContext();
    const projectOptionData = activeProjects.map((project, index) => {
      const stats = computeProjectStats(project);
      const dailyPlan = getProjectDailyPlan(project, stats, weekContext);
      return { project, stats, dailyPlan, index };
    });
    const dailyPlanByProjectId = new Map(
      projectOptionData.map((item) => [String(item.project.id), item.dailyPlan])
    );
    applyPortfolioDailyCredit(dailyPlanByProjectId);
    const recommendedEntry = getRecommendedProjectEntry(
      projectOptionData,
      dailyPlanByProjectId
    );
    const sortedProjects = projectOptionData
      .slice()
      .sort((a, b) => {
        const pressureDiff =
          getProjectRecommendationPressure(b, b.dailyPlan) -
          getProjectRecommendationPressure(a, a.dailyPlan);
        if (Math.abs(pressureDiff) > 0.01) return pressureDiff;
        const remainingDiff =
          getDailyPlanRecommendedRemaining(b.dailyPlan) -
          getDailyPlanRecommendedRemaining(a.dailyPlan);
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
      getDailyPlanRecommendedRemaining(
        dailyPlanByProjectId.get(String(currentRecommendedMonthlyId))
      ) > 0
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
            ' (Recommended, ~' +
            formatRecommendationHours(
              getDailyPlanRecommendedRemaining(dailyPlan)
            ) +
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
    });
    if (entryFilterSelect) entryFilterSelect.value = entryProjectFilter;
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
    if (pinTimerPresetBtn) pinTimerPresetBtn.disabled = !hasStartable;
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
          formatRecommendationHours(
            getDailyPlanRecommendedRemaining(dailyPlan)
          ) +
          'h today';
        recommendationEl.style.display = '';
      } else {
        recommendationEl.textContent = '';
        recommendationEl.style.display = 'none';
      }
    }

    const recentEl = document.getElementById('recentTimersPro');
    if (!recentEl) return;
    recentEl.innerHTML = '';
    const startablePinned = getPinnedTimerShortcuts(runningProjectIds);
    const pinnedKeys = new Set(startablePinned.map(getTimerShortcutKey));
    const startableRecent = getRecentTimerShortcuts(runningProjectIds, {
      limit: 4,
      excludeKeys: pinnedKeys
    });
    if (!startablePinned.length && !startableRecent.length) {
      recentEl.style.display = 'none';
      return;
    }

    recentEl.style.display = '';
    const appendStartButton = (
      row,
      { project, description, focusFactor, id },
      { editable = false } = {}
    ) => {
      const focusText = formatFocusPercent(focusFactor);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'timer-chip';
      button.textContent = formatTimerPresetLabel(
        project,
        description,
        focusFactor
      );
      button.title =
        'Start ' +
        project.name +
        (description ? ' - ' + description : '') +
        ' at ' +
        focusText;
      button.addEventListener('click', () => {
        startTimerShortcut({ project, description, focusFactor });
      });
      if (editable && id) {
        let pressTimer = null;
        const clearPress = () => {
          if (pressTimer) clearTimeout(pressTimer);
          pressTimer = null;
        };
        button.addEventListener('pointerdown', () => {
          clearPress();
          pressTimer = setTimeout(() => {
            editTimerPreset(id);
            pressTimer = null;
          }, 650);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
          button.addEventListener(eventName, clearPress);
        });
      }
      row.appendChild(button);
      return button;
    };
    const appendSection = (title, items, { pinned = false } = {}) => {
      if (!items.length) return;
      const label = document.createElement('div');
      label.className = 'timer-hint-label';
      label.textContent = title;
      recentEl.appendChild(label);
      const row = document.createElement('div');
      row.className = 'timer-chip-row';
      items.forEach((item) => {
        if (!pinned) {
          appendStartButton(row, item);
          return;
        }
        const group = document.createElement('div');
        group.className = 'timer-chip-group';
        appendStartButton(group, item, { editable: true });
        const upButton = document.createElement('button');
        upButton.type = 'button';
        upButton.className = 'timer-chip-unpin';
        upButton.textContent = 'Up';
        upButton.title = 'Move favorite up';
        upButton.addEventListener('click', () => {
          moveTimerPreset(item.id, -1);
        });
        group.appendChild(upButton);
        const downButton = document.createElement('button');
        downButton.type = 'button';
        downButton.className = 'timer-chip-unpin';
        downButton.textContent = 'Down';
        downButton.title = 'Move favorite down';
        downButton.addEventListener('click', () => {
          moveTimerPreset(item.id, 1);
        });
        group.appendChild(downButton);
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'timer-chip-unpin';
        editButton.textContent = 'Edit';
        editButton.title = 'Edit favorite timer';
        editButton.addEventListener('click', () => {
          editTimerPreset(item.id);
        });
        group.appendChild(editButton);
        const unpinButton = document.createElement('button');
        unpinButton.type = 'button';
        unpinButton.className = 'timer-chip-unpin';
        unpinButton.textContent = 'Unpin';
        unpinButton.title = 'Remove pinned timer';
        unpinButton.addEventListener('click', () => {
          removeTimerPreset(item.id);
        });
        group.appendChild(unpinButton);
        row.appendChild(group);
      });
      recentEl.appendChild(row);
    };

    appendSection('Pinned timers', startablePinned, { pinned: true });
    appendSection('Recent timers', startableRecent);
  }

  function isManualEntryFormOpen() {
    const panel = document.getElementById('manualEntryFormPro');
    return (
      activeSectionId === 'entries' &&
      panel &&
      !panel.classList.contains('hidden')
    );
  }

  function openManualEntryForm() {
    const panel = document.getElementById('manualEntryFormPro');
    if (!panel) return;
    panel.classList.remove('hidden');
    document.getElementById('entries')?.classList.add('manual-entry-active');
    renderMobileNowBar();
    if (!isMobileViewport()) return;
    window.requestAnimationFrame(() => {
      panel.scrollIntoView({ block: 'start', behavior: 'auto' });
      const focusTarget =
        document.getElementById('manualProjectPro') ||
        document.getElementById('manualDescriptionPro');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
  }

  function closeManualEntryForm({ reset = true, updateNowBar = true } = {}) {
    const panel = document.getElementById('manualEntryFormPro');
    if (!panel) return;
    panel.classList.add('hidden');
    document.getElementById('entries')?.classList.remove('manual-entry-active');
    if (reset) document.getElementById('manualFormPro')?.reset();
    if (updateNowBar) renderMobileNowBar();
  }

  // Manual entry add/cancel
  document
    .getElementById('addManualEntryBtnPro')
    .addEventListener('click', openManualEntryForm);
  document
    .getElementById('cancelManualBtnPro')
    .addEventListener('click', () => {
      closeManualEntryForm();
    });

  function applyProjectRoundingToWallSeconds(wallSeconds, project) {
    const roundingMinutes = Number(project && project.roundingMinutes);
    if (!Number.isFinite(roundingMinutes) || roundingMinutes <= 0) {
      return Math.floor(wallSeconds);
    }
    const minutesVal = wallSeconds / 60;
    const roundedMinutes =
      Math.round(minutesVal / roundingMinutes) * roundingMinutes;
    return Math.max(0, Math.floor(roundedMinutes * 60));
  }

  function createManualEntry({
    projectId,
    description = '',
    startValue = '',
    endValue = '',
    hoursValue = '',
    focusFactor = DEFAULT_FOCUS_FACTOR,
    now = new Date()
  } = {}) {
    if (!projectId) {
      showToast('Choose a project before logging time.');
      return null;
    }
    const project = data.projects.find(
      (p) => String(p.id) === String(projectId)
    );
    if (!project) {
      showToast('Choose a valid project.');
      return null;
    }
    const hoursVal = Number(hoursValue);
    const hasStart = !!startValue;
    const hasEnd = !!endValue;
    const hasHours = Number.isFinite(hoursVal) && hoursVal > 0;
    const parsedStart = hasStart ? parseDateTimeInput(startValue) : null;
    const parsedEnd = hasEnd ? parseDateTimeInput(endValue) : null;
    if (hasStart && !parsedStart) {
      showToast('Enter a valid manual start time.');
      return null;
    }
    if (hasEnd && !parsedEnd) {
      showToast('Enter a valid manual end time.');
      return null;
    }
    if (!hasHours && !(parsedStart && parsedEnd)) {
      showToast('Enter hours or both start and end times.');
      return null;
    }

    let startTime;
    let endTime;
    let wallSeconds;
    if (parsedStart && parsedEnd) {
      if (parsedEnd <= parsedStart) {
        showToast('Manual end time must be after start time.');
        return null;
      }
      if (parsedEnd > now) {
        showToast('Manual end time cannot be in the future.');
        return null;
      }
      startTime = parsedStart;
      endTime = parsedEnd;
      wallSeconds = (parsedEnd - parsedStart) / 1000;
    } else {
      wallSeconds = hoursVal * 3600;
      wallSeconds = applyProjectRoundingToWallSeconds(wallSeconds, project);
      if (parsedStart) {
        startTime = parsedStart;
        endTime = new Date(startTime.getTime() + wallSeconds * 1000);
      } else if (parsedEnd) {
        endTime = parsedEnd;
        startTime = new Date(endTime.getTime() - wallSeconds * 1000);
      } else {
        endTime = now;
        startTime = new Date(endTime.getTime() - wallSeconds * 1000);
      }
      if (endTime > now) {
        showToast('Manual end time cannot be in the future.');
        return null;
      }
    }

    wallSeconds = applyProjectRoundingToWallSeconds(wallSeconds, project);
    const normalizedFocus = normalizeFocusFactor(focusFactor);
    const durationSeconds = Math.floor(wallSeconds * normalizedFocus);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      showToast('Manual entry duration must be greater than zero.');
      return null;
    }
    const newEntry = {
      id: uuid(),
      projectId,
      description: String(description || '').trim(),
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: durationSeconds,
      focusFactor: normalizedFocus,
      manualFactor: normalizedFocus,
      isRunning: false,
      createdAt: now.toISOString()
    };
    data.entries.push(newEntry);
    saveData();
    refreshAllViews();
    return newEntry;
  }

  function parseQuickLogDate(rawText) {
    const text = String(rawText || '').trim();
    const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2}|today|yesterday)\b/i);
    if (!dateMatch) return { text, endTime: new Date() };
    const token = dateMatch[1].toLowerCase();
    const rest = `${text.slice(0, dateMatch.index)} ${text.slice(
      dateMatch.index + dateMatch[0].length
    )}`
      .replace(/\s+/g, ' ')
      .trim();
    if (token === 'today') return { text: rest, endTime: new Date() };
    const endTime = new Date();
    if (token === 'yesterday') {
      endTime.setDate(endTime.getDate() - 1);
      endTime.setHours(17, 0, 0, 0);
      return { text: rest, endTime };
    }
    const parsed = parseLocalDateString(token);
    if (!parsed) return { text, endTime: new Date() };
    parsed.setHours(17, 0, 0, 0);
    return { text: rest, endTime: parsed };
  }

  function normalizeQuickLogPhrase(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function getQuickLogProjectAliases(project) {
    const aliases = new Set();
    const name = normalizeQuickLogPhrase(project && project.name);
    const client = normalizeQuickLogPhrase(project && project.client);
    if (name) {
      aliases.add(name);
      const firstWord = name.split(' ')[0];
      if (firstWord && firstWord.length >= 3) aliases.add(firstWord);
    }
    if (client && client.length >= 3) aliases.add(client);
    return Array.from(aliases).sort((a, b) => b.length - a.length);
  }

  function findQuickLogProject(text) {
    const normalizedText = normalizeQuickLogPhrase(text);
    const candidates = getActiveProjects()
      .slice()
      .sort((a, b) => String(b.name).length - String(a.name).length);
    for (const project of candidates) {
      const aliases = getQuickLogProjectAliases(project);
      for (const alias of aliases) {
        if (!alias) continue;
        const exact = normalizedText === alias;
        const prefix = normalizedText.startsWith(alias + ' ');
        const suffix = normalizedText.endsWith(' ' + alias);
        const contained = normalizedText.includes(` ${alias} `);
        if (exact || prefix || suffix || contained) {
          return { project, alias };
        }
      }
    }
    return null;
  }

  function removeQuickLogAlias(text, alias) {
    const words = normalizeQuickLogPhrase(alias).split(' ').filter(Boolean);
    if (!words.length) return String(text || '').trim();
    let result = String(text || '').trim();
    words.forEach((word) => {
      const pattern = new RegExp(
        `(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`,
        'i'
      );
      result = result.replace(pattern, ' ');
    });
    return result.replace(/\s+/g, ' ').trim();
  }

  function parseQuickLogInput(value) {
    const match = String(value || '').match(
      /^\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\s+(.+?)\s*$/i
    );
    if (!match) {
      return {
        ok: false,
        reason: 'Use a format like "1.5h Project name description yesterday".'
      };
    }
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const hours = unit.startsWith('m') ? amount / 60 : amount;
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, reason: 'Quick log duration must be positive.' };
    }
    const dated = parseQuickLogDate(match[3]);
    const projectMatch = findQuickLogProject(dated.text);
    if (!projectMatch) {
      return {
        ok: false,
        reason: 'Mention an active project name, client, or project keyword.'
      };
    }
    const description = removeQuickLogAlias(dated.text, projectMatch.alias);
    return {
      ok: true,
      project: projectMatch.project,
      description,
      hours,
      endTime: dated.endTime
    };
  }

  function getQuickLogDateEndTime(dateKey) {
    const endTime = new Date();
    if (dateKey === 'yesterday') {
      endTime.setDate(endTime.getDate() - 1);
      endTime.setHours(17, 0, 0, 0);
    } else if (dateKey && dateKey !== 'today') {
      const parsed = parseLocalDateString(dateKey);
      if (parsed) {
        parsed.setHours(17, 0, 0, 0);
        return parsed;
      }
    }
    return endTime;
  }

  function openMobileQuickLogSheet(seedText = '') {
    const sheet = createMobileSheet('Quick log', {
      className: 'mobile-quick-log-sheet',
      description: 'Paste or dictate a log, or use the structured controls.'
    });
    const projectOptions = getActiveProjects();
    const listId = `mobileQuickLogProjects-${uuid()}`;
    const rawLabel = document.createElement('label');
    rawLabel.className = 'mobile-sheet-field';
    rawLabel.textContent = 'Dictation';
    const rawInput = document.createElement('textarea');
    rawInput.rows = 3;
    rawInput.value = seedText;
    rawInput.setAttribute('aria-label', 'Dictation quick log');
    rawInput.placeholder = '1.5h client call yesterday alpha';
    rawLabel.appendChild(rawInput);
    sheet.body.appendChild(rawLabel);

    const structured = document.createElement('div');
    structured.className = 'mobile-quick-log-structured';
    const projectLabel = document.createElement('label');
    projectLabel.className = 'mobile-sheet-field';
    projectLabel.textContent = 'Project';
    const projectInput = document.createElement('input');
    projectInput.setAttribute('aria-label', 'Project autocomplete');
    projectInput.setAttribute('list', listId);
    projectInput.placeholder = 'Project or client';
    const dataList = document.createElement('datalist');
    dataList.id = listId;
    projectOptions.forEach((project) => {
      const option = document.createElement('option');
      option.value = project.name;
      dataList.appendChild(option);
    });
    projectLabel.appendChild(projectInput);
    projectLabel.appendChild(dataList);
    structured.appendChild(projectLabel);

    const durationLabel = document.createElement('label');
    durationLabel.className = 'mobile-sheet-field';
    durationLabel.textContent = 'Duration';
    const durationRow = document.createElement('div');
    durationRow.className = 'mobile-stepper-row';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'btn secondary';
    minus.textContent = '-15m';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '0';
    durationInput.step = '0.25';
    durationInput.value = '1';
    durationInput.setAttribute('aria-label', 'Duration hours');
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'btn secondary';
    plus.textContent = '+15m';
    const adjustDuration = (delta) => {
      const current = Number(durationInput.value) || 0;
      durationInput.value = Math.max(0.25, current + delta).toFixed(2);
      renderPreview();
    };
    minus.addEventListener('click', () => adjustDuration(-0.25));
    plus.addEventListener('click', () => adjustDuration(0.25));
    durationRow.appendChild(minus);
    durationRow.appendChild(durationInput);
    durationRow.appendChild(plus);
    durationLabel.appendChild(durationRow);
    structured.appendChild(durationLabel);

    const descriptionLabel = document.createElement('label');
    descriptionLabel.className = 'mobile-sheet-field';
    descriptionLabel.textContent = 'Description';
    const descriptionInput = document.createElement('input');
    descriptionInput.setAttribute('aria-label', 'Quick log description');
    descriptionInput.placeholder = 'What did you do?';
    descriptionLabel.appendChild(descriptionInput);
    structured.appendChild(descriptionLabel);

    let dateKey = 'today';
    const chips = document.createElement('div');
    chips.className = 'mobile-date-chip-row';
    [
      ['today', 'Today'],
      ['yesterday', 'Yesterday']
    ].forEach(([value, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `btn secondary mobile-date-chip${value === dateKey ? ' active' : ''}`;
      chip.textContent = label;
      chip.addEventListener('click', () => {
        dateKey = value;
        chips.querySelectorAll('.mobile-date-chip').forEach((button) => {
          button.classList.toggle('active', button === chip);
        });
        renderPreview();
      });
      chips.appendChild(chip);
    });
    structured.appendChild(chips);
    sheet.body.appendChild(structured);

    const preview = document.createElement('div');
    preview.className = 'mobile-quick-log-preview';
    preview.setAttribute('aria-live', 'polite');
    sheet.body.appendChild(preview);

    function findStructuredProject() {
      const typed = normalizeQuickLogPhrase(projectInput.value);
      return (
        projectOptions.find((project) =>
          getQuickLogProjectAliases(project).some((alias) => alias === typed)
        ) ||
        projectOptions.find(
          (project) => normalizeQuickLogPhrase(project.name) === typed
        ) ||
        null
      );
    }

    function getSheetQuickLogPayload() {
      const raw = rawInput.value.trim();
      if (raw) return parseQuickLogInput(raw);
      const project = findStructuredProject();
      const hours = Number(durationInput.value);
      if (!project) {
        return { ok: false, reason: 'Choose a project.' };
      }
      if (!Number.isFinite(hours) || hours <= 0) {
        return { ok: false, reason: 'Enter a positive duration.' };
      }
      return {
        ok: true,
        project,
        hours,
        description: descriptionInput.value.trim(),
        endTime: getQuickLogDateEndTime(dateKey)
      };
    }

    function renderPreview() {
      const parsed = getSheetQuickLogPayload();
      if (!parsed.ok) {
        preview.className = 'mobile-quick-log-preview risk';
        preview.textContent = parsed.reason;
        return;
      }
      preview.className = 'mobile-quick-log-preview';
      preview.textContent = `${parsed.hours.toFixed(2)}h - ${parsed.project.name}${parsed.description ? ` - ${parsed.description}` : ''} - ${formatLocalDateString(parsed.endTime)}`;
    }

    [rawInput, projectInput, durationInput, descriptionInput].forEach(
      (input) => {
        input.addEventListener('input', renderPreview);
        input.addEventListener('change', renderPreview);
      }
    );
    renderPreview();

    sheet.addAction('Log entry', 'primary', () => {
      const parsed = getSheetQuickLogPayload();
      if (!parsed.ok) {
        showToast(parsed.reason);
        renderPreview();
        return;
      }
      const entry = createManualEntry({
        projectId: parsed.project.id,
        description: parsed.description,
        endValue: toDateTimeInputValue(parsed.endTime),
        hoursValue: parsed.hours,
        focusFactor: DEFAULT_FOCUS_FACTOR,
        now: new Date()
      });
      if (!entry) return;
      sheet.close();
      showToast(
        `Logged ${parsed.hours.toFixed(2)}h to ${parsed.project.name}.`
      );
    });
    sheet.addAction('Cancel', 'secondary', sheet.close);
  }

  document.getElementById('manualFormPro').addEventListener('submit', (e) => {
    e.preventDefault();
    const projectId = document.getElementById('manualProjectPro').value;
    const description = document
      .getElementById('manualDescriptionPro')
      .value.trim();
    const startValue = document.getElementById('manualStartPro').value;
    const endValue = document.getElementById('manualEndPro').value;
    const focusFactor = normalizeFocusFactor(
      document.getElementById('manualFactorPro').value
    );
    const entry = createManualEntry({
      projectId,
      description,
      startValue,
      endValue,
      hoursValue: document.getElementById('manualHoursPro').value,
      focusFactor
    });
    if (!entry) return;
    e.target.reset();
    closeManualEntryForm({ reset: false });
    showToast('Manual entry logged.');
  });

  const quickLogForm = document.getElementById('quickLogForm');
  const quickLogInput = document.getElementById('quickLogInput');
  if (quickLogForm && quickLogInput) {
    quickLogForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (isMobileViewport()) {
        openMobileQuickLogSheet(quickLogInput.value);
        quickLogInput.value = '';
        return;
      }
      const parsed = parseQuickLogInput(quickLogInput.value);
      if (!parsed.ok) {
        showToast(parsed.reason);
        return;
      }
      const endValue = toDateTimeInputValue(parsed.endTime);
      const entry = createManualEntry({
        projectId: parsed.project.id,
        description: parsed.description,
        endValue,
        hoursValue: parsed.hours,
        focusFactor: DEFAULT_FOCUS_FACTOR,
        now: new Date()
      });
      if (!entry) return;
      quickLogInput.value = '';
      showToast(
        `Logged ${parsed.hours.toFixed(2)}h to ${parsed.project.name}.`
      );
    });
  }

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
  const entryDateFromInput = document.getElementById('entryDateFromInput');
  const entryDateToInput = document.getElementById('entryDateToInput');
  const entryDateClearBtn = document.getElementById('entryDateClearBtn');
  const entryDateQuickFilters = document.getElementById(
    'entryDateQuickFilters'
  );
  const billingPresetSelect = document.getElementById('billingPresetSelect');
  const saveBillingViewBtn = document.getElementById('saveBillingViewBtn');
  const deleteBillingViewBtn = document.getElementById('deleteBillingViewBtn');
  function syncEntryDateFilterControls() {
    if (entryDateFromInput && entryDateFromInput.value !== entryDateFrom) {
      entryDateFromInput.value = entryDateFrom;
    }
    if (entryDateToInput && entryDateToInput.value !== entryDateTo) {
      entryDateToInput.value = entryDateTo;
    }
    if (entryDateClearBtn) {
      entryDateClearBtn.disabled = !entryDateFrom && !entryDateTo;
    }
  }

  function getRecommendedProjectForToday() {
    const nowTime = new Date();
    const activeProjects = data.projects.filter((project) =>
      isProjectActive(project, nowTime)
    );
    if (!activeProjects.length) return null;
    const perProjectStats = activeProjects.map((project) => ({
      project,
      stats: computeProjectStats(project)
    }));
    const weekContext = getCurrentWeekPlanningContext(nowTime);
    const dailyPlanByProjectId = new Map(
      perProjectStats.map((item) => [
        String(item.project.id),
        getProjectDailyPlan(item.project, item.stats, weekContext)
      ])
    );
    applyPortfolioDailyCredit(dailyPlanByProjectId);
    const recommendation = getRecommendedProjectEntry(
      perProjectStats,
      dailyPlanByProjectId
    );
    if (!recommendation) return null;
    return {
      ...recommendation,
      dailyPlan: dailyPlanByProjectId.get(String(recommendation.project.id))
    };
  }

  function getBackupFreshnessLabel() {
    if (backupConflict) return 'Backup conflict';
    if (!data.lastBackupAt) return 'Backup not set';
    return `Backup ${formatRelativeTime(data.lastBackupAt)}`;
  }

  function getMobileSyncState() {
    const fsSupported =
      typeof window !== 'undefined' && !!window.showDirectoryPicker;
    if (backupConflict) {
      return {
        state: 'conflict',
        label: 'Conflict',
        detail: 'Backup folder has newer data'
      };
    }
    if (!fsSupported) {
      return {
        state: 'unsupported',
        label: 'Unsupported',
        detail: 'Folder backup is unavailable here'
      };
    }
    const updatedAt = data && data.updatedAt ? new Date(data.updatedAt) : null;
    const backupAt =
      data && data.lastBackupAt ? new Date(data.lastBackupAt) : null;
    const stale =
      needsBackup ||
      !backupAt ||
      Number.isNaN(backupAt.getTime()) ||
      (updatedAt &&
        !Number.isNaN(updatedAt.getTime()) &&
        updatedAt.getTime() > backupAt.getTime());
    if (stale) {
      return {
        state: 'needs-backup',
        label: 'Needs backup',
        detail: data.lastBackupAt
          ? `Last backup ${formatRelativeTime(data.lastBackupAt)}`
          : 'No backup yet'
      };
    }
    return {
      state: 'backed-up',
      label: 'Backed up',
      detail: `Synced ${formatRelativeTime(data.lastBackupAt)}`
    };
  }

  function getPwaMobileDetail() {
    if (
      pendingServiceWorkerRegistration &&
      pendingServiceWorkerRegistration.waiting
    ) {
      return 'Update ready';
    }
    if (pendingInstallPrompt) return 'Install ready';
    return `Offline ${offlineShellStatus}`;
  }

  function triggerServiceWorkerUpdate() {
    if (
      pendingServiceWorkerRegistration &&
      pendingServiceWorkerRegistration.waiting
    ) {
      reloadAfterServiceWorkerUpdate = true;
      pendingServiceWorkerRegistration.waiting.postMessage({
        type: 'SKIP_WAITING'
      });
      return true;
    }
    return false;
  }

  function renderMobileSyncStatus() {
    const panel = document.getElementById('mobileSyncStatus');
    if (!panel) return;
    panel.innerHTML = '';
    panel.className = 'mobile-sync-status hidden';
  }

  function renderMobileMostUsedTimers(container, runningProjectIds) {
    const shortcuts = getMostUsedTimerShortcuts(runningProjectIds, {
      limit: 4,
      minCount: 2
    });
    if (!shortcuts.length) return;
    const section = document.createElement('div');
    section.className = 'mobile-today-section';
    const title = document.createElement('div');
    title.className = 'mobile-today-section-title';
    title.textContent = 'Most used timers';
    section.appendChild(title);
    const list = document.createElement('div');
    list.className = 'mobile-quick-timer-list';
    shortcuts.forEach((shortcut) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-quick-timer';
      const label = document.createElement('strong');
      label.textContent = shortcut.project.name;
      const meta = document.createElement('span');
      meta.textContent = [
        shortcut.description,
        formatFocusPercent(shortcut.focusFactor),
        `${shortcut.count}x`
      ]
        .filter(Boolean)
        .join(' - ');
      button.appendChild(label);
      button.appendChild(meta);
      button.title =
        'Start ' +
        shortcut.project.name +
        (shortcut.description ? ' - ' + shortcut.description : '') +
        ' at ' +
        formatFocusPercent(shortcut.focusFactor);
      button.addEventListener('click', () => {
        startTimerShortcut(shortcut, { navigate: true });
      });
      list.appendChild(button);
    });
    section.appendChild(list);
    container.appendChild(section);
  }

  function getReviewBounds(scope) {
    if (scope === 'week') return getWeekBounds(0);
    return getDayBounds(-1);
  }

  function getEntryReviewData(scope = 'yesterday') {
    const bounds = getReviewBounds(scope);
    const from = parseLocalDateString(bounds.from);
    const to = addLocalDays(parseLocalDateString(bounds.to), 1);
    const entries = data.entries.filter((entry) =>
      entryOverlapsDateRange(entry, from, to)
    );
    const missingDescriptions = entries.filter(
      (entry) => !entry.isRunning && !String(entry.description || '').trim()
    );
    const longEntries = entries.filter(
      (entry) => !entry.isRunning && (Number(entry.duration) || 0) >= 4 * 3600
    );
    const staleRunning = entries.filter(
      (entry) => entry.isRunning && getRunningTimerWarnings(entry).length
    );
    const days = [];
    for (
      let cursor = new Date(from);
      cursor < to;
      cursor = addLocalDays(cursor, 1)
    ) {
      const dayStart = new Date(cursor);
      const dayEnd = addLocalDays(dayStart, 1);
      const hasEntries = entries.some((entry) =>
        entryOverlapsDateRange(entry, dayStart, dayEnd)
      );
      if (!hasEntries) days.push(formatLocalDateString(dayStart));
    }
    return {
      scope,
      bounds,
      entries,
      missingDescriptions,
      longEntries,
      staleRunning,
      emptyDays: days
    };
  }

  function openEntryReviewSheet(scope = 'yesterday') {
    const review = getEntryReviewData(scope);
    const sheet = createMobileSheet(
      scope === 'week' ? 'Review this week' : 'Review yesterday',
      {
        className: 'mobile-entry-review-sheet',
        description: `${review.bounds.from} to ${review.bounds.to}`
      }
    );
    const summary = document.createElement('div');
    summary.className = 'mobile-review-summary';
    [
      [`${review.entries.length} entries`, 'Entries'],
      [`${review.missingDescriptions.length}`, 'Missing descriptions'],
      [`${review.longEntries.length}`, 'Long entries'],
      [`${review.emptyDays.length}`, 'Empty days']
    ].forEach(([value, label]) => {
      const item = document.createElement('div');
      item.className = 'today-command-item';
      const span = document.createElement('span');
      span.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = value;
      item.appendChild(span);
      item.appendChild(strong);
      summary.appendChild(item);
    });
    sheet.body.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'mobile-review-list';
    const addReviewAction = (text, label, action) => {
      const row = document.createElement('div');
      row.className = 'mobile-review-row';
      const copy = document.createElement('span');
      copy.textContent = text;
      row.appendChild(copy);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary';
      button.textContent = label;
      button.addEventListener('click', () => {
        sheet.close();
        action();
      });
      row.appendChild(button);
      list.appendChild(row);
    };
    review.missingDescriptions.slice(0, 3).forEach((entry) => {
      const project = getEntryProject(entry);
      addReviewAction(
        `${project ? project.name : 'Entry'} is missing a description.`,
        'Edit',
        () => editStoppedEntry(entry.id)
      );
    });
    review.longEntries.slice(0, 3).forEach((entry) => {
      const project = getEntryProject(entry);
      addReviewAction(
        `${project ? project.name : 'Entry'} is ${formatDuration(entry.duration || 0)}.`,
        'Split',
        () => splitStoppedEntry(entry.id)
      );
    });
    review.emptyDays.slice(0, 3).forEach((day) => {
      addReviewAction(`${day} has no tracked entries.`, 'Quick log', () =>
        openMobileQuickLogSheet(`1h ${day}`)
      );
    });
    if (!list.childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = 'No review issues found.';
      list.appendChild(empty);
    }
    sheet.body.appendChild(list);
    sheet.addAction('Open Entries', 'primary', () => {
      sheet.close();
      activateSection('entries');
      applyEntryFilterSnapshot({
        ...getCurrentEntryFilterSnapshot(),
        from: review.bounds.from,
        to: review.bounds.to,
        showAll: true
      });
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function openMobileSyncWizard() {
    const sheet = createMobileSheet('Sync setup', {
      className: 'mobile-sync-wizard-sheet',
      description:
        'Choose a folder, write a backup, verify it, then resolve conflicts if needed.'
    });
    const render = () => {
      sheet.body.innerHTML = '';
      const state = getMobileSyncState();
      const status = document.createElement('div');
      status.className = `mobile-sync-wizard-status ${state.state}`;
      const statusLabel = document.createElement('strong');
      statusLabel.textContent = state.label;
      const statusDetail = document.createElement('span');
      statusDetail.textContent = `${state.detail} - ${getPwaMobileDetail()}`;
      status.appendChild(statusLabel);
      status.appendChild(statusDetail);
      sheet.body.appendChild(status);
      const steps = document.createElement('div');
      steps.className = 'mobile-sync-wizard-steps';
      const addStep = (label, detail, action, disabled = false) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'mobile-sync-step';
        row.disabled = disabled;
        const rowLabel = document.createElement('strong');
        rowLabel.textContent = label;
        const rowDetail = document.createElement('span');
        rowDetail.textContent = detail;
        row.appendChild(rowLabel);
        row.appendChild(rowDetail);
        row.addEventListener('click', async () => {
          await action();
          renderMobileSyncStatus();
          render();
        });
        steps.appendChild(row);
      };
      addStep(
        backupDirHandle ? 'Folder selected' : 'Choose folder',
        backupDirHandle
          ? backupDirHandle.name || data.backupDirName || 'Backup folder ready'
          : 'Pick a cloud-synced folder for automatic backups',
        () => chooseBackupDir({ activateSync: true }),
        !window.showDirectoryPicker
      );
      addStep(
        'Write backup',
        data.lastBackupAt
          ? `Last backup ${formatRelativeTime(data.lastBackupAt)}`
          : 'No backup written yet',
        () => saveBackupToDir({ promptOnConflict: true }),
        !backupDirHandle || backupPermissionState !== 'granted'
      );
      addStep(
        'Verify backup',
        data.lastBackupVerifiedAt
          ? `Verified ${formatRelativeTime(data.lastBackupVerifiedAt)}`
          : 'Read latest backup, manifest, and snapshot back',
        () => verifyBackupRoundTrip(),
        !backupDirHandle || backupPermissionState !== 'granted'
      );
      addStep(
        backupConflict ? 'Resolve conflict' : 'Conflict check',
        backupConflict
          ? formatBackupConflictWarning(backupConflict)
          : 'No newer backup detected',
        () => restoreLatestBackupFromDir(),
        !backupConflict
      );
      sheet.body.appendChild(steps);
    };
    render();
    sheet.addAction('Open Backup', 'primary', () => {
      sheet.close();
      activateSection('importExport');
    });
    sheet.addAction('Close', 'secondary', sheet.close);
  }

  function renderMobileTodayCommandPanel({
    panel,
    runningEntries,
    activeEntries,
    stats,
    recommendation
  }) {
    if (!isMobileViewport()) return false;
    panel.classList.add('mobile-today-panel');
    const running = runningEntries[0] || null;
    const runningProject = running ? getEntryProject(running) : null;
    const workoutSummary = getWorkoutMobileSummary();
    const header = document.createElement('div');
    header.className = 'mobile-today-header';
    const title = document.createElement('div');
    title.className = 'today-command-title';
    title.textContent = 'Today';
    header.appendChild(title);
    const target = document.createElement('div');
    target.className = 'today-command-meta';
    target.textContent = `${formatDuration(Math.round(stats.todayHours * 3600))} / ${stats.dailyTarget.toFixed(1)}h`;
    header.appendChild(target);
    panel.appendChild(header);

    const primary = document.createElement('div');
    primary.className = 'mobile-today-primary';
    const appendTodayCard = (label, value, className, onClick) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `mobile-today-card${className ? ` ${className}` : ''}`;
      const span = document.createElement('span');
      span.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = value;
      card.appendChild(span);
      card.appendChild(strong);
      card.addEventListener('click', onClick);
      primary.appendChild(card);
      return card;
    };
    appendTodayCard(
      running ? 'Running now' : 'Timer',
      running ? runningProject?.name || 'Running timer' : 'No active timer',
      running ? 'warm' : '',
      () => activateSection('timer')
    );
    appendTodayCard(
      'Next',
      recommendation
        ? recommendation.project.name
        : activeEntries.length
          ? `${activeEntries.length} active`
          : 'Caught up',
      'primary',
      () => {
        if (recommendation) {
          startTimerShortcut(
            {
              project: recommendation.project,
              description: '',
              focusFactor: DEFAULT_FOCUS_FACTOR
            },
            { navigate: true }
          );
        } else {
          activateSection('timer');
        }
      }
    );
    appendTodayCard(
      'Target',
      `${formatDuration(Math.round(stats.todayHours * 3600))} / ${stats.dailyTarget.toFixed(1)}h`,
      '',
      () => activateSection('timer')
    );
    appendTodayCard(
      'Daily workout target',
      workoutSummary.label,
      workoutSummary.tone,
      () => openMobileWorkoutSheet(getFavoriteWorkoutPreset())
    );
    panel.appendChild(primary);

    const runningProjectIds = new Set(
      runningEntries.map((entry) => String(entry.projectId))
    );
    renderMobileMostUsedTimers(panel, runningProjectIds);

    const actions = document.createElement('div');
    actions.className = 'mobile-today-actions';
    const nextTimerShortcut = getStartableTimerShortcuts({
      recommendation,
      runningProjectIds,
      limit: 1
    })[0];
    const actionConfigs = [];
    if (nextTimerShortcut) {
      actionConfigs.push([
        'Start next',
        'primary',
        () => startTimerShortcut(nextTimerShortcut, { navigate: true })
      ]);
    }
    actionConfigs.push([
      'Timer',
      nextTimerShortcut ? 'secondary' : 'primary',
      () => activateSection('timer')
    ]);
    actionConfigs.forEach(([label, variant, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${variant}`;
      button.textContent = label;
      button.addEventListener('click', action);
      actions.appendChild(button);
    });
    panel.appendChild(actions);

    return true;
  }

  function renderTodayCommandPanel() {
    const panel = document.getElementById('todayCommandPanel');
    if (!panel) return;
    syncTodayCommandPanelVisibility();
    panel.innerHTML = '';
    panel.classList.remove('mobile-today-panel');
    const runningEntries = getRunningEntries();
    const activeEntries = getActiveRunningEntries();
    const stats = computeGlobalStats();
    const recommendation = getRecommendedProjectForToday();
    const audit = getLocalDataAudit();
    const settings = ensureReminderSettings();
    if (
      renderMobileTodayCommandPanel({
        panel,
        runningEntries,
        activeEntries,
        stats,
        recommendation,
        settings
      })
    ) {
      return;
    }

    const header = document.createElement('div');
    header.className = 'today-command-header';
    const title = document.createElement('div');
    title.className = 'today-command-title';
    title.textContent = 'Today';
    header.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'today-command-meta';
    meta.textContent = `${formatDuration(Math.round(stats.todayHours * 3600))} / ${stats.dailyTarget.toFixed(1)}h`;
    header.appendChild(meta);
    panel.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'today-command-grid';
    const addItem = (label, value, tone = '') => {
      const item = document.createElement('div');
      item.className = `today-command-item${tone ? ` ${tone}` : ''}`;
      const itemLabel = document.createElement('span');
      itemLabel.textContent = label;
      const itemValue = document.createElement('strong');
      itemValue.textContent = value;
      item.appendChild(itemLabel);
      item.appendChild(itemValue);
      grid.appendChild(item);
    };
    addItem(
      'Timers',
      runningEntries.length
        ? `${activeEntries.length}/${runningEntries.length} active`
        : 'none',
      runningEntries.length ? 'warm' : ''
    );
    addItem(
      'Next',
      recommendation
        ? `${recommendation.project.name} ${formatRecommendationHours(getDailyPlanRecommendedRemaining(recommendation.dailyPlan))}h`
        : 'caught up'
    );
    addItem(
      'Backup',
      getBackupFreshnessLabel(),
      backupConflict || !data.lastBackupAt ? 'risk' : ''
    );
    addItem(
      'Reminders',
      settings.enabled ? 'on' : 'off',
      settings.enabled ? '' : 'muted'
    );
    if (audit.staleRunningEntries > 0) {
      addItem('Review', `${audit.staleRunningEntries} old timer`, 'risk');
    }
    panel.appendChild(grid);

    const quickTimerShortcuts = getStartableTimerShortcuts({
      recommendation,
      runningProjectIds: new Set(
        runningEntries.map((entry) => String(entry.projectId))
      ),
      limit: isMobileViewport() ? 5 : 3
    });
    if (quickTimerShortcuts.length) {
      const shortcutPanel = document.createElement('div');
      shortcutPanel.className = 'today-timer-shortcuts';
      const shortcutHeader = document.createElement('div');
      shortcutHeader.className = 'today-timer-shortcuts-header';
      shortcutHeader.textContent = 'Quick timers';
      shortcutPanel.appendChild(shortcutHeader);
      const shortcutRow = document.createElement('div');
      shortcutRow.className = 'today-timer-shortcut-row';
      quickTimerShortcuts.forEach((shortcut) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `today-timer-shortcut${shortcut.source === 'recommended' ? ' primary' : ''}`;
        if (shortcut.source === 'recommended') {
          button.textContent = `Next: ${shortcut.project.name}`;
        } else if (shortcut.source === 'last') {
          button.textContent = `Last: ${formatTimerPresetLabel(
            shortcut.project,
            shortcut.description,
            shortcut.focusFactor
          )}`;
        } else if (shortcut.source === 'yesterday') {
          button.textContent = `Yesterday: ${formatTimerPresetLabel(
            shortcut.project,
            shortcut.description,
            shortcut.focusFactor
          )}`;
        } else {
          button.textContent = formatTimerPresetLabel(
            shortcut.project,
            shortcut.description,
            shortcut.focusFactor
          );
        }
        button.title =
          'Start ' +
          shortcut.project.name +
          (shortcut.description ? ' - ' + shortcut.description : '') +
          ' at ' +
          formatFocusPercent(shortcut.focusFactor);
        button.addEventListener('click', () => {
          startTimerShortcut(shortcut, { navigate: true });
        });
        shortcutRow.appendChild(button);
      });
      shortcutPanel.appendChild(shortcutRow);
      panel.appendChild(shortcutPanel);
    }

    const actions = document.createElement('div');
    actions.className = 'today-command-actions';
    if (runningEntries.length) {
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'btn danger';
      stopBtn.textContent = 'Stop All';
      stopBtn.addEventListener('click', () => {
        activateSection('timer');
        stopAllTimers();
      });
      actions.appendChild(stopBtn);
    }
    if (actions.childElementCount) {
      panel.appendChild(actions);
    }
  }

  function formatDateInputValue(date) {
    return formatLocalDateString(startOfLocalDay(date));
  }

  function getMonthBounds(offset = 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return {
      from: formatDateInputValue(start),
      to: formatDateInputValue(end)
    };
  }

  function getWeekBounds(offset = 0) {
    const now = startOfLocalDay(new Date());
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1 + offset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      from: formatDateInputValue(monday),
      to: formatDateInputValue(sunday)
    };
  }

  function getDayBounds(offset = 0) {
    const day = addLocalDays(startOfLocalDay(new Date()), offset);
    const value = formatDateInputValue(day);
    return { from: value, to: value };
  }

  function applyEntryDateQuickFilter(value) {
    let bounds = null;
    if (value === 'today') bounds = getDayBounds(0);
    else if (value === 'yesterday') bounds = getDayBounds(-1);
    else if (value === 'this-week') bounds = getWeekBounds(0);
    else if (value === 'last-week') bounds = getWeekBounds(-1);
    else if (value === 'this-month') bounds = getMonthBounds(0);
    if (!bounds) return;
    applyEntryFilterSnapshot({
      ...getCurrentEntryFilterSnapshot(),
      from: bounds.from,
      to: bounds.to,
      showAll: true
    });
  }

  function renderEntryDateQuickFilters() {
    if (!entryDateQuickFilters) return;
    entryDateQuickFilters.innerHTML = '';
    [
      ['today', 'Today'],
      ['yesterday', 'Yesterday'],
      ['this-week', 'This week'],
      ['last-week', 'Last week'],
      ['this-month', 'This month']
    ].forEach(([value, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary entry-date-chip';
      button.textContent = label;
      button.addEventListener('click', () => {
        applyEntryDateQuickFilter(value);
      });
      entryDateQuickFilters.appendChild(button);
    });
  }

  function getCurrentEntryFilterSnapshot() {
    return {
      projectId: entryProjectFilter,
      search: entrySearchQuery,
      from: entryDateFrom,
      to: entryDateTo,
      showAll: showAllEntries
    };
  }

  function applyEntryFilterSnapshot(filters = {}) {
    entryProjectFilter = String(filters.projectId || '');
    entrySearchQuery = String(filters.search || '')
      .trim()
      .toLowerCase();
    entryDateFrom = String(filters.from || '');
    entryDateTo = String(filters.to || '');
    showAllEntries = filters.showAll === true;
    if (entryProjectFilterSelect)
      entryProjectFilterSelect.value = entryProjectFilter;
    if (entrySearchInput) entrySearchInput.value = entrySearchQuery;
    syncEntryDateFilterControls();
    updateEntriesViewToggleLabel();
    updateEntriesTable();
  }

  function applyBuiltinBillingView(value) {
    let bounds = null;
    if (value === 'this-month') bounds = getMonthBounds(0);
    else if (value === 'last-month') bounds = getMonthBounds(-1);
    else if (value === 'this-week') bounds = getWeekBounds(0);
    else if (value === 'last-week') bounds = getWeekBounds(-1);
    if (!bounds) return false;
    applyEntryFilterSnapshot({
      ...getCurrentEntryFilterSnapshot(),
      from: bounds.from,
      to: bounds.to,
      showAll: true
    });
    return true;
  }

  function syncBillingPresetControls() {
    if (!billingPresetSelect) return;
    const currentValue = billingPresetSelect.value;
    billingPresetSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose view...';
    billingPresetSelect.appendChild(placeholder);
    [
      ['builtin:this-month', 'This month'],
      ['builtin:last-month', 'Last month'],
      ['builtin:this-week', 'This week'],
      ['builtin:last-week', 'Last week']
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      billingPresetSelect.appendChild(option);
    });
    const savedGroup = document.createElement('optgroup');
    savedGroup.label = 'Saved views';
    ensureBillingViews().forEach((view) => {
      const option = document.createElement('option');
      option.value = `saved:${view.id}`;
      option.textContent = view.name;
      savedGroup.appendChild(option);
    });
    billingPresetSelect.appendChild(savedGroup);
    if (
      currentValue &&
      Array.from(billingPresetSelect.options).some(
        (option) => option.value === currentValue
      )
    ) {
      billingPresetSelect.value = currentValue;
    }
    if (deleteBillingViewBtn) {
      deleteBillingViewBtn.disabled =
        !billingPresetSelect.value ||
        !billingPresetSelect.value.startsWith('saved:');
    }
  }

  async function saveCurrentBillingView() {
    const values = await openFormDialog({
      title: 'Save Billing View',
      fields: [
        {
          name: 'name',
          label: 'View Name',
          value: '',
          placeholder: 'June Acme billing',
          required: true
        }
      ],
      submitLabel: 'Save View'
    });
    if (!values) return;
    const name = String(values.name || '').trim();
    if (!name) {
      showToast('Enter a name for the billing view.');
      return;
    }
    const snapshot = cloneData();
    const views = ensureBillingViews();
    const existing = views.find(
      (view) => view.name.toLowerCase() === name.toLowerCase()
    );
    const item = existing || {
      id: uuid(),
      name,
      createdAt: new Date().toISOString()
    };
    item.name = name;
    item.filters = getCurrentEntryFilterSnapshot();
    if (!existing) views.push(item);
    data.entryBillingViews = views;
    saveData();
    syncBillingPresetControls();
    offerUndo(
      existing ? 'Billing view updated.' : 'Billing view saved.',
      snapshot
    );
  }

  function deleteSelectedBillingView() {
    if (
      !billingPresetSelect ||
      !billingPresetSelect.value.startsWith('saved:')
    ) {
      return;
    }
    const id = billingPresetSelect.value.slice('saved:'.length);
    const snapshot = cloneData();
    const before = ensureBillingViews().length;
    data.entryBillingViews = ensureBillingViews().filter(
      (view) => String(view.id) !== id
    );
    if (data.entryBillingViews.length === before) return;
    saveData();
    syncBillingPresetControls();
    offerUndo('Billing view deleted.', snapshot);
  }

  if (billingPresetSelect) {
    billingPresetSelect.addEventListener('change', () => {
      const value = billingPresetSelect.value;
      if (value.startsWith('builtin:')) {
        applyBuiltinBillingView(value.slice('builtin:'.length));
      } else if (value.startsWith('saved:')) {
        const id = value.slice('saved:'.length);
        const view = ensureBillingViews().find(
          (candidate) => String(candidate.id) === id
        );
        if (view) applyEntryFilterSnapshot(view.filters);
      }
      syncBillingPresetControls();
    });
    syncBillingPresetControls();
  }
  if (saveBillingViewBtn) {
    saveBillingViewBtn.addEventListener('click', () => {
      saveCurrentBillingView();
    });
  }
  if (deleteBillingViewBtn) {
    deleteBillingViewBtn.addEventListener('click', () => {
      deleteSelectedBillingView();
    });
  }
  if (entryDateFromInput) {
    entryDateFromInput.addEventListener('change', () => {
      entryDateFrom = entryDateFromInput.value || '';
      syncEntryDateFilterControls();
      updateEntriesTable();
    });
  }
  if (entryDateToInput) {
    entryDateToInput.addEventListener('change', () => {
      entryDateTo = entryDateToInput.value || '';
      syncEntryDateFilterControls();
      updateEntriesTable();
    });
  }
  if (entryDateClearBtn) {
    entryDateClearBtn.addEventListener('click', () => {
      entryDateFrom = '';
      entryDateTo = '';
      syncEntryDateFilterControls();
      updateEntriesTable();
    });
  }
  syncEntryDateFilterControls();
  renderEntryDateQuickFilters();

  // Nudge buttons for manual entry: adjust hours by +/-5 minutes
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
    const snapshot = cloneData();
    data.entries = data.entries.filter((e) => e.id !== id);
    selectedEntryIds.delete(String(id));
    saveData();
    refreshAllViews();
    offerUndo('Entry deleted.', snapshot);
  }

  function duplicateStoppedEntry(entryId) {
    const entry = data.entries.find(
      (candidate) => String(candidate.id) === String(entryId)
    );
    if (!entry || entry.isRunning) {
      showToast('Only stopped entries can be duplicated.');
      return;
    }
    const snapshot = cloneData();
    const nowIso = new Date().toISOString();
    const duplicate = {
      ...entry,
      id: uuid(),
      createdAt: nowIso,
      isRunning: false
    };
    duplicate.focusFactor = getEntryFocusFactor(entry, 1);
    duplicate.manualFactor = duplicate.focusFactor;
    delete duplicate.effectiveSeconds;
    delete duplicate.lastUpdateTime;
    delete duplicate.factor;
    delete duplicate.pausedAt;
    data.entries.push(duplicate);
    saveData();
    refreshAllViews();
    offerUndo('Entry duplicated.', snapshot);
  }

  async function splitStoppedEntry(entryId) {
    const entry = data.entries.find(
      (candidate) => String(candidate.id) === String(entryId)
    );
    if (!entry || entry.isRunning) {
      showToast('Only stopped entries can be split.');
      return;
    }
    const start = new Date(entry.startTime);
    const end = new Date(entry.endTime);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      showToast(
        'Entry needs valid start and end times before it can be split.'
      );
      return;
    }
    const midpoint = new Date(
      start.getTime() + (end.getTime() - start.getTime()) / 2
    );
    const values = await openFormDialog({
      title: 'Split Entry',
      fields: [
        {
          name: 'splitTime',
          label: 'Split Time',
          type: 'datetime-local',
          value: toDateTimeInputValue(midpoint),
          required: true
        },
        {
          name: 'firstDescription',
          label: 'First Description',
          value: entry.description || ''
        },
        {
          name: 'secondDescription',
          label: 'Second Description',
          value: entry.description || ''
        }
      ],
      submitLabel: 'Split Entry'
    });
    if (!values) return;
    const splitTime = parseDateTimeInput(values.splitTime);
    if (!splitTime || splitTime <= start || splitTime >= end) {
      showToast('Split time must be between the entry start and end.');
      return;
    }
    const focusFactor = getEntryFocusFactor(entry, 1);
    const firstDuration = Math.floor(
      ((splitTime.getTime() - start.getTime()) / 1000) * focusFactor
    );
    const secondDuration = Math.floor(
      ((end.getTime() - splitTime.getTime()) / 1000) * focusFactor
    );
    if (firstDuration <= 0 || secondDuration <= 0) {
      showToast('Split would create an empty entry.');
      return;
    }
    const snapshot = cloneData();
    const secondEntry = {
      ...entry,
      id: uuid(),
      description: String(values.secondDescription || '').trim(),
      startTime: splitTime.toISOString(),
      endTime: end.toISOString(),
      duration: secondDuration,
      createdAt: new Date().toISOString(),
      isRunning: false,
      focusFactor,
      manualFactor: focusFactor
    };
    delete secondEntry.effectiveSeconds;
    delete secondEntry.lastUpdateTime;
    delete secondEntry.factor;
    delete secondEntry.pausedAt;
    entry.description = String(values.firstDescription || '').trim();
    entry.endTime = splitTime.toISOString();
    entry.duration = firstDuration;
    entry.focusFactor = focusFactor;
    entry.manualFactor = focusFactor;
    entry.isRunning = false;
    delete entry.effectiveSeconds;
    delete entry.lastUpdateTime;
    delete entry.factor;
    delete entry.pausedAt;
    data.entries.push(secondEntry);
    saveData();
    refreshAllViews();
    offerUndo('Entry split.', snapshot);
  }

  async function editStoppedEntry(entryId) {
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    if (entry.isRunning) {
      editRunningTimer(entryId);
      return;
    }
    const currentProject = getEntryProject(entry);
    const projectOptions = [];
    if (currentProject) {
      projectOptions.push({
        value: currentProject.id,
        label: `${currentProject.name}${isProjectArchived(currentProject) ? ' (archived)' : ''}`
      });
    }
    getActiveProjects().forEach((project) => {
      if (currentProject && String(project.id) === String(currentProject.id)) {
        return;
      }
      projectOptions.push({ value: project.id, label: project.name });
    });
    const currentFactor = getEntryFocusFactor(entry, 1);
    const factorOptions = FOCUS_FACTOR_OPTIONS.map((option) => ({
      value: String(option.value),
      label: option.label
    }));
    if (
      !factorOptions.some((option) => option.value === String(currentFactor))
    ) {
      factorOptions.push({
        value: String(currentFactor),
        label: `${formatFocusPercent(currentFactor)} - current`
      });
    }
    const values = await openFormDialog({
      title: 'Edit Entry',
      fields: [
        {
          name: 'projectId',
          label: 'Project',
          type: 'select',
          value: currentProject ? currentProject.id : '',
          options: projectOptions,
          required: true
        },
        {
          name: 'description',
          label: 'Description',
          value: entry.description || ''
        },
        {
          name: 'startTime',
          label: 'Start Time',
          type: 'datetime-local',
          value: toDateTimeInputValue(entry.startTime),
          required: true
        },
        {
          name: 'endTime',
          label: 'End Time',
          type: 'datetime-local',
          value: toDateTimeInputValue(entry.endTime),
          required: true
        },
        {
          name: 'focusFactor',
          label: 'Focus',
          type: 'select',
          value: String(currentFactor),
          options: factorOptions
        }
      ],
      submitLabel: 'Save Entry'
    });
    if (!values) return;
    const project = data.projects.find(
      (candidate) => String(candidate.id) === String(values.projectId)
    );
    if (!project) {
      showToast('Choose a valid project.');
      return;
    }
    const parsedStart = parseDateTimeInput(values.startTime);
    const parsedEnd = parseDateTimeInput(values.endTime);
    if (!parsedStart) {
      showToast('Enter a valid start time.');
      return;
    }
    if (!parsedEnd) {
      showToast('Enter a valid end time.');
      return;
    }
    if (parsedEnd <= parsedStart) {
      showToast('End time must be after start time.');
      return;
    }
    if (parsedEnd > new Date()) {
      showToast('End time cannot be in the future.');
      return;
    }
    const focusFactor = normalizeFocusFactor(values.focusFactor);
    const snapshot = cloneData();
    entry.projectId = project.id;
    entry.description = String(values.description || '').trim();
    entry.startTime = parsedStart.toISOString();
    entry.endTime = parsedEnd.toISOString();
    entry.duration = Math.floor(
      Math.max(0, (parsedEnd.getTime() - parsedStart.getTime()) / 1000) *
        focusFactor
    );
    entry.focusFactor = focusFactor;
    entry.manualFactor = focusFactor;
    entry.isRunning = false;
    delete entry.effectiveSeconds;
    delete entry.lastUpdateTime;
    delete entry.factor;
    delete entry.pausedAt;
    saveData();
    refreshAllViews();
    offerUndo('Entry updated.', snapshot);
  }

  async function moveEntryWithDialog(entryId) {
    const entry = data.entries.find(
      (candidate) => String(candidate.id) === String(entryId)
    );
    if (!entry) return;
    const projectOptions = getActiveProjects()
      .filter((project) => String(project.id) !== String(entry.projectId))
      .map((project) => ({ value: project.id, label: project.name }));
    if (!projectOptions.length) {
      showToast('No other active project is available.');
      return;
    }
    const values = await openFormDialog({
      title: 'Move Entry',
      fields: [
        {
          name: 'projectId',
          label: 'Project',
          type: 'select',
          options: projectOptions,
          required: true
        }
      ],
      submitLabel: 'Move Entry'
    });
    if (!values) return;
    const project = data.projects.find(
      (candidate) => String(candidate.id) === String(values.projectId)
    );
    if (!project) {
      showToast('Choose a valid project.');
      return;
    }
    const snapshot = cloneData();
    entry.projectId = project.id;
    saveData();
    refreshAllViews();
    offerUndo('Entry moved.', snapshot);
  }

  async function confirmDeleteEntry(entryId) {
    const ok = await requestConfirm({
      title: 'Delete Entry',
      message: 'Delete this time entry?',
      confirmLabel: 'Delete',
      danger: true
    });
    if (ok) deleteEntry(entryId);
  }

  function openEntryActionSheet(entryId) {
    const entry = data.entries.find(
      (candidate) => String(candidate.id) === String(entryId)
    );
    if (!entry) return;
    const project = getEntryProject(entry);
    const sheet = createMobileSheet('Entry actions', {
      className: 'mobile-entry-action-sheet',
      description: `${project ? project.name : 'Unknown project'} - ${
        entry.description || 'No description'
      }`
    });
    const grid = document.createElement('div');
    grid.className = 'mobile-entry-action-grid';
    const addButton = (label, variant, action, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${variant}`;
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        sheet.close();
        action();
      });
      grid.appendChild(button);
      return button;
    };
    addButton('Edit', 'primary', () => editStoppedEntry(entry.id));
    addButton(
      'Duplicate',
      'secondary',
      () => duplicateStoppedEntry(entry.id),
      !!entry.isRunning
    );
    addButton(
      'Split',
      'secondary',
      () => splitStoppedEntry(entry.id),
      !!entry.isRunning || !entry.endTime
    );
    addButton('Move Project', 'secondary', () => moveEntryWithDialog(entry.id));
    addButton('Delete', 'danger', () => confirmDeleteEntry(entry.id));
    sheet.body.appendChild(grid);
  }

  function shouldIgnoreSwipeTarget(target) {
    return !!(
      target &&
      target.closest &&
      target.closest('button, input, select, textarea, a, label')
    );
  }

  function attachEntrySwipeActions(row, entry) {
    row.classList.add('entry-swipe-row');
    row.dataset.entryId = entry.id;
    let startX = 0;
    let startY = 0;
    let moved = false;
    row.addEventListener(
      'touchstart',
      (event) => {
        if (!isMobileViewport() || shouldIgnoreSwipeTarget(event.target))
          return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        moved = false;
      },
      { passive: true }
    );
    row.addEventListener(
      'touchmove',
      (event) => {
        if (!isMobileViewport() || shouldIgnoreSwipeTarget(event.target))
          return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return;
        moved = true;
        row.style.transform = `translateX(${Math.max(-84, Math.min(84, dx))}px)`;
      },
      { passive: true }
    );
    row.addEventListener('touchend', (event) => {
      if (!isMobileViewport() || shouldIgnoreSwipeTarget(event.target)) return;
      const touch = event.changedTouches && event.changedTouches[0];
      row.style.transform = '';
      if (!moved || !touch) return;
      const dx = touch.clientX - startX;
      if (dx <= -56) openEntryActionSheet(entry.id);
      else if (dx >= 56) editStoppedEntry(entry.id);
    });
  }

  function getEntryProject(entry) {
    return (
      data.projects.find((p) => String(p.id) === String(entry.projectId)) ||
      null
    );
  }

  function getEntryDateRangeFilter() {
    const fromDate = entryDateFrom ? parseLocalDateString(entryDateFrom) : null;
    const toDate = entryDateTo ? parseLocalDateString(entryDateTo) : null;
    return {
      fromDate,
      toExclusive: toDate ? addLocalDays(toDate, 1) : null,
      hasDateFilter: !!(fromDate || toDate)
    };
  }

  function entryOverlapsDateRange(entry, fromDate, toExclusive) {
    const startDate = new Date(entry.startTime);
    if (Number.isNaN(startDate.getTime())) return false;
    const rawEndDate = entry.endTime ? new Date(entry.endTime) : startDate;
    const endDate =
      !Number.isNaN(rawEndDate.getTime()) && rawEndDate >= startDate
        ? rawEndDate
        : startDate;
    if (fromDate && endDate < fromDate) return false;
    if (toExclusive && startDate >= toExclusive) return false;
    return true;
  }

  function formatEntryDateRangeLabel(fromDate, toExclusive) {
    const fromLabel = fromDate ? formatLocalDateString(fromDate) : 'start';
    const toLabel = toExclusive
      ? formatLocalDateString(addLocalDays(toExclusive, -1))
      : 'end';
    return `Date range ${fromLabel} - ${toLabel}`;
  }

  function getEntriesForCurrentView() {
    let entriesToShow = data.entries;
    const { fromDate, toExclusive, hasDateFilter } = getEntryDateRangeFilter();
    if (!showAllEntries && !hasDateFilter) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      entriesToShow = entriesToShow.filter((entry) => {
        const startDate = new Date(entry.startTime);
        const endDate = entry.endTime ? new Date(entry.endTime) : startDate;
        return startDate >= cutoff || endDate >= cutoff;
      });
    }
    if (hasDateFilter) {
      entriesToShow = entriesToShow.filter((entry) =>
        entryOverlapsDateRange(entry, fromDate, toExclusive)
      );
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
    const { fromDate, toExclusive, hasDateFilter } = getEntryDateRangeFilter();
    const scopeText = hasDateFilter
      ? formatEntryDateRangeLabel(fromDate, toExclusive)
      : showAllEntries
        ? 'All time'
        : 'Last 30 days';
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

  function escapeCsv(value) {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function downloadCsv(rows, filePrefix) {
    const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filePrefix}-${formatLocalDateString(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportEntriesCsv(entries) {
    const rows = [
      [
        'Project',
        'Client',
        'Description',
        'Start',
        'End',
        'Duration Hours',
        'Focus',
        'Total'
      ]
    ];
    entries.forEach((entry) => {
      const project = getEntryProject(entry);
      const hours = (entry.duration || 0) / 3600 || 0;
      const total = project ? hours * (Number(project.hourlyRate) || 0) : 0;
      rows.push([
        project ? project.name : '',
        project ? project.client || '' : '',
        entry.description || '',
        entry.startTime || '',
        entry.endTime || '',
        hours.toFixed(3),
        formatFocusPercent(getEntryFocusFactor(entry, 1)),
        total.toFixed(2)
      ]);
    });
    downloadCsv(rows, 'timekeeper-entries');
  }

  function exportEntrySummaryCsv(entries) {
    const grouped = new Map();
    entries.forEach((entry) => {
      const project = getEntryProject(entry);
      const projectId = project ? String(project.id) : 'missing-project';
      const projectName = project ? project.name : '';
      const client = project ? project.client || '' : '';
      const rate = project ? Number(project.hourlyRate) || 0 : 0;
      const key = [client, projectId, projectName, String(rate)].join('::');
      const hours = (entry.duration || 0) / 3600 || 0;
      const current = grouped.get(key) || {
        client,
        project: projectName,
        rate,
        entries: 0,
        hours: 0,
        total: 0
      };
      current.entries += 1;
      current.hours += hours;
      current.total += hours * rate;
      grouped.set(key, current);
    });
    const rows = [
      ['Client', 'Project', 'Entries', 'Duration Hours', 'Hourly Rate', 'Total']
    ];
    Array.from(grouped.values())
      .sort((a, b) => {
        const clientCompare = a.client.localeCompare(b.client, undefined, {
          sensitivity: 'base'
        });
        if (clientCompare !== 0) return clientCompare;
        return a.project.localeCompare(b.project, undefined, {
          sensitivity: 'base'
        });
      })
      .forEach((item) => {
        rows.push([
          item.client,
          item.project,
          String(item.entries),
          item.hours.toFixed(3),
          item.rate.toFixed(2),
          item.total.toFixed(2)
        ]);
      });
    const grandHours = Array.from(grouped.values()).reduce(
      (sum, item) => sum + item.hours,
      0
    );
    const grandTotal = Array.from(grouped.values()).reduce(
      (sum, item) => sum + item.total,
      0
    );
    rows.push([
      'Total',
      '',
      String(entries.length),
      grandHours.toFixed(3),
      '',
      grandTotal.toFixed(2)
    ]);
    downloadCsv(rows, 'timekeeper-entry-summary');
  }

  function pruneSelectedEntryIds() {
    const existing = new Set(data.entries.map((entry) => String(entry.id)));
    Array.from(selectedEntryIds).forEach((id) => {
      if (!existing.has(String(id))) selectedEntryIds.delete(id);
    });
  }

  function renderEntryBulkActions(entriesToShow) {
    const bulkEl = document.getElementById('entryBulkActions');
    if (!bulkEl) return;
    pruneSelectedEntryIds();
    bulkEl.innerHTML = '';
    const visibleIds = entriesToShow.map((entry) => String(entry.id));
    const selectedVisible = entriesToShow.filter((entry) =>
      selectedEntryIds.has(String(entry.id))
    );
    const count = selectedVisible.length;
    const label = document.createElement('span');
    label.textContent = count
      ? `${count} selected`
      : `${entriesToShow.length} visible`;
    bulkEl.appendChild(label);
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'btn secondary';
    selectAllBtn.textContent = 'Select Visible';
    selectAllBtn.disabled = entriesToShow.length === 0;
    selectAllBtn.addEventListener('click', () => {
      visibleIds.forEach((id) => selectedEntryIds.add(id));
      updateEntriesTable();
    });
    bulkEl.appendChild(selectAllBtn);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn secondary';
    clearBtn.textContent = 'Clear';
    clearBtn.disabled = count === 0;
    clearBtn.addEventListener('click', () => {
      selectedEntryIds.clear();
      updateEntriesTable();
    });
    bulkEl.appendChild(clearBtn);
    const moveSelect = document.createElement('select');
    const movePlaceholder = document.createElement('option');
    movePlaceholder.value = '';
    movePlaceholder.textContent = 'Move to project...';
    moveSelect.appendChild(movePlaceholder);
    getActiveProjects().forEach((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      moveSelect.appendChild(option);
    });
    moveSelect.disabled = count === 0;
    moveSelect.addEventListener('change', () => {
      const projectId = moveSelect.value;
      if (!projectId) return;
      const snapshot = cloneData();
      data.entries.forEach((entry) => {
        if (selectedEntryIds.has(String(entry.id))) {
          entry.projectId = projectId;
        }
      });
      selectedEntryIds.clear();
      saveData();
      refreshAllViews();
      offerUndo('Entries moved.', snapshot);
    });
    bulkEl.appendChild(moveSelect);
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn danger';
    deleteBtn.textContent = 'Delete Selected';
    deleteBtn.disabled = count === 0;
    deleteBtn.addEventListener('click', async () => {
      const ok = await requestConfirm({
        title: 'Delete Entries',
        message: `Delete ${count} selected ${count === 1 ? 'entry' : 'entries'}?`,
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) return;
      const snapshot = cloneData();
      data.entries = data.entries.filter(
        (entry) => !selectedEntryIds.has(String(entry.id))
      );
      selectedEntryIds.clear();
      saveData();
      refreshAllViews();
      offerUndo('Entries deleted.', snapshot);
    });
    bulkEl.appendChild(deleteBtn);
    const exportVisibleBtn = document.createElement('button');
    exportVisibleBtn.type = 'button';
    exportVisibleBtn.className = 'btn secondary';
    exportVisibleBtn.textContent = 'Export Visible CSV';
    exportVisibleBtn.disabled = entriesToShow.length === 0;
    exportVisibleBtn.addEventListener('click', () => {
      exportEntriesCsv(entriesToShow);
    });
    bulkEl.appendChild(exportVisibleBtn);
    const exportSummaryBtn = document.createElement('button');
    exportSummaryBtn.type = 'button';
    exportSummaryBtn.className = 'btn secondary';
    exportSummaryBtn.textContent = 'Export Summary CSV';
    exportSummaryBtn.disabled = entriesToShow.length === 0;
    exportSummaryBtn.addEventListener('click', () => {
      exportEntrySummaryCsv(entriesToShow);
    });
    bulkEl.appendChild(exportSummaryBtn);
  }

  // Entries table
  function updateEntriesTable() {
    const tbody = document.getElementById('entriesTableBodyPro');
    tbody.innerHTML = '';
    const entriesToShow = getEntriesForCurrentView();
    syncBillingPresetControls();
    renderEntrySummary(entriesToShow);
    renderEntryBulkActions(entriesToShow);
    renderTodayCommandPanel();
    if (data.entries.length === 0 || entriesToShow.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
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
      attachEntrySwipeActions(tr, entry);
      const project = getEntryProject(entry);
      const hours = entry.duration ? entry.duration / 3600 : 0;
      const total = project ? hours * project.hourlyRate : 0;
      const selectTd = appendEntryCell(tr, 'Select', '');
      selectTd.className = 'entry-select-cell';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedEntryIds.has(String(entry.id));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedEntryIds.add(String(entry.id));
        else selectedEntryIds.delete(String(entry.id));
        renderEntryBulkActions(entriesToShow);
      });
      selectTd.appendChild(checkbox);
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
      appendEntryCell(
        tr,
        'Focus',
        formatFocusPercent(getEntryFocusFactor(entry, 1))
      );
      appendEntryCell(tr, 'Total', formatCurrency(total));
      const actionsTd = appendEntryCell(tr, 'Actions', '');
      // Action cell: add nudge and snap controls plus delete button
      actionsTd.className = 'entry-actions';
      const actionSheetBtn = document.createElement('button');
      actionSheetBtn.type = 'button';
      actionSheetBtn.className = 'btn primary entry-action-sheet-btn';
      actionSheetBtn.textContent = 'Actions';
      actionSheetBtn.addEventListener('click', () => {
        openEntryActionSheet(entry.id);
      });
      actionsTd.appendChild(actionSheetBtn);
      // -5m button
      const minusBtn = document.createElement('button');
      minusBtn.className = 'btn secondary';
      minusBtn.style.padding = '0.25rem 0.5rem';
      minusBtn.style.fontSize = '0.7rem';
      minusBtn.textContent = '-5m';
      minusBtn.addEventListener('click', () => {
        // Provide quick beep feedback
        provideHaptic('beep');
        const snapshot = cloneData();
        // Subtract 5 minutes (300 seconds) from the entry duration
        let newDur = (entry.duration || 0) - 300;
        if (newDur < 0) newDur = 0;
        entry.duration = newDur;
        // Update endTime based on new duration
        const start = new Date(entry.startTime);
        entry.endTime = new Date(start.getTime() + newDur * 1000).toISOString();
        saveData();
        refreshAllViews();
        offerUndo('Entry duration edited.', snapshot);
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
        const snapshot = cloneData();
        // Add 5 minutes to the duration
        let newDur = (entry.duration || 0) + 300;
        entry.duration = newDur;
        const start = new Date(entry.startTime);
        entry.endTime = new Date(start.getTime() + newDur * 1000).toISOString();
        saveData();
        refreshAllViews();
        offerUndo('Entry duration edited.', snapshot);
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
          const snapshot = cloneData();
          const minutes = (entry.duration || 0) / 60;
          const snappedMinutes = Math.round(minutes / val) * val;
          entry.duration = Math.max(0, Math.floor(snappedMinutes * 60));
          const start = new Date(entry.startTime);
          entry.endTime = new Date(
            start.getTime() + entry.duration * 1000
          ).toISOString();
          saveData();
          refreshAllViews();
          offerUndo('Entry duration edited.', snapshot);
        }
        // reset to placeholder
        snapSelect.value = '';
      });
      actionsTd.appendChild(snapSelect);
      const moveSelect = document.createElement('select');
      moveSelect.setAttribute('aria-label', 'Move Project');
      moveSelect.style.marginLeft = '0.25rem';
      moveSelect.style.padding = '0.25rem';
      moveSelect.style.fontSize = '0.7rem';
      moveSelect.style.border = '1px solid #cbd5e1';
      moveSelect.style.borderRadius = '0.375rem';
      const movePlaceholder = document.createElement('option');
      movePlaceholder.value = '';
      movePlaceholder.textContent = 'Move';
      moveSelect.appendChild(movePlaceholder);
      getActiveProjects().forEach((candidate) => {
        if (String(candidate.id) === String(entry.projectId)) return;
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = candidate.name;
        moveSelect.appendChild(option);
      });
      moveSelect.disabled = moveSelect.options.length <= 1;
      moveSelect.addEventListener('change', () => {
        const projectId = moveSelect.value;
        if (!projectId) return;
        const project = data.projects.find(
          (candidate) => String(candidate.id) === String(projectId)
        );
        if (!project) {
          moveSelect.value = '';
          return;
        }
        const snapshot = cloneData();
        entry.projectId = project.id;
        saveData();
        refreshAllViews();
        offerUndo('Entry moved.', snapshot);
      });
      actionsTd.appendChild(moveSelect);
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn secondary';
      editBtn.style.padding = '0.25rem 0.5rem';
      editBtn.style.fontSize = '0.7rem';
      editBtn.style.marginLeft = '0.25rem';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        editStoppedEntry(entry.id);
      });
      actionsTd.appendChild(editBtn);
      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.className = 'btn secondary';
      splitBtn.style.padding = '0.25rem 0.5rem';
      splitBtn.style.fontSize = '0.7rem';
      splitBtn.style.marginLeft = '0.25rem';
      splitBtn.textContent = 'Split';
      splitBtn.disabled = !!entry.isRunning || !entry.endTime;
      splitBtn.addEventListener('click', () => {
        splitStoppedEntry(entry.id);
      });
      actionsTd.appendChild(splitBtn);
      const duplicateBtn = document.createElement('button');
      duplicateBtn.type = 'button';
      duplicateBtn.className = 'btn secondary';
      duplicateBtn.style.padding = '0.25rem 0.5rem';
      duplicateBtn.style.fontSize = '0.7rem';
      duplicateBtn.style.marginLeft = '0.25rem';
      duplicateBtn.textContent = 'Duplicate';
      duplicateBtn.disabled = !!entry.isRunning;
      duplicateBtn.addEventListener('click', () => {
        duplicateStoppedEntry(entry.id);
      });
      actionsTd.appendChild(duplicateBtn);
      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.style.padding = '0.25rem 0.5rem';
      delBtn.style.fontSize = '0.7rem';
      delBtn.style.marginLeft = '0.25rem';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        confirmDeleteEntry(entry.id);
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
    const previousLastBackupVerifiedAt = data.lastBackupVerifiedAt || null;
    data = imported;
    if (!data.backupDirName && previousBackupDirName) {
      data.backupDirName = previousBackupDirName;
    }
    if (!data.lastBackupAt && previousLastBackupAt) {
      data.lastBackupAt = previousLastBackupAt;
    }
    if (!data.lastBackupVerifiedAt && previousLastBackupVerifiedAt) {
      data.lastBackupVerifiedAt = previousLastBackupVerifiedAt;
    }
    data.focusBlockerSites = normalizeFocusBlockedSites(
      data.focusBlockerSites,
      DEFAULT_FOCUS_BLOCKED_WEBSITES
    );
    data.timerPresets = normalizeTimerPresets(data.timerPresets);
    data.entryBillingViews = normalizeBillingViews(data.entryBillingViews);
    data.reminderSettings = normalizeReminderSettings(data.reminderSettings);
    data.codexIntegration = normalizeCodexIntegration(data.codexIntegration);
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
    updateCodexIntegrationPanel();
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
      const ok = await requestConfirm({
        title: 'Restore Latest Backup',
        message:
          'Restore the latest backup from the selected folder? This replaces the current local data.',
        confirmLabel: 'Restore',
        danger: true
      });
      if (!ok) return false;
      const snapshot = cloneData();
      setBackupConflict(null);
      applyImportedData(imported);
      offerUndo('Latest backup restored.', snapshot);
      await refreshBackupSnapshots({ quiet: true });
      return true;
    } catch (err) {
      console.error('Restore from backup failed:', err);
      backupWarningMessage =
        'Restore failed. Check that the backup folder contains timekeeper-data.json.';
      updateAutoSyncStatus();
      return false;
    }
  }

  async function restoreBackupSnapshotFromDir(fileName) {
    try {
      if (!backupDirHandle) {
        backupWarningMessage =
          'Choose a backup folder before restoring a snapshot.';
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
      const snapshotDirHandle = await getBackupSnapshotDirHandle();
      if (!snapshotDirHandle) {
        backupWarningMessage =
          'No timestamped backup snapshot folder was found.';
        updateAutoSyncStatus();
        return false;
      }
      const text = await readTextFile(snapshotDirHandle, fileName);
      const imported = JSON.parse(text);
      const ok = await requestConfirm({
        title: 'Restore Backup Snapshot',
        message:
          'Restore this timestamped backup snapshot? This replaces the current local data.',
        confirmLabel: 'Restore',
        danger: true
      });
      if (!ok) return false;
      const snapshot = cloneData();
      setBackupConflict(null);
      applyImportedData(imported);
      offerUndo('Backup snapshot restored.', snapshot);
      await refreshBackupSnapshots({ quiet: true });
      return true;
    } catch (err) {
      console.error('Restore backup snapshot failed:', err);
      backupWarningMessage =
        'Snapshot restore failed. Refresh snapshots and try again.';
      updateAutoSyncStatus();
      return false;
    }
  }

  function getNotificationPermissionLabel() {
    if (!('Notification' in window)) return 'not supported';
    return Notification.permission;
  }

  function showBrowserNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      showToast(body || title);
      return false;
    }
    try {
      new Notification(title, {
        body,
        icon: 'assets/timekeeper-icon.svg',
        badge: 'assets/timekeeper-icon.svg'
      });
      return true;
    } catch {
      showToast(body || title);
      return false;
    }
  }

  function updateReminderSettingsPanel() {
    const settings = ensureReminderSettings();
    const toggle = document.getElementById('reminderEnableToggle');
    const timerInput = document.getElementById('reminderTimerMinutes');
    const backupInput = document.getElementById('reminderBackupHours');
    const status = document.getElementById('reminderStatus');
    const testBtn = document.getElementById('testReminderBtn');
    if (toggle && toggle.checked !== settings.enabled) {
      toggle.checked = settings.enabled;
    }
    if (timerInput && timerInput.value !== String(settings.staleTimerMinutes)) {
      timerInput.value = String(settings.staleTimerMinutes);
    }
    if (backupInput && backupInput.value !== String(settings.backupAgeHours)) {
      backupInput.value = String(settings.backupAgeHours);
    }
    const supported = 'Notification' in window;
    if (toggle) toggle.disabled = !supported;
    if (testBtn) testBtn.disabled = !supported;
    if (status) {
      status.textContent = supported
        ? `Notification permission: ${getNotificationPermissionLabel()}. Timer reminders after ${settings.staleTimerMinutes}m; backup reminders after ${settings.backupAgeHours}h.`
        : 'Browser notifications are not available in this browser.';
    }
  }

  async function setReminderEnabled(enabled) {
    const settings = ensureReminderSettings();
    if (
      enabled &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        settings.enabled = false;
        saveData();
        updateReminderSettingsPanel();
        showToast('Reminder permission was not granted.');
        return;
      }
    }
    if (
      enabled &&
      (!('Notification' in window) || Notification.permission === 'denied')
    ) {
      settings.enabled = false;
      saveData();
      updateReminderSettingsPanel();
      showToast('Browser reminders are unavailable.');
      return;
    }
    settings.enabled = enabled;
    saveData();
    updateReminderSettingsPanel();
    renderTodayCommandPanel();
  }

  function updateReminderNumberSetting(key, value) {
    const settings = ensureReminderSettings();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    settings[key] = parsed;
    data.reminderSettings = normalizeReminderSettings(settings);
    saveData();
    updateReminderSettingsPanel();
    renderTodayCommandPanel();
  }

  function maybeSendReminder(key, title, body) {
    const now = Date.now();
    if (lastReminderKey === key && now - lastReminderAt < 30 * 60 * 1000) {
      return;
    }
    if (showBrowserNotification(title, body)) {
      lastReminderKey = key;
      lastReminderAt = now;
    }
  }

  function checkReminderConditions() {
    const settings = ensureReminderSettings();
    if (
      !settings.enabled ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    ) {
      return;
    }
    const now = new Date();
    const staleTimer = getRunningEntries()
      .map((entry) => ({
        entry,
        minutes: (now - new Date(entry.startTime)) / 60000
      }))
      .filter((item) => Number.isFinite(item.minutes))
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (staleTimer && staleTimer.minutes >= settings.staleTimerMinutes) {
      const project = getEntryProject(staleTimer.entry);
      maybeSendReminder(
        `timer:${staleTimer.entry.id}`,
        'TimeKeeper timer review',
        `${project ? project.name : 'A timer'} has been running for ${Math.round(staleTimer.minutes)} minutes.`
      );
      return;
    }
    const backupTime = data.lastBackupVerifiedAt || data.lastBackupAt || '';
    const backupAgeHours = backupTime
      ? (now - new Date(backupTime)) / 3600000
      : Infinity;
    if (backupAgeHours >= settings.backupAgeHours) {
      maybeSendReminder(
        'backup',
        'TimeKeeper backup reminder',
        data.lastBackupAt
          ? `Last backup was ${formatRelativeTime(data.lastBackupAt)}.`
          : 'No backup has been recorded yet.'
      );
    }
  }

  function updatePwaStatusPanel() {
    const panel = document.getElementById('pwaStatusPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const items = [];
    items.push(
      'serviceWorker' in navigator
        ? `Offline app: ${offlineShellStatus}`
        : 'Offline app: unavailable'
    );
    items.push(
      pendingInstallPrompt ? 'Install: ready' : 'Install: browser managed'
    );
    if (
      pendingServiceWorkerRegistration &&
      pendingServiceWorkerRegistration.waiting
    ) {
      items.push('Update: ready');
    }
    items.forEach((text) => {
      const pill = document.createElement('span');
      pill.className = 'entry-summary-pill';
      pill.textContent = text;
      panel.appendChild(pill);
    });
    if (pendingInstallPrompt) {
      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = 'btn secondary';
      installBtn.textContent = 'Install App';
      installBtn.addEventListener('click', async () => {
        const promptEvent = pendingInstallPrompt;
        pendingInstallPrompt = null;
        updatePwaStatusPanel();
        promptEvent.prompt();
        await promptEvent.userChoice.catch(() => null);
      });
      panel.appendChild(installBtn);
    }
    if (
      pendingServiceWorkerRegistration &&
      pendingServiceWorkerRegistration.waiting
    ) {
      const updateBtn = document.createElement('button');
      updateBtn.type = 'button';
      updateBtn.className = 'btn primary';
      updateBtn.textContent = 'Update App';
      updateBtn.addEventListener('click', triggerServiceWorkerUpdate);
      panel.appendChild(updateBtn);
    }
    renderMobileSyncStatus();
  }

  const reminderEnableToggle = document.getElementById('reminderEnableToggle');
  if (reminderEnableToggle) {
    reminderEnableToggle.addEventListener('change', () => {
      setReminderEnabled(reminderEnableToggle.checked);
    });
  }
  const reminderTimerMinutes = document.getElementById('reminderTimerMinutes');
  if (reminderTimerMinutes) {
    reminderTimerMinutes.addEventListener('change', () => {
      updateReminderNumberSetting(
        'staleTimerMinutes',
        reminderTimerMinutes.value
      );
    });
  }
  const reminderBackupHours = document.getElementById('reminderBackupHours');
  if (reminderBackupHours) {
    reminderBackupHours.addEventListener('change', () => {
      updateReminderNumberSetting('backupAgeHours', reminderBackupHours.value);
    });
  }
  const testReminderBtn = document.getElementById('testReminderBtn');
  if (testReminderBtn) {
    testReminderBtn.addEventListener('click', async () => {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      showBrowserNotification(
        'TimeKeeper reminder test',
        'Browser reminders are ready.'
      );
      updateReminderSettingsPanel();
    });
  }
  updateReminderSettingsPanel();
  updatePwaStatusPanel();
  setInterval(checkReminderConditions, 60000);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pendingInstallPrompt = event;
    updatePwaStatusPanel();
  });

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
        const snapshot = cloneData();
        applyImportedData(imported);
        offerUndo('Data imported successfully.', snapshot);
      } catch (err) {
        showToast('Failed to import: ' + err.message);
      }
    });
  const stravaImportInput = document.getElementById('stravaImportInput');
  if (stravaImportInput) {
    stravaImportInput.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const lowerName = String(file.name || '').toLowerCase();
        const isCsv =
          lowerName.endsWith('.csv') ||
          file.type === 'text/csv' ||
          text.trimStart().toLowerCase().startsWith('activity id,');
        const payload = isCsv
          ? buildStravaPayloadFromCsv(text, {
              sourceName: file.name || 'activities.csv',
              existingActivities: cachedStravaActivities
            })
          : JSON.parse(text);
        const activities = Array.isArray(payload?.activities)
          ? payload.activities
          : null;
        if (!activities || activities.length === 0) {
          throw new Error(
            isCsv
              ? 'No activities found in the Strava CSV export.'
              : 'Expected a JSON file with an activities array.'
          );
        }
        const importedPayload = {
          ...payload,
          updated_utc: payload.updated_utc || new Date().toISOString(),
          source: payload.source || `browser-import:${file.name}`
        };
        saveCachedStravaFeedPayload(importedPayload);
        const updatedActivities = setActiveStravaActivities(activities);
        renderStravaActivities(updatedActivities);
        const status = document.getElementById('stravaFeedStatus');
        if (status) {
          status.textContent = `Imported ${activities.length} Strava activities from ${file.name}.`;
        }
        updateFitnessCards(true);
        updateTodoSection();
        updateAppHealthPanel();
        showToast('Strava activities imported.');
      } catch (error) {
        showToast(`Strava import failed: ${error.message}`);
      } finally {
        event.target.value = '';
      }
    });
  }
  const codexConfigBtn = document.getElementById('codexConfigBtn');
  const codexPublishConfigBtn = document.getElementById(
    'codexPublishConfigBtn'
  );
  const codexImportNowBtn = document.getElementById('codexImportNowBtn');
  if (codexConfigBtn) {
    codexConfigBtn.addEventListener('click', () => {
      editCodexIntegrationSettings();
    });
  }
  if (codexPublishConfigBtn) {
    codexPublishConfigBtn.addEventListener('click', () => {
      publishCodexIntegrationConfig();
    });
  }
  if (codexImportNowBtn) {
    codexImportNowBtn.addEventListener('click', () => {
      importCodexUsage();
    });
  }

  // Initial render
  primeStravaCacheFromBrowserStorage();
  updateProjectSelects();
  updateEntriesTable();
  updateProjectsPage();
  updateDashboard();
  updateTimerSection();
  updateCodexIntegrationPanel();
  scheduleCodexAutoImport();
  loadStravaFeed();
  if (
    'serviceWorker' in navigator &&
    window.location.protocol.startsWith('http')
  ) {
    offlineShellStatus = 'registering';
    updateAppHealthPanel();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadAfterServiceWorkerUpdate) {
        window.location.reload();
        return;
      }
      offlineShellStatus = 'active';
      offlineShellError = '';
      updateAppHealthPanel();
      updatePwaStatusPanel();
    });
    navigator.serviceWorker
      .register('./service-worker.js')
      .then((registration) => {
        pendingServiceWorkerRegistration = registration;
        if (registration.waiting) updatePwaStatusPanel();
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              pendingServiceWorkerRegistration = registration;
              updatePwaStatusPanel();
              showToast('App update available.', {
                actionLabel: 'Update',
                onAction: () => {
                  if (registration.waiting) {
                    reloadAfterServiceWorkerUpdate = true;
                    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                  }
                }
              });
            }
          });
        });
        return navigator.serviceWorker.ready;
      })
      .then((registration) => {
        pendingServiceWorkerRegistration = registration;
        offlineShellStatus = navigator.serviceWorker.controller
          ? 'active'
          : 'ready-after-reload';
        offlineShellError = '';
        updateAppHealthPanel();
        updatePwaStatusPanel();
      })
      .catch((error) => {
        offlineShellStatus = 'failed';
        offlineShellError = error && error.message ? error.message : '';
        console.warn('Service worker registration failed:', error);
        updateAppHealthPanel();
        updatePwaStatusPanel();
      });
  }
  function getSectionFromHash(hash = window.location.hash) {
    const route = String(hash || '')
      .replace(/^#/, '')
      .toLowerCase();
    const routes = {
      today: 'dashboard',
      dashboard: 'dashboard',
      timer: 'timer',
      entries: 'entries',
      'quick-log': 'entries',
      reports: 'analytics',
      analytics: 'analytics',
      sync: 'importExport',
      backup: 'importExport'
    };
    return routes[route] || '';
  }

  function applyLaunchRoute() {
    const launchHash = String(window.location.hash || '').toLowerCase();
    const sectionId = getSectionFromHash(launchHash) || defaultSectionId;
    showSection(sectionId, null, { resetScroll: false });
    if (launchHash === '#quick-log') {
      window.setTimeout(() => openMobileQuickLogSheet(), 0);
    }
  }

  applyLaunchRoute();
  window.addEventListener('hashchange', applyLaunchRoute);

  // Initialize auto sync toggle and status message
  const autoSyncToggle = document.getElementById('autoSyncToggle');
  const autoSyncStatusElem = document.getElementById('autoSyncStatus');
  const autoSyncWarningElem = document.getElementById('autoSyncWarning');
  const lastBackupStatusElem = document.getElementById('lastBackupStatus');
  const chooseBtn = document.getElementById('chooseBackupDirBtn');
  const backupNowBtn = document.getElementById('backupNowBtn');
  const verifyBackupBtn = document.getElementById('verifyBackupBtn');
  const mobileSyncSetupBtn = document.getElementById('mobileSyncSetupBtn');
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
    if (verifyBackupBtn) {
      verifyBackupBtn.disabled = !folderUsable;
      verifyBackupBtn.title = folderUsable
        ? 'Write latest backup data, then read back the latest file, manifest, and snapshot.'
        : 'Select a backup folder first.';
    }
    if (restoreBackupBtn) {
      restoreBackupBtn.disabled = !folderUsable;
      restoreBackupBtn.title = folderUsable
        ? 'Restore timekeeper-data.json from the selected backup folder.'
        : 'Select a backup folder first.';
    }
    if (backupConflict && folderUsable) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is paused - "${backupName}" has newer backup data.`
        : 'Auto sync is paused because the backup folder has newer data.';
    } else if (autoSyncEnabled && folderUsable) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is ON - syncing to "${backupName}".`
        : 'Auto sync is ON - syncing to your backup folder.';
    } else if (
      autoSyncEnabled &&
      hasHandle &&
      backupPermissionState !== 'granted'
    ) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is ON but access to "${backupName}" must be re-authorized.`
        : 'Auto sync is ON but access to the backup folder must be re-authorized.';
    } else if (autoSyncEnabled) {
      autoSyncStatusElem.textContent =
        'Auto sync is ON but no backup folder is available.';
    } else if (!autoSyncEnabled && folderUsable) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is OFF - backup folder "${backupName}" is ready.`
        : 'Auto sync is OFF - backup folder is ready.';
    } else if (!autoSyncEnabled && hasHandle) {
      autoSyncStatusElem.textContent = backupName
        ? `Auto sync is OFF - allow access to "${backupName}" to resume.`
        : 'Auto sync is OFF - allow access to the backup folder to resume.';
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
            ? `Grant TimeKeeper access to "${backupName}" to keep automatic backups running.`
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
          const verified = data.lastBackupVerifiedAt
            ? `, verified ${formatRelativeTime(data.lastBackupVerifiedAt)}`
            : '';
          lastBackupStatusElem.textContent = `Last backup: ${relative}${snapshot}${verified}`;
          lastBackupStatusElem.title = backupDate.toLocaleString();
          lastBackupStatusElem.style.display = 'block';
        } else {
          lastBackupStatusElem.textContent = '';
          lastBackupStatusElem.style.display = 'none';
        }
      } else if (autoSyncEnabled && folderUsable) {
        lastBackupStatusElem.textContent = 'Last backup: pending...';
        lastBackupStatusElem.title = '';
        lastBackupStatusElem.style.display = 'block';
      } else {
        lastBackupStatusElem.textContent = '';
        lastBackupStatusElem.style.display = 'none';
      }
    }
    const backupHealthPanel = document.getElementById('backupHealthPanel');
    if (backupHealthPanel) {
      backupHealthPanel.innerHTML = '';
      const updatedAt =
        data && data.updatedAt ? new Date(data.updatedAt) : null;
      const backupAt =
        data && data.lastBackupAt ? new Date(data.lastBackupAt) : null;
      const backupIsStale =
        needsBackup ||
        (updatedAt &&
          !Number.isNaN(updatedAt.getTime()) &&
          (!backupAt ||
            Number.isNaN(backupAt.getTime()) ||
            updatedAt.getTime() > backupAt.getTime()));
      const items = [
        ['Revision', String(Number(data.backupRevision) || 0)],
        [
          'Local change',
          data.updatedAt ? formatRelativeTime(data.updatedAt) : 'none recorded'
        ],
        [
          'Last backup',
          data.lastBackupAt ? formatRelativeTime(data.lastBackupAt) : 'never'
        ],
        [
          'Snapshot',
          data.lastBackupSnapshotAt
            ? formatRelativeTime(data.lastBackupSnapshotAt)
            : 'none'
        ],
        [
          'Verified',
          data.lastBackupVerifiedAt
            ? formatRelativeTime(data.lastBackupVerifiedAt)
            : 'never'
        ],
        [
          'Folder',
          backupName
            ? `${backupName} (${backupPermissionState})`
            : backupPermissionState
        ]
      ];
      items.forEach(([label, value]) => {
        const pill = document.createElement('span');
        pill.className = 'entry-summary-pill';
        pill.textContent = `${label}: ${value}`;
        backupHealthPanel.appendChild(pill);
      });
      if (backupIsStale || backupConflict) {
        const warning = document.createElement('span');
        warning.className = 'status-warning';
        warning.textContent = backupConflict
          ? 'Newer backup detected'
          : 'Unsynced local changes';
        backupHealthPanel.appendChild(warning);
      }
    }
    renderBackupSnapshotsPanel();
    updateAppHealthPanel();
    renderMobileSyncStatus();
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
            backupWarningMessage ||
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
    if (verifyBackupBtn) {
      verifyBackupBtn.disabled = true;
      verifyBackupBtn.title =
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
      const ok = await saveBackupToDir({ promptOnConflict: true });
      if (ok) showToast('Backup written successfully.');
    });
  }
  if (verifyBackupBtn) {
    verifyBackupBtn.addEventListener('click', () => {
      verifyBackupRoundTrip();
    });
  }
  if (mobileSyncSetupBtn) {
    mobileSyncSetupBtn.addEventListener('click', openMobileSyncWizard);
  }
  if (restoreBackupBtn) {
    restoreBackupBtn.addEventListener('click', () => {
      restoreLatestBackupFromDir();
    });
  }
})();
