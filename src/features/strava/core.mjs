import {
  STRAVA_SCORE_DEFAULT_SCALE,
  STRAVA_SCORE_MODEL_VERSION,
  combineWorkoutComponents,
  computeCardioCredit,
  computeStravaRecoveryLoad,
  computeStrengthCredit,
  getStravaActivityModality,
  getStravaScoreFeatures,
  getStravaWorkoutScoreBreakdown
} from './score-model.mjs';
import { groupStravaActivitiesIntoSessions } from './sessions.mjs';

export {
  STRAVA_SCORE_DEFAULT_SCALE,
  STRAVA_SCORE_MODEL_VERSION,
  combineWorkoutComponents,
  computeCardioCredit,
  computeStravaRecoveryLoad,
  computeStrengthCredit,
  getStravaActivityModality,
  getStravaScoreFeatures,
  getStravaWorkoutScoreBreakdown,
  groupStravaActivitiesIntoSessions
};

let sessionScoreByActivityKey = new Map();
let sessionBreakdownByActivityKey = new Map();

function getActivityKey(activity) {
  if (!activity || typeof activity !== 'object') return null;
  if (activity.id !== null && activity.id !== undefined && activity.id !== '') {
    return `id:${String(activity.id)}`;
  }
  const start = String(activity.start_date || '');
  const name = String(activity.name || '');
  const type = String(activity.sport_type || activity.type || '');
  if (!start && !name && !type) return null;
  return `fallback:${start}|${name}|${type}`;
}

function getCachedSessionScore(activity) {
  const key = getActivityKey(activity);
  if (!key || !sessionScoreByActivityKey.has(key)) {
    return { found: false, value: null };
  }
  return { found: true, value: sessionScoreByActivityKey.get(key) };
}

function roundScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.max(0, numeric) * 10) / 10;
}

export function parseExertionValue(rawValue) {
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.max(0, value) * 10) / 10;
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
  return activity.local_faulty === true || activity.faulty === true;
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

export function computeStravaRawScore(activity) {
  if (!activity) return null;
  const score = getStravaWorkoutScoreBreakdown(activity).total;
  return score > 0 ? score : null;
}

function getSessionPrimaryIndex(session) {
  let primaryIndex = 0;
  let primaryScore = Number.NEGATIVE_INFINITY;
  let primaryMinutes = Number.NEGATIVE_INFINITY;

  session.activities.forEach((activity, index) => {
    const breakdown = getStravaWorkoutScoreBreakdown(activity);
    const score = Number(breakdown.total) || 0;
    const minutes = Number(breakdown.features?.active_minutes) || 0;
    if (
      score > primaryScore ||
      (Math.abs(score - primaryScore) < 1e-9 && minutes > primaryMinutes)
    ) {
      primaryIndex = index;
      primaryScore = score;
      primaryMinutes = minutes;
    }
  });

  return primaryIndex;
}

export function computeStravaScoreScale(activities) {
  sessionScoreByActivityKey = new Map();
  sessionBreakdownByActivityKey = new Map();
  const normalizedActivities = Array.isArray(activities) ? activities : [];
  const sessions = groupStravaActivitiesIntoSessions(normalizedActivities);

  sessions.forEach((session) => {
    const breakdown = getStravaWorkoutScoreBreakdown(session.activity);
    const primaryIndex = getSessionPrimaryIndex(session);
    session.activities.forEach((activity, index) => {
      const key = getActivityKey(activity);
      if (!key) return;
      const sessionPrimary = index === primaryIndex;
      sessionScoreByActivityKey.set(
        key,
        sessionPrimary ? breakdown.total : null
      );
      sessionBreakdownByActivityKey.set(key, {
        ...breakdown,
        sessionActivityCount: session.activities.length,
        sessionPrimary
      });
    });
  });

  return {
    scale: STRAVA_SCORE_DEFAULT_SCALE,
    samples: 0,
    sessions: sessions.length,
    modelVersion: STRAVA_SCORE_MODEL_VERSION
  };
}

export function estimateStravaExertion(
  activity,
  scale = STRAVA_SCORE_DEFAULT_SCALE
) {
  void scale;
  const cached = getCachedSessionScore(activity);
  if (cached.found) {
    return cached.value === null ? null : roundScore(cached.value);
  }
  const raw = computeStravaRawScore(activity);
  return raw === null ? null : roundScore(raw);
}

export function resolveStravaExertion(
  activity,
  scale = STRAVA_SCORE_DEFAULT_SCALE
) {
  if (!activity) return null;
  return estimateStravaExertion(activity, scale);
}

export function getCachedStravaScoreBreakdown(activity) {
  const key = getActivityKey(activity);
  if (!key || !sessionBreakdownByActivityKey.has(key)) return null;
  return sessionBreakdownByActivityKey.get(key);
}
