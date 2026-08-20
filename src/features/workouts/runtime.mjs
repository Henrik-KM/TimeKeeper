import {
  clampUnitInterval,
  parseLocalDateString
} from '../../shared/runtime-helpers.mjs';
import { uuid } from '../../shared/id.mjs';

export const FITNESS_MODES = {
  gentle: { label: 'Gentle (6% / 4%)', alpha: 0.06, beta: 0.04 },
  normal: { label: 'Normal (8% / 6%)', alpha: 0.08, beta: 0.06 },
  strict: { label: 'Strict (10% / 8%)', alpha: 0.1, beta: 0.08 }
};

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function clampMultiplier(value) {
  const val = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(1.2, Math.max(0.9, val));
}

export function getWeekStart(date) {
  const current = new Date(date);
  const dayOfWeek = current.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() - diffToMonday
  );
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function formatDateKey(date) {
  if (!isValidDate(date)) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getWeekKey(date) {
  return formatDateKey(getWeekStart(date));
}

export function formatPoints(value, decimals = 1) {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(decimals);
}

export function parseISODateOnly(str) {
  if (typeof str !== 'string' || !str) return null;
  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  const result = new Date(year, month - 1, day);
  result.setHours(0, 0, 0, 0);
  return isValidDate(result) ? result : null;
}

export function normalizeWeekKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const parsed = parseISODateOnly(key);
  if (!parsed) return null;
  if (parsed.getDay() !== 1) {
    const adjust = (8 - parsed.getDay()) % 7;
    parsed.setDate(parsed.getDate() + adjust);
  }
  parsed.setHours(0, 0, 0, 0);
  return formatDateKey(parsed);
}

export function weekKeyToDate(key) {
  const normalized = normalizeWeekKey(key);
  return normalized ? parseISODateOnly(normalized) : null;
}

export function sanitizeCustomPoints(value) {
  const num = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100) / 100;
}

export function formatCustomIntensityValue(value) {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function makeCustomIntensity(points) {
  const sanitized = sanitizeCustomPoints(points);
  if (sanitized === null) return 'medium';
  return `custom:${formatCustomIntensityValue(sanitized)}`;
}

export function parseCustomIntensity(intensity) {
  if (typeof intensity !== 'string') return null;
  const match = intensity.trim().match(/^custom:\s*([-+]?\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const parsed = sanitizeCustomPoints(Number.parseFloat(match[1]));
  return parsed === null ? null : parsed;
}

export function isCustomIntensity(intensity) {
  return parseCustomIntensity(intensity) !== null;
}

export function normalizeIntensity(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'intense' || lower === 'medium' || lower === 'light') {
      return lower;
    }
    const customFromTag = parseCustomIntensity(trimmed);
    if (customFromTag !== null) return makeCustomIntensity(customFromTag);
    const numeric = sanitizeCustomPoints(trimmed);
    if (numeric !== null) return makeCustomIntensity(numeric);
  } else if (typeof value === 'number') {
    const numeric = sanitizeCustomPoints(value);
    if (numeric !== null) return makeCustomIntensity(numeric);
  } else if (value && typeof value === 'object') {
    if (Number.isFinite(value.points)) {
      const numeric = sanitizeCustomPoints(value.points);
      if (numeric !== null) return makeCustomIntensity(numeric);
    }
    if (value.intensity !== undefined) {
      return normalizeIntensity(value.intensity);
    }
  }
  return 'medium';
}

export function formatWorkoutTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!isValidDate(date)) return '';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatTimestampForInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!isValidDate(date)) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

export function parseDateTimeInput(value) {
  if (!value) return null;
  let normalized = value.trim();
  if (!normalized) return null;
  if (!normalized.includes('T') && normalized.includes(' ')) {
    normalized = normalized.replace(' ', 'T');
  }
  const date = new Date(normalized);
  return isValidDate(date) ? date : null;
}

export function makeDefaultFitness() {
  const pointSettings = {
    intense: 6,
    medium: 4,
    light: 2,
    weeklyTarget: 18,
    multiplierPerPoint: 0.015,
    creditsPerPoint: 40
  };
  const planStart = getWeekStart(new Date());
  const planEndExclusive = new Date(planStart);
  planEndExclusive.setDate(planEndExclusive.getDate() + 7 * 52);
  const planEndInclusive = new Date(planEndExclusive);
  planEndInclusive.setDate(planEndInclusive.getDate() - 1);
  return {
    mode: 'normal',
    alpha: FITNESS_MODES.normal.alpha,
    beta: FITNESS_MODES.normal.beta,
    currentMultiplier: 1,
    nextMultiplier: 1,
    lastProcessedMonday: null,
    wellnessCredits: 0,
    creditsCap: 1000,
    creditSettings: {
      base: 50,
      extra: 25,
      penalty: 40,
      weeklyBonus: 50,
      streakBonus: 100
    },
    streakCount: 0,
    pausedWeeks: {},
    weekendBoostEnabled: true,
    weekendBoostPercent: 0.1,
    weekendBoostUnlockedWeek: null,
    lastWeekSummary: null,
    pointSpillover: 0,
    pointPlan: {
      startDate: formatDateKey(planStart),
      endDate: formatDateKey(planEndInclusive),
      totalPoints: pointSettings.weeklyTarget * 52
    },
    pointSettings
  };
}

export function applyFitnessDefaults(obj) {
  const defaults = makeDefaultFitness();
  if (!obj || typeof obj !== 'object') return defaults;
  const merged = Object.assign({}, defaults, obj);
  merged.creditSettings = Object.assign(
    {},
    defaults.creditSettings,
    obj.creditSettings || {}
  );
  merged.pausedWeeks = Object.assign(
    {},
    defaults.pausedWeeks,
    obj.pausedWeeks || {}
  );
  merged.pointPlan = Object.assign({}, defaults.pointPlan, obj.pointPlan || {});
  merged.pointSettings = Object.assign(
    {},
    defaults.pointSettings,
    obj.pointSettings || {}
  );
  if (typeof merged.alpha !== 'number' || !Number.isFinite(merged.alpha)) {
    merged.alpha = defaults.alpha;
  }
  if (typeof merged.beta !== 'number' || !Number.isFinite(merged.beta)) {
    merged.beta = defaults.beta;
  }
  if (
    typeof merged.currentMultiplier !== 'number' ||
    !Number.isFinite(merged.currentMultiplier)
  ) {
    merged.currentMultiplier = defaults.currentMultiplier;
  }
  if (
    typeof merged.nextMultiplier !== 'number' ||
    !Number.isFinite(merged.nextMultiplier)
  ) {
    merged.nextMultiplier = defaults.nextMultiplier;
  }
  if (
    typeof merged.creditsCap !== 'number' ||
    !Number.isFinite(merged.creditsCap)
  ) {
    merged.creditsCap = defaults.creditsCap;
  }
  if (
    typeof merged.wellnessCredits !== 'number' ||
    !Number.isFinite(merged.wellnessCredits)
  ) {
    merged.wellnessCredits = defaults.wellnessCredits;
  }
  if (
    typeof merged.weekendBoostPercent !== 'number' ||
    !Number.isFinite(merged.weekendBoostPercent)
  ) {
    merged.weekendBoostPercent = defaults.weekendBoostPercent;
  }
  if (
    typeof merged.streakCount !== 'number' ||
    !Number.isFinite(merged.streakCount)
  ) {
    merged.streakCount = defaults.streakCount;
  }
  return merged;
}

export function makeDefaultWorkouts() {
  return {
    presets: [],
    entries: []
  };
}

export function applyWorkoutDefaults(obj) {
  const defaults = makeDefaultWorkouts();
  if (!obj || typeof obj !== 'object') return defaults;
  const merged = Object.assign({}, defaults, obj);
  if (!Array.isArray(merged.presets)) merged.presets = [];
  if (!Array.isArray(merged.entries)) merged.entries = [];
  merged.presets = merged.presets.map((preset) => ({
    id: preset && preset.id ? preset.id : uuid(),
    name: preset && typeof preset.name === 'string' ? preset.name : '',
    intensity:
      preset && typeof preset.intensity === 'string'
        ? preset.intensity
        : 'medium'
  }));
  merged.entries = merged.entries.map((entry) => ({
    id: entry && entry.id ? entry.id : uuid(),
    name: entry && typeof entry.name === 'string' ? entry.name : '',
    intensity:
      entry && typeof entry.intensity === 'string' ? entry.intensity : 'medium',
    timestamp:
      entry && entry.timestamp ? entry.timestamp : new Date().toISOString(),
    presetId: entry && entry.presetId ? entry.presetId : null
  }));
  return merged;
}

export function createWorkoutRuntime({
  ensureFitnessDefaults,
  ensureWorkoutData,
  isWeekPaused,
  processWorkoutWeekIfNeeded,
  applyStravaExertionOverrides,
  resolveStravaExertion,
  getStravaActivities = () => []
}) {
  function getIntensityPoints(intensity) {
    const normalized = normalizeIntensity(intensity);
    const customPoints = parseCustomIntensity(normalized);
    if (customPoints !== null) return customPoints;
    const fitness = ensureFitnessDefaults();
    const settings = fitness.pointSettings || {};
    const intensePoints = Number(settings.intense);
    const mediumPoints = Number(settings.medium);
    const lightPoints = Number(settings.light);
    const map = {
      intense: Number.isFinite(intensePoints) ? intensePoints : 0,
      medium: Number.isFinite(mediumPoints) ? mediumPoints : 0,
      light: Number.isFinite(lightPoints) ? lightPoints : 0
    };
    if (!Number.isFinite(map.medium)) map.medium = 0;
    return Object.prototype.hasOwnProperty.call(map, normalized)
      ? map[normalized]
      : map.medium;
  }

  function getIntensityLabel(intensity) {
    if (
      typeof intensity === 'string' &&
      intensity.trim().toLowerCase() === 'custom'
    ) {
      return 'Custom';
    }
    const normalized = normalizeIntensity(intensity);
    if (isCustomIntensity(normalized)) return 'Custom';
    switch (normalized) {
      case 'intense':
        return 'Intense';
      case 'light':
        return 'Light';
      default:
        return 'Medium';
    }
  }

  function getIntensitySummary(intensity) {
    const normalized = normalizeIntensity(intensity);
    const points = getIntensityPoints(normalized);
    const customPoints = parseCustomIntensity(normalized);
    const formattedPoints =
      customPoints !== null
        ? formatCustomIntensityValue(customPoints)
        : formatPoints(points);
    return `${getIntensityLabel(normalized)} (${formattedPoints} pts)`;
  }

  function getIntensityPromptDefault(intensity) {
    const normalized = normalizeIntensity(intensity);
    const customPoints = parseCustomIntensity(normalized);
    if (customPoints !== null) {
      return formatCustomIntensityValue(customPoints);
    }
    return normalized;
  }

  function getWorkoutPointPlan(fitness = ensureFitnessDefaults()) {
    const defaults = makeDefaultFitness().pointPlan;
    const raw =
      fitness && typeof fitness.pointPlan === 'object'
        ? fitness.pointPlan
        : { startDate: '', endDate: '', totalPoints: 0 };
    let start =
      parseLocalDateString(
        typeof raw.startDate === 'string' ? raw.startDate : ''
      ) ||
      parseLocalDateString(
        typeof defaults.startDate === 'string' ? defaults.startDate : ''
      );
    if (!start) {
      start = getWeekStart(new Date());
    }
    start.setHours(0, 0, 0, 0);
    let endInclusive =
      parseLocalDateString(
        typeof raw.endDate === 'string' ? raw.endDate : ''
      ) ||
      parseLocalDateString(
        typeof defaults.endDate === 'string' ? defaults.endDate : ''
      );
    if (!endInclusive || endInclusive < start) {
      const fallbackEndExclusive = new Date(start);
      fallbackEndExclusive.setDate(fallbackEndExclusive.getDate() + 7 * 52);
      endInclusive = new Date(fallbackEndExclusive);
      endInclusive.setDate(endInclusive.getDate() - 1);
    }
    endInclusive.setHours(0, 0, 0, 0);
    const endExclusive = new Date(endInclusive);
    endExclusive.setDate(endExclusive.getDate() + 1);
    let totalPoints = Number(raw.totalPoints);
    const defaultTotal = Number(defaults.totalPoints);
    if (!Number.isFinite(totalPoints) || totalPoints <= 0) {
      totalPoints =
        Number.isFinite(defaultTotal) && defaultTotal > 0 ? defaultTotal : 0;
    }
    return { start, endInclusive, endExclusive, totalPoints };
  }

  function computeWorkoutPlanExpectedTotal(plan, at) {
    if (!plan || !Number.isFinite(plan.totalPoints) || plan.totalPoints <= 0) {
      return 0;
    }
    const startMs = isValidDate(plan.start) ? plan.start.getTime() : NaN;
    const endMs = isValidDate(plan.endExclusive)
      ? plan.endExclusive.getTime()
      : NaN;
    const atMs = at instanceof Date ? at.getTime() : Number(at);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs ||
      !Number.isFinite(atMs)
    ) {
      return 0;
    }
    const progress = clampUnitInterval((atMs - startMs) / (endMs - startMs));
    return plan.totalPoints * progress;
  }

  function computeWorkoutPlanExpectedSlice(plan, start, end) {
    return (
      computeWorkoutPlanExpectedTotal(plan, end) -
      computeWorkoutPlanExpectedTotal(plan, start)
    );
  }

  function computeWorkoutPlanActualTotal(plan, at) {
    if (!plan || !isValidDate(plan.start)) return 0;
    const atDate = at instanceof Date ? at : new Date(at);
    if (!isValidDate(atDate)) return 0;
    const end =
      isValidDate(plan.endExclusive) && atDate > plan.endExclusive
        ? plan.endExclusive
        : atDate;
    if (end <= plan.start) return 0;
    const stats = collectWorkoutPoints({ start: plan.start, end });
    return Number.isFinite(stats.totalPoints) ? stats.totalPoints : 0;
  }

  function computeWorkoutPlanRequiredSlice(
    plan,
    start,
    end,
    actualBeforeStart = null
  ) {
    if (!plan || !Number.isFinite(plan.totalPoints) || plan.totalPoints <= 0) {
      return 0;
    }
    if (!isValidDate(start) || !isValidDate(end)) return 0;
    const sliceStart = start < plan.start ? plan.start : start;
    const sliceEnd = end > plan.endExclusive ? plan.endExclusive : end;
    if (sliceEnd <= sliceStart) return 0;
    const remainingMs = plan.endExclusive.getTime() - sliceStart.getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
    const actualBefore = Number.isFinite(actualBeforeStart)
      ? actualBeforeStart
      : computeWorkoutPlanActualTotal(plan, sliceStart);
    const remainingPoints = Math.max(0, plan.totalPoints - actualBefore);
    const sliceMs = sliceEnd.getTime() - sliceStart.getTime();
    const required = remainingPoints * (sliceMs / remainingMs);
    return Number.isFinite(required) && required > 0 ? required : 0;
  }

  function collectWorkoutPoints(options = {}) {
    const workouts = ensureWorkoutData();
    const start = options.start
      ? new Date(options.start)
      : getWeekStart(new Date());
    if (!isValidDate(start)) {
      throw new Error('Invalid start date for workout stats');
    }
    const end = options.end
      ? new Date(options.end)
      : (() => {
          const next = new Date(start);
          next.setDate(next.getDate() + 7);
          return next;
        })();
    const startMs = start.getTime();
    const endMs = isValidDate(end) ? end.getTime() : Number.POSITIVE_INFINITY;
    const includeEntries = !!options.includeEntries;
    const collected = includeEntries ? [] : undefined;
    const counts = { intense: 0, medium: 0, light: 0, custom: 0, strava: 0 };
    const pointsByIntensity = {
      intense: 0,
      medium: 0,
      light: 0,
      custom: 0,
      strava: 0
    };
    let totalPoints = 0;
    workouts.entries.forEach((entry) => {
      if (!entry || !entry.timestamp) return;
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) return;
      const normalizedIntensity = normalizeIntensity(entry.intensity);
      const points = getIntensityPoints(normalizedIntensity);
      const bucket =
        parseCustomIntensity(normalizedIntensity) !== null
          ? 'custom'
          : normalizedIntensity;
      totalPoints += points;
      if (!Object.prototype.hasOwnProperty.call(counts, bucket))
        counts[bucket] = 0;
      if (!Object.prototype.hasOwnProperty.call(pointsByIntensity, bucket)) {
        pointsByIntensity[bucket] = 0;
      }
      counts[bucket] += 1;
      pointsByIntensity[bucket] += points;
      if (includeEntries) {
        collected.push(
          Object.assign({}, entry, { timestamp: new Date(ts).toISOString() })
        );
      }
    });
    const activities = applyStravaExertionOverrides(getStravaActivities());
    activities.forEach((activity) => {
      if (!activity || !activity.start_date) return;
      const ts = Date.parse(activity.start_date);
      if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) return;
      const exertion = resolveStravaExertion(activity);
      if (exertion === null) return;
      totalPoints += exertion;
      counts.strava += 1;
      pointsByIntensity.strava += exertion;
    });
    if (includeEntries) {
      collected.sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      );
    }
    return {
      entries: includeEntries ? collected : [],
      start,
      end,
      totalPoints,
      counts,
      pointsByIntensity
    };
  }

  function computeWorkoutWeekPlan(options = {}) {
    processWorkoutWeekIfNeeded();
    const now = options.now instanceof Date ? options.now : new Date();
    const weekStart =
      options.weekStart instanceof Date
        ? new Date(options.weekStart)
        : getWeekStart(now);
    const weekEnd =
      options.weekEnd instanceof Date
        ? new Date(options.weekEnd)
        : (() => {
            const end = new Date(weekStart);
            end.setDate(end.getDate() + 7);
            return end;
          })();
    const fitness = options.fitness || ensureFitnessDefaults();
    const plan = getWorkoutPointPlan(fitness);
    const boundedStart = weekStart < plan.start ? plan.start : weekStart;
    const boundedEnd =
      weekEnd > plan.endExclusive ? plan.endExclusive : weekEnd;
    const weekKey = getWeekKey(weekStart);
    const paused = isWeekPaused(weekKey);
    let actualPoints;
    if (Number.isFinite(options.actualPoints)) {
      actualPoints = options.actualPoints;
    } else if (
      options.pointsInfo &&
      Number.isFinite(options.pointsInfo.totalPoints)
    ) {
      actualPoints = options.pointsInfo.totalPoints;
    } else {
      actualPoints = collectWorkoutPoints({
        start: weekStart,
        end: weekEnd
      }).totalPoints;
    }
    if (
      boundedStart.getTime() !== weekStart.getTime() ||
      boundedEnd.getTime() !== weekEnd.getTime()
    ) {
      actualPoints =
        boundedEnd > boundedStart
          ? collectWorkoutPoints({ start: boundedStart, end: boundedEnd })
              .totalPoints
          : 0;
    }
    const expectedWeekPoints = computeWorkoutPlanExpectedSlice(
      plan,
      weekStart,
      weekEnd
    );
    const actualBeforeWeek = computeWorkoutPlanActualTotal(plan, boundedStart);
    const requiredPoints = paused
      ? 0
      : computeWorkoutPlanRequiredSlice(
          plan,
          boundedStart,
          boundedEnd,
          actualBeforeWeek
        );
    const totalMs = weekEnd.getTime() - weekStart.getTime();
    let timeProgress =
      totalMs > 0 ? ((now.getTime() - weekStart.getTime()) / totalMs) * 100 : 0;
    if (timeProgress < 0) timeProgress = 0;
    if (timeProgress > 100) timeProgress = 100;
    const expectedPoints = requiredPoints * (timeProgress / 100);
    const baselineExpectedPoints = paused
      ? 0
      : expectedWeekPoints * (timeProgress / 100);
    const progressPercent =
      requiredPoints > 0
        ? (actualPoints / requiredPoints) * 100
        : actualPoints > 0
          ? 100
          : 0;
    const scheduleDelta = actualPoints - expectedPoints;
    const baselineDelta = actualPoints - baselineExpectedPoints;
    const planExpectedPoints = computeWorkoutPlanExpectedTotal(plan, now);
    const planActualPoints = computeWorkoutPlanActualTotal(plan, now);
    const planTimeProgress = (() => {
      const startMs = plan.start.getTime();
      const endMs = plan.endExclusive.getTime();
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs
      ) {
        return 0;
      }
      return (
        clampUnitInterval((now.getTime() - startMs) / (endMs - startMs)) * 100
      );
    })();
    const planProgressPercent =
      plan.totalPoints > 0 ? (planActualPoints / plan.totalPoints) * 100 : 0;
    const planScheduleDelta = planActualPoints - planExpectedPoints;
    return {
      requiredPoints,
      actualPoints,
      progressPercent,
      timeProgress,
      expectedPoints,
      scheduleDelta,
      paused,
      expectedWeekPoints,
      baselineExpectedPoints,
      baselineDelta,
      actualBeforeWeek,
      planStart: plan.start,
      planEndInclusive: plan.endInclusive,
      planTotalPoints: plan.totalPoints,
      planActualPoints,
      planExpectedPoints,
      planScheduleDelta,
      planTimeProgress,
      planProgressPercent
    };
  }

  function migrateLegacyTodosToWorkouts(todos) {
    const workouts = makeDefaultWorkouts();
    if (!Array.isArray(todos)) return workouts;
    todos.forEach((todo) => {
      if (!todo || typeof todo.name !== 'string') return;
      const name = todo.name;
      const intensity = 'medium';
      let preset = workouts.presets.find(
        (current) => current.name === name && current.intensity === intensity
      );
      if (!preset) {
        preset = { id: uuid(), name, intensity };
        workouts.presets.push(preset);
      }
      if (Array.isArray(todo.logs)) {
        todo.logs.forEach((log) => {
          const date = new Date(log);
          if (!isValidDate(date)) return;
          workouts.entries.push({
            id: uuid(),
            name,
            intensity,
            timestamp: date.toISOString(),
            presetId: preset.id
          });
        });
      }
    });
    return workouts;
  }

  return {
    getIntensityPoints,
    getIntensityLabel,
    getIntensitySummary,
    getIntensityPromptDefault,
    getWorkoutPointPlan,
    computeWorkoutPlanExpectedTotal,
    computeWorkoutPlanExpectedSlice,
    computeWorkoutPlanRequiredSlice,
    computeWorkoutPlanActualTotal,
    collectWorkoutPoints,
    computeWorkoutWeekPlan,
    migrateLegacyTodosToWorkouts
  };
}
