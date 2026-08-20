const STRAVA_SCORE_BASELINE_HR = 250;
const STRAVA_SCORE_BASE_HR = 70;
export const STRAVA_SCORE_DEFAULT_SCALE = 12;
const STRAVA_SCORE_SCALE_MIN = 0.5;
const STRAVA_SCORE_SCALE_MAX = 30;
const STRAVA_SCORE_INTENSITY_EXP = 1.6;
const STRAVA_SCORE_DURATION_EXP = 0.9;
const STRAVA_SCORE_SPIKE_WEIGHT = 0.6;

export function parseExertionValue(rawValue) {
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(0, value);
  return Math.round(clamped * 10) / 10;
}

export function formatExertion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const rounded = Math.round(numeric * 10) / 10;
  return rounded % 1 === 0
    ? String(rounded.toFixed(0))
    : String(rounded.toFixed(1));
}

export function isStravaActivityFaulty(activity) {
  if (!activity || typeof activity !== 'object') return false;
  if (activity.local_faulty === true) return true;
  return activity.faulty === true;
}

export function computeStravaRawScore(activity) {
  const avgHr = Number(activity?.avg_hr);
  let maxHr = Number(activity?.max_hr);
  const elapsed = Number(activity?.elapsed_time_min);
  if (!Number.isFinite(avgHr) || !Number.isFinite(elapsed)) return null;
  if (avgHr <= 0 || elapsed <= 0) return null;
  if (!Number.isFinite(maxHr) || maxHr <= 0) {
    maxHr = avgHr;
  }
  const denom = STRAVA_SCORE_BASELINE_HR - STRAVA_SCORE_BASE_HR;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  const avgAdj = avgHr - STRAVA_SCORE_BASE_HR;
  let maxAdj = maxHr - STRAVA_SCORE_BASE_HR;
  if (!Number.isFinite(avgAdj) || avgAdj <= 0) return null;
  if (!Number.isFinite(maxAdj) || maxAdj <= 0) {
    maxAdj = avgAdj;
  }
  const intensity = avgAdj / denom;
  const durationHours = elapsed / 60;
  const spike = Math.max(0, Math.min(1, (maxAdj - avgAdj) / denom));
  const quality = Math.pow(intensity, STRAVA_SCORE_INTENSITY_EXP);
  const duration = Math.pow(durationHours, STRAVA_SCORE_DURATION_EXP);
  const spikeFactor = 1 + STRAVA_SCORE_SPIKE_WEIGHT * spike;
  const raw = quality * duration * spikeFactor;
  return raw > 0 ? raw : null;
}

export function getMeasuredStravaScore(activity) {
  if (!activity) return null;
  const override =
    activity.local_exertion !== undefined
      ? activity.local_exertion
      : activity.exertion;
  const resolvedOverride = parseExertionValue(override);
  if (resolvedOverride !== null) return resolvedOverride;
  return parseExertionValue(activity.reported_exertion);
}

export function computeStravaScoreScale(activities) {
  if (!Array.isArray(activities)) {
    return { scale: STRAVA_SCORE_DEFAULT_SCALE, samples: 0 };
  }
  let numerator = 0;
  let denominator = 0;
  let samples = 0;
  activities.forEach((activity) => {
    if (isStravaActivityFaulty(activity)) return;
    const measured = getMeasuredStravaScore(activity);
    if (measured === null) return;
    const raw = computeStravaRawScore(activity);
    if (!Number.isFinite(raw) || raw <= 0) return;
    numerator += raw * measured;
    denominator += raw * raw;
    samples += 1;
  });
  if (samples === 0 || denominator <= 0) {
    return { scale: STRAVA_SCORE_DEFAULT_SCALE, samples: 0 };
  }
  let scale = numerator / denominator;
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = STRAVA_SCORE_DEFAULT_SCALE;
  }
  scale = Math.max(
    STRAVA_SCORE_SCALE_MIN,
    Math.min(STRAVA_SCORE_SCALE_MAX, scale)
  );
  return { scale, samples };
}

export function estimateStravaExertion(
  activity,
  scale = STRAVA_SCORE_DEFAULT_SCALE
) {
  const raw = computeStravaRawScore(activity);
  if (raw === null) return null;
  const effectiveScale = Number.isFinite(scale)
    ? scale
    : STRAVA_SCORE_DEFAULT_SCALE;
  const score = raw * effectiveScale;
  const clamped = Math.max(0, score);
  return Math.round(clamped * 10) / 10;
}

export function resolveStravaExertion(
  activity,
  scale = STRAVA_SCORE_DEFAULT_SCALE
) {
  if (!activity) return null;
  const override =
    activity.local_exertion !== undefined
      ? activity.local_exertion
      : activity.exertion;
  let resolved = parseExertionValue(override);
  if (resolved !== null) return resolved;
  resolved = parseExertionValue(activity.reported_exertion);
  if (resolved !== null) return resolved;
  const estimated = estimateStravaExertion(activity, scale);
  const fallback =
    estimated !== null && estimated !== undefined
      ? estimated
      : activity.estimated_exertion;
  return parseExertionValue(fallback);
}
