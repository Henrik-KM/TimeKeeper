import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STRAVA_FEATURE_VERSION,
  STRAVA_SCORE_MODEL_VERSION,
  combineWorkoutComponents,
  computeCardioCredit,
  computeStravaScoreScale,
  computeStrengthCredit,
  estimateStravaExertion,
  getCachedStravaScoreBreakdown,
  getStravaActivityModality,
  getStravaWorkoutScoreBreakdown,
  groupStravaActivitiesIntoSessions,
  resolveStravaExertion
} from '../../src/features/strava/core.mjs';
import { createWorkoutRuntime } from '../../src/features/workouts/runtime.mjs';

let nextActivityId = 1_000;

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function activity(overrides = {}) {
  return {
    id: nextActivityId++,
    name: 'Workout',
    type: 'WeightTraining',
    sport_type: 'WeightTraining',
    start_date: '2026-08-03T08:00:00Z',
    moving_time_min: 75,
    elapsed_time_min: 75,
    avg_hr: 130,
    max_hr: 175,
    ...overrides
  };
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function features(overrides = {}) {
  return {
    version: STRAVA_SCORE_MODEL_VERSION,
    feature_version: STRAVA_FEATURE_VERSION,
    source: 'test',
    active_minutes: 75,
    strength_minutes: 75,
    cardio_zone_minutes: [0, 0, 0, 0, 0],
    strength_density: 0.6,
    strength_factor: 1,
    work_recovery_cycles: 12,
    hr_max_reference: 190,
    ...overrides
  };
}

test('strength scoring is not driven by average heart rate', () => {
  const lowHr = estimateStravaExertion(
    activity({ id: 1, avg_hr: 105, max_hr: 145 })
  );
  const highHr = estimateStravaExertion(
    activity({ id: 2, avg_hr: 170, max_hr: 190 })
  );

  assert.equal(lowHr, highHr);
  assert.equal(lowHr, 4.4);
});

test('stale stream features fall back to the current automatic model', () => {
  const staleRide = activity({
    id: 5,
    type: 'Ride',
    sport_type: 'Ride',
    moving_time_min: 60,
    elapsed_time_min: 60,
    avg_hr: 145,
    score_features: {
      version: STRAVA_SCORE_MODEL_VERSION,
      source: 'streams',
      active_minutes: 60,
      strength_minutes: 60,
      cardio_zone_minutes: [0, 0, 0, 0, 0],
      strength_density: 1
    }
  });

  const breakdown = getStravaWorkoutScoreBreakdown(staleRide);
  assert.equal(breakdown.features.source, 'summary');
  assert.equal(breakdown.features.strength_minutes, 0);
  assert.ok(breakdown.cardio > 0);
});

test('known field sports remain cardio without manual classification', () => {
  assert.equal(
    getStravaActivityModality(
      activity({ type: 'Tennis', sport_type: 'Tennis', distance_km: 0 })
    ),
    'cardio'
  );
});

test('strength fallback includes normal rest between sets', () => {
  const restingStrength = activity({
    id: 3,
    moving_time_min: 30,
    elapsed_time_min: 60
  });

  assert.equal(estimateStravaExertion(restingStrength), 3.8);
});

test('legacy score metadata is preserved but ignored by automatic scoring', () => {
  const overridden = activity({
    id: 4,
    moving_time_min: 60,
    elapsed_time_min: 60,
    exertion: 9,
    local_exertion: 8,
    faulty: true,
    local_faulty: true,
    estimated_exertion: 7,
    reported_exertion: 6
  });

  computeStravaScoreScale([overridden]);

  assert.equal(overridden.exertion, 9);
  assert.equal(overridden.local_exertion, 8);
  assert.equal(overridden.faulty, true);
  assert.equal(overridden.local_faulty, true);
  assert.equal(overridden.estimated_exertion, 7);
  assert.equal(overridden.reported_exertion, 6);
  assert.equal(resolveStravaExertion(overridden), 3.8);
});

test('dense strength outranks a moderate cardio workout of similar duration', () => {
  const strength = computeStrengthCredit(features());
  const cardio = computeCardioCredit(
    features({
      strength_minutes: 0,
      cardio_zone_minutes: [0, 0, 70, 0, 0],
      strength_density: 0
    })
  );

  assert.ok(strength > cardio + 1);
  assert.ok(strength > 4.5);
  assert.ok(cardio < 4);
});

test('secondary modality adds limited credit and never creates two workouts', () => {
  assert.equal(combineWorkoutComponents(5.2, 0.8), 5.4);
  assert.equal(combineWorkoutComponents(4, 4), 5);
  assert.equal(combineWorkoutComponents(6, 6), 7);
  assert.equal(combineWorkoutComponents(9, 6), 10);
});

test('long dense strength sessions can exceed six points', () => {
  const strength = computeStrengthCredit(
    features({
      active_minutes: 240,
      strength_minutes: 240,
      strength_density: 1,
      strength_factor: 1.1
    })
  );

  assert.ok(strength > 6);
});

test('adjacent Strava records are scored as one mixed session', () => {
  const warmup = activity({
    id: 10,
    name: 'Warm-up ride',
    type: 'Ride',
    sport_type: 'Ride',
    start_date: '2026-08-03T08:00:00Z',
    moving_time_min: 12,
    elapsed_time_min: 12,
    score_features: features({
      active_minutes: 12,
      strength_minutes: 0,
      cardio_zone_minutes: [0, 0, 12, 0, 0],
      strength_density: 0
    })
  });
  const lifting = activity({
    id: 11,
    start_date: '2026-08-03T08:14:00Z',
    moving_time_min: 70,
    elapsed_time_min: 70,
    score_features: features({
      active_minutes: 70,
      strength_minutes: 70,
      strength_density: 0.7
    })
  });
  const cooldown = activity({
    id: 12,
    name: 'Cooldown',
    type: 'Ride',
    sport_type: 'Ride',
    start_date: '2026-08-03T09:26:00Z',
    moving_time_min: 10,
    elapsed_time_min: 10,
    score_features: features({
      active_minutes: 10,
      strength_minutes: 0,
      cardio_zone_minutes: [0, 10, 0, 0, 0],
      strength_density: 0
    })
  });

  const sessions = groupStravaActivitiesIntoSessions([
    cooldown,
    lifting,
    warmup
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].activities.length, 3);

  const model = computeStravaScoreScale([cooldown, lifting, warmup]);
  assert.equal(model.modelVersion, STRAVA_SCORE_MODEL_VERSION);
  assert.equal(model.sessions, 1);

  const sessionScore = resolveStravaExertion(lifting);
  assert.ok(sessionScore > 4.5);
  assert.equal(resolveStravaExertion(warmup), null);
  assert.equal(resolveStravaExertion(cooldown), null);

  const breakdown = getCachedStravaScoreBreakdown(lifting);
  assert.equal(breakdown.sessionActivityCount, 3);
  assert.equal(breakdown.sessionPrimary, true);
  assert.ok(breakdown.strength > breakdown.cardio);
});

test('workout runtime scores adjacent Strava records as one session', () => {
  const warmup = activity({
    id: 50,
    name: 'Warm-up ride',
    type: 'Ride',
    sport_type: 'Ride',
    start_date: '2026-08-03T08:00:00Z',
    moving_time_min: 12,
    elapsed_time_min: 12,
    score_features: features({
      active_minutes: 12,
      strength_minutes: 0,
      cardio_zone_minutes: [0, 0, 12, 0, 0],
      strength_density: 0
    })
  });
  const lifting = activity({
    id: 51,
    start_date: '2026-08-03T08:14:00Z',
    moving_time_min: 70,
    elapsed_time_min: 70,
    score_features: features({
      active_minutes: 70,
      strength_minutes: 70,
      strength_density: 0.7
    })
  });
  const cooldown = activity({
    id: 52,
    name: 'Cooldown',
    type: 'Ride',
    sport_type: 'Ride',
    start_date: '2026-08-03T09:26:00Z',
    moving_time_min: 10,
    elapsed_time_min: 10,
    score_features: features({
      active_minutes: 10,
      strength_minutes: 0,
      cardio_zone_minutes: [0, 10, 0, 0, 0],
      strength_density: 0
    })
  });
  const records = [cooldown, lifting, warmup];
  const expectedSession = groupStravaActivitiesIntoSessions(records)[0];
  const expectedScore = resolveStravaExertion(expectedSession.activity);
  const runtime = createWorkoutRuntime({
    ensureFitnessDefaults: () => ({ pointSettings: {} }),
    ensureWorkoutData: () => ({ entries: [] }),
    isWeekPaused: () => false,
    processWorkoutWeekIfNeeded: () => {},
    applyStravaExertionOverrides: (activities) => activities,
    resolveStravaExertion,
    getStravaActivities: () => records
  });

  const stats = runtime.collectWorkoutPoints({
    start: new Date('2026-08-03T00:00:00Z'),
    end: new Date('2026-08-04T00:00:00Z')
  });

  assert.equal(stats.counts.strava, 1);
  assert.equal(stats.totalPoints, expectedScore);
});

test('paused elapsed time does not generate cardio credit', () => {
  const pausedRide = activity({
    id: 20,
    type: 'Ride',
    sport_type: 'Ride',
    moving_time_min: 0.5,
    elapsed_time_min: 75.5,
    avg_hr: 145,
    max_hr: 180
  });
  assert.equal(estimateStravaExertion(pausedRide), 0);
});

test('explicit zero moving time does not fall back to elapsed cardio time', () => {
  const stoppedRide = activity({
    id: 21,
    type: 'Ride',
    sport_type: 'Ride',
    moving_time_min: 0,
    elapsed_time_min: 75,
    distance_km: 10,
    avg_speed_kmh: 20,
    avg_hr: 145,
    max_hr: 180
  });

  assert.equal(estimateStravaExertion(stoppedRide), null);
});

test('missing moving time does not treat all elapsed cardio time as active', () => {
  const incompleteRide = activity({
    id: 22,
    type: 'Ride',
    sport_type: 'Ride',
    elapsed_time_min: 75,
    distance_km: 0,
    avg_speed_kmh: null,
    avg_hr: 145,
    max_hr: 180
  });
  delete incompleteRide.moving_time_min;

  assert.equal(estimateStravaExertion(incompleteRide), null);
});

test('missing moving time can be estimated conservatively from distance and speed', () => {
  const estimatedRide = activity({
    id: 23,
    type: 'Ride',
    sport_type: 'Ride',
    elapsed_time_min: 90,
    distance_km: 10,
    avg_speed_kmh: 20,
    avg_hr: 145,
    max_hr: 180
  });
  delete estimatedRide.moving_time_min;

  const score = estimateStravaExertion(estimatedRide);
  assert.ok(score > 0);
  assert.ok(score < 3);
});

test('manual and reported exertion values do not replace automatic scoring', () => {
  const baseline = activity({
    id: 30,
    moving_time_min: 60.3,
    elapsed_time_min: 60.3
  });
  const overridden = activity({
    ...baseline,
    id: 31,
    exertion: 99,
    local_exertion: 99,
    reported_exertion: 10
  });

  assert.equal(estimateStravaExertion(baseline), 3.8);
  assert.equal(estimateStravaExertion(overridden), 3.8);
});

test('stream-derived mixed features retain a bounded secondary contribution', () => {
  const mixed = activity({
    id: 40,
    score_features: features({
      active_minutes: 80,
      strength_minutes: 65,
      cardio_zone_minutes: [0, 0, 15, 0, 0],
      strength_density: 0.65
    })
  });
  const pureStrength = activity({
    id: 41,
    score_features: features({
      active_minutes: 65,
      strength_minutes: 65,
      strength_density: 0.65
    })
  });

  const mixedScore = getStravaWorkoutScoreBreakdown(mixed);
  const strengthScore = getStravaWorkoutScoreBreakdown(pureStrength);
  assert.ok(mixedScore.total > strengthScore.total);
  assert.ok(mixedScore.total - strengthScore.total < 1);
});
