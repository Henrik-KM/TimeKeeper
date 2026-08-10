import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STRAVA_SCORE_MODEL_VERSION,
  combineWorkoutComponents,
  computeCardioCredit,
  computeStravaScoreScale,
  computeStrengthCredit,
  estimateStravaExertion,
  getCachedStravaScoreBreakdown,
  getStravaWorkoutScoreBreakdown,
  groupStravaActivitiesIntoSessions,
  resolveStravaExertion
} from '../../src/features/strava/core.mjs';

function activity(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 1_000_000_000),
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

function features(overrides = {}) {
  return {
    version: STRAVA_SCORE_MODEL_VERSION,
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

test(
  'dense strength outranks a moderate cardio workout of similar duration',
  () => {
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
  }
);

test(
  'secondary modality adds limited credit and never creates two workouts',
  () => {
    assert.equal(combineWorkoutComponents(5.2, 0.8), 5.4);
    assert.equal(combineWorkoutComponents(4, 4), 5);
    assert.equal(combineWorkoutComponents(6, 6), 6);
  }
);

test('adjacent Strava records are scored as one bounded mixed session', () => {
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

  const sessionScore = resolveStravaExertion(warmup);
  assert.ok(sessionScore > 4.5);
  assert.ok(sessionScore <= 6);
  assert.equal(resolveStravaExertion(lifting), null);
  assert.equal(resolveStravaExertion(cooldown), null);

  const breakdown = getCachedStravaScoreBreakdown(warmup);
  assert.equal(breakdown.sessionActivityCount, 3);
  assert.equal(breakdown.sessionPrimary, true);
  assert.ok(breakdown.strength > breakdown.cardio);
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

test(
  'manual and reported exertion values do not replace automatic scoring',
  () => {
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
  }
);

test(
  'stream-derived mixed features retain a bounded secondary contribution',
  () => {
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
    assert.ok(mixedScore.total <= 6);
  }
);
