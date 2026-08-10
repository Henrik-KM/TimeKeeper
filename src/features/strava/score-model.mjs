export const STRAVA_SCORE_MODEL_VERSION = 2;
export const STRAVA_SCORE_DEFAULT_SCALE = 1;

const MAX_SESSION_SCORE = 6;
const CARDIO_LOAD_SCALE = 70;
const CARDIO_ZONE_WEIGHTS = [0.2, 0.45, 0.9, 1.45, 2.1];
const RECOVERY_ZONE_WEIGHTS = [0.5, 1, 2, 3, 4];
const DEFAULT_MAX_HR = 190;

const STRENGTH_TYPES = new Set(['weighttraining']);
const HYBRID_TYPES = new Set([
  'crossfit',
  'highintensityintervaltraining',
  'hiit',
  'workout'
]);
const MOBILITY_TYPES = new Set(['pilates', 'yoga']);
const CARDIO_TYPES = new Set([
  'alpineski',
  'backcountryski',
  'badminton',
  'canoeing',
  'ebikeride',
  'elliptical',
  'golf',
  'gravelride',
  'handcycle',
  'hike',
  'iceskate',
  'inlineskate',
  'kayaking',
  'kitesurf',
  'mountainbikeride',
  'nordicski',
  'pickleball',
  'racquetball',
  'ride',
  'rockclimbing',
  'rollerski',
  'rowing',
  'run',
  'sail',
  'skateboard',
  'snowboard',
  'snowshoe',
  'soccer',
  'squash',
  'stairstepper',
  'standuppaddling',
  'surfing',
  'tabletennis',
  'tennis',
  'swim',
  'trailrun',
  'velomobile',
  'virtualride',
  'virtualrow',
  'virtualrun',
  'walk',
  'watersport',
  'wheelchair',
  'windsurf'
]);

export function clampScoreValue(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function normalizeCardioZoneMinutes(raw) {
  let values;
  if (Array.isArray(raw)) {
    values = raw.slice(0, 5);
  } else if (raw && typeof raw === 'object') {
    values = [raw.z1, raw.z2, raw.z3, raw.z4, raw.z5];
  } else {
    values = [];
  }
  while (values.length < 5) values.push(0);
  return values.map((value) => Math.max(0, Number(value) || 0));
}

function getHrReference(activity, rawFeatures = null) {
  const featureReference = toPositiveNumber(rawFeatures?.hr_max_reference);
  const activityReference = toPositiveNumber(activity?.hr_max_reference);
  const observedMax = toPositiveNumber(activity?.max_hr);
  const average = toPositiveNumber(activity?.avg_hr);
  return Math.max(
    DEFAULT_MAX_HR,
    featureReference || 0,
    activityReference || 0,
    observedMax || 0,
    average ? average / 0.98 : 0
  );
}

export function getStravaActivityModality(activity) {
  const type = normalizeType(activity?.sport_type || activity?.type);
  if (STRENGTH_TYPES.has(type)) return 'strength';
  if (HYBRID_TYPES.has(type)) return 'hybrid';
  if (MOBILITY_TYPES.has(type)) return 'mobility';
  if (CARDIO_TYPES.has(type)) return 'cardio';
  if (
    toPositiveNumber(activity?.distance_km) !== null ||
    toPositiveNumber(activity?.avg_speed_kmh) !== null
  ) {
    return 'cardio';
  }
  return 'strength';
}

export function getStravaActivityActiveMinutes(activity, modality) {
  const featureMinutes = toPositiveNumber(
    activity?.score_features?.active_minutes ??
      activity?.score_features?.effective_active_minutes
  );
  if (featureMinutes !== null) return Math.min(360, featureMinutes);

  const moving = toPositiveNumber(
    activity?.effective_active_minutes ?? activity?.moving_time_min
  );
  const elapsed = toPositiveNumber(activity?.elapsed_time_min);
  if (modality === 'cardio') {
    if (moving !== null) return Math.min(360, moving);
    return elapsed !== null ? Math.min(360, elapsed) : 0;
  }
  if (elapsed !== null) {
    if (moving === null || moving < 5) return Math.min(360, elapsed);
    return Math.min(
      360,
      elapsed,
      Math.max(moving + 30, moving * 1.5, 15)
    );
  }
  return moving !== null ? Math.min(360, moving) : 0;
}

function getAverageHrZone(activity, hrReference) {
  const average = toPositiveNumber(activity?.avg_hr);
  if (average === null || !Number.isFinite(hrReference) || hrReference <= 0) {
    return 1;
  }
  const ratio = average / hrReference;
  if (ratio < 0.6) return 0;
  if (ratio < 0.7) return 1;
  if (ratio < 0.8) return 2;
  if (ratio < 0.9) return 3;
  return 4;
}

function buildSummaryFeatures(activity) {
  const modality = getStravaActivityModality(activity);
  const activeMinutes = getStravaActivityActiveMinutes(activity, modality);
  const hrReference = getHrReference(activity);
  const cardioZoneMinutes = [0, 0, 0, 0, 0];
  let strengthMinutes = 0;
  let strengthDensity = 0;
  let strengthFactor = 1;

  if (modality === 'cardio') {
    cardioZoneMinutes[getAverageHrZone(activity, hrReference)] = activeMinutes;
  } else if (modality === 'hybrid') {
    strengthMinutes = activeMinutes * 0.75;
    cardioZoneMinutes[getAverageHrZone(activity, hrReference)] =
      activeMinutes * 0.25;
    strengthDensity = 0.25;
  } else {
    strengthMinutes = activeMinutes;
    strengthDensity = modality === 'mobility' ? 0.2 : 0;
    strengthFactor = modality === 'mobility' ? 0.65 : 1;
  }

  return {
    version: STRAVA_SCORE_MODEL_VERSION,
    source: 'summary',
    active_minutes: activeMinutes,
    strength_minutes: strengthMinutes,
    cardio_zone_minutes: cardioZoneMinutes,
    strength_density: strengthDensity,
    strength_factor: strengthFactor,
    work_recovery_cycles: 0,
    hr_max_reference: hrReference
  };
}

function normalizeScoreFeatures(activity, rawFeatures) {
  const fallback = buildSummaryFeatures(activity);
  const activeMinutes = Math.max(
    0,
    Number(
      rawFeatures?.active_minutes ??
        rawFeatures?.effective_active_minutes ??
        fallback.active_minutes
    ) || 0
  );
  let strengthMinutes = Math.max(
    0,
    Number(rawFeatures?.strength_minutes ?? fallback.strength_minutes) || 0
  );
  const cardioZoneMinutes = normalizeCardioZoneMinutes(
    rawFeatures?.cardio_zone_minutes ?? fallback.cardio_zone_minutes
  );
  let cardioMinutes = cardioZoneMinutes.reduce((sum, value) => sum + value, 0);
  const componentMinutes = strengthMinutes + cardioMinutes;

  if (activeMinutes > 0 && componentMinutes > activeMinutes * 1.05) {
    const scale = activeMinutes / componentMinutes;
    strengthMinutes *= scale;
    cardioZoneMinutes.forEach((value, index) => {
      cardioZoneMinutes[index] = value * scale;
    });
    cardioMinutes *= scale;
  }

  return {
    version: STRAVA_SCORE_MODEL_VERSION,
    source: String(rawFeatures?.source || fallback.source),
    active_minutes:
      activeMinutes > 0 ? activeMinutes : strengthMinutes + cardioMinutes,
    strength_minutes: strengthMinutes,
    cardio_zone_minutes: cardioZoneMinutes,
    strength_density: clampScoreValue(
      rawFeatures?.strength_density ?? fallback.strength_density,
      0,
      1
    ),
    strength_factor: clampScoreValue(
      rawFeatures?.strength_factor ?? fallback.strength_factor,
      0.5,
      1.1
    ),
    work_recovery_cycles: Math.max(
      0,
      Number(
        rawFeatures?.work_recovery_cycles ?? fallback.work_recovery_cycles
      ) || 0
    ),
    hr_max_reference: getHrReference(activity, rawFeatures)
  };
}

export function getStravaScoreFeatures(activity) {
  const rawFeatures = activity?.score_features;
  if (
    rawFeatures &&
    typeof rawFeatures === 'object' &&
    Number(rawFeatures.version) >= STRAVA_SCORE_MODEL_VERSION
  ) {
    return normalizeScoreFeatures(activity, rawFeatures);
  }
  return buildSummaryFeatures(activity);
}

export function computeStrengthCredit(features) {
  const minutes = Math.max(0, Number(features?.strength_minutes) || 0);
  if (minutes <= 5) return 0;
  const density = clampScoreValue(features?.strength_density, 0, 1);
  const factor = clampScoreValue(features?.strength_factor ?? 1, 0.5, 1.1);
  const base =
    MAX_SESSION_SCORE * (1 - Math.exp(-Math.max(0, minutes - 5) / 45));
  const durationQuality = 0.1 * clampScoreValue((minutes - 60) / 45, 0, 1);
  const multiplier = 0.9 + 0.2 * density + durationQuality;
  return clampScoreValue(base * multiplier * factor, 0, MAX_SESSION_SCORE);
}

export function computeCardioCredit(features) {
  const zoneMinutes = normalizeCardioZoneMinutes(
    features?.cardio_zone_minutes
  );
  const load = zoneMinutes.reduce(
    (sum, minutes, index) => sum + minutes * CARDIO_ZONE_WEIGHTS[index],
    0
  );
  if (load <= 0) return 0;
  const score = MAX_SESSION_SCORE * (1 - Math.exp(-load / CARDIO_LOAD_SCALE));
  return clampScoreValue(score, 0, MAX_SESSION_SCORE);
}

export function computeStravaRecoveryLoad(features) {
  return normalizeCardioZoneMinutes(features?.cardio_zone_minutes).reduce(
    (sum, minutes, index) => sum + minutes * RECOVERY_ZONE_WEIGHTS[index],
    0
  );
}

export function combineWorkoutComponents(strengthCredit, cardioCredit) {
  const strength = clampScoreValue(strengthCredit, 0, MAX_SESSION_SCORE);
  const cardio = clampScoreValue(cardioCredit, 0, MAX_SESSION_SCORE);
  const primary = Math.max(strength, cardio);
  const secondary = Math.min(strength, cardio);
  return clampScoreValue(
    primary + Math.min(1, 0.25 * secondary),
    0,
    MAX_SESSION_SCORE
  );
}

export function getStravaWorkoutScoreBreakdown(activity) {
  const features = getStravaScoreFeatures(activity);
  const strength = computeStrengthCredit(features);
  const cardio = computeCardioCredit(features);
  return {
    version: STRAVA_SCORE_MODEL_VERSION,
    modality: getStravaActivityModality(activity),
    strength,
    cardio,
    total: combineWorkoutComponents(strength, cardio),
    recoveryLoad: computeStravaRecoveryLoad(features),
    features
  };
}
