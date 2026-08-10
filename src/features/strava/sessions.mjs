import {
  STRAVA_SCORE_MODEL_VERSION,
  clampScoreValue,
  getStravaActivityActiveMinutes,
  getStravaActivityModality,
  getStravaScoreFeatures,
  normalizeCardioZoneMinutes
} from './score-model.mjs';

const SESSION_GAP_MINUTES = 15;
const DEFAULT_MAX_HR = 190;

function getSessionDurationMinutes(activity) {
  const modality = getStravaActivityModality(activity);
  const active = getStravaActivityActiveMinutes(activity, modality);
  const elapsed = Number(activity?.elapsed_time_min);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return active;
  return Math.min(elapsed, Math.max(active + 30, active * 1.5, 15), 360);
}

function mergeSessionFeatures(activities, sessionSpanMinutes) {
  const records = activities.map((activity) =>
    getStravaScoreFeatures(activity)
  );
  let activeMinutes = 0;
  let strengthMinutes = 0;
  const cardioZoneMinutes = [0, 0, 0, 0, 0];
  let densityNumerator = 0;
  let factorNumerator = 0;
  let workRecoveryCycles = 0;
  let hrReference = DEFAULT_MAX_HR;

  records.forEach((features) => {
    activeMinutes += Math.max(0, Number(features.active_minutes) || 0);
    const strength = Math.max(0, Number(features.strength_minutes) || 0);
    strengthMinutes += strength;
    densityNumerator +=
      strength * clampScoreValue(features.strength_density, 0, 1);
    factorNumerator +=
      strength * clampScoreValue(features.strength_factor ?? 1, 0.5, 1.1);
    normalizeCardioZoneMinutes(features.cardio_zone_minutes).forEach(
      (minutes, index) => {
        cardioZoneMinutes[index] += minutes;
      }
    );
    workRecoveryCycles += Math.max(
      0,
      Number(features.work_recovery_cycles) || 0
    );
    hrReference = Math.max(
      hrReference,
      Number(features.hr_max_reference) || 0
    );
  });

  const originalStrengthMinutes = strengthMinutes;
  const averageDensity =
    originalStrengthMinutes > 0
      ? clampScoreValue(densityNumerator / originalStrengthMinutes, 0, 1)
      : 0;
  const averageFactor =
    originalStrengthMinutes > 0
      ? clampScoreValue(factorNumerator / originalStrengthMinutes, 0.5, 1.1)
      : 1;
  const componentMinutes =
    strengthMinutes +
    cardioZoneMinutes.reduce((sum, minutes) => sum + minutes, 0);
  const availableMinutes = Math.max(0, Number(sessionSpanMinutes) || 0);
  if (availableMinutes > 0 && componentMinutes > availableMinutes) {
    const scale = availableMinutes / componentMinutes;
    strengthMinutes *= scale;
    cardioZoneMinutes.forEach((minutes, index) => {
      cardioZoneMinutes[index] = minutes * scale;
    });
    activeMinutes = Math.min(activeMinutes, availableMinutes);
  }

  return {
    version: STRAVA_SCORE_MODEL_VERSION,
    source: activities.length > 1 ? 'session' : records[0]?.source || 'summary',
    active_minutes: Math.min(
      activeMinutes,
      availableMinutes > 0 ? availableMinutes : activeMinutes
    ),
    strength_minutes: strengthMinutes,
    cardio_zone_minutes: cardioZoneMinutes,
    strength_density: averageDensity,
    strength_factor: averageFactor,
    work_recovery_cycles: workRecoveryCycles,
    hr_max_reference: hrReference
  };
}

function createSessionRecord(activities, startMs, endMs) {
  const first = activities[0];
  const activityIds = activities
    .map((activity) => activity?.id)
    .filter((id) => id !== null && id !== undefined);
  const activity = Object.assign({}, first, {
    id:
      activityIds.length > 0
        ? `session:${activityIds.join('+')}`
        : `session:${String(first?.start_date || startMs)}`,
    name:
      activities.length > 1
        ? `${String(first?.name || 'Workout')} + ${activities.length - 1}`
        : first?.name,
    score_model_version: STRAVA_SCORE_MODEL_VERSION,
    score_features: mergeSessionFeatures(
      activities,
      Math.max(0, (endMs - startMs) / 60000)
    ),
    session_activity_count: activities.length,
    session_activity_ids: activityIds
  });
  return { activities, activity, startMs, endMs };
}

export function groupStravaActivitiesIntoSessions(
  activities,
  gapMinutes = SESSION_GAP_MINUTES
) {
  if (!Array.isArray(activities) || activities.length === 0) return [];
  const valid = activities
    .filter((activity) => activity && activity.start_date)
    .map((activity) => {
      const startMs = Date.parse(activity.start_date);
      const durationMinutes = getSessionDurationMinutes(activity);
      return {
        activity,
        startMs,
        endMs: startMs + Math.max(0, durationMinutes) * 60000
      };
    })
    .filter((record) => Number.isFinite(record.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  const sessions = [];
  const allowedGapMs = Math.max(0, Number(gapMinutes) || 0) * 60000;
  /** @type {{ activities: object[], startMs: number, endMs: number } | null} */
  let current = null;

  for (const record of valid) {
    if (!current || record.startMs > current.endMs + allowedGapMs) {
      if (current) {
        sessions.push(
          createSessionRecord(
            current.activities,
            current.startMs,
            current.endMs
          )
        );
      }
      current = {
        activities: [record.activity],
        startMs: record.startMs,
        endMs: record.endMs
      };
      continue;
    }
    current.activities.push(record.activity);
    current.endMs = Math.max(current.endMs, record.endMs);
  }

  if (current) {
    sessions.push(
      createSessionRecord(current.activities, current.startMs, current.endMs)
    );
  }
  return sessions;
}
