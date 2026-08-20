import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeStravaRawScore,
  computeStravaScoreScale,
  estimateStravaExertion,
  resolveStravaExertion
} from '../../src/features/strava/core.mjs';

function activity(overrides = {}) {
  return {
    id: overrides.id || Math.random(),
    name: 'Weight training',
    type: 'WeightTraining',
    start_date: '2026-08-10T08:00:00Z',
    elapsed_time_min: 60,
    avg_hr: 140,
    max_hr: 180,
    ...overrides
  };
}

test('v1 score ranks the higher heart-rate workout above a slightly longer lower-load workout', () => {
  const lowerLoad = activity({
    elapsed_time_min: 61.2,
    avg_hr: 138,
    max_hr: 174
  });
  const higherLoad = activity({
    elapsed_time_min: 59.8,
    avg_hr: 156,
    max_hr: 186
  });

  assert.ok(
    computeStravaRawScore(higherLoad) > computeStravaRawScore(lowerLoad)
  );
  assert.ok(
    estimateStravaExertion(higherLoad, 12) >
      estimateStravaExertion(lowerLoad, 12)
  );
});

test('v1 calibration fits measured scores and resolves overrides first', () => {
  const first = activity({ id: 1, avg_hr: 130, max_hr: 170, exertion: 2.5 });
  const second = activity({ id: 2, avg_hr: 150, max_hr: 185, exertion: 4 });
  const result = computeStravaScoreScale([first, second]);

  assert.equal(result.samples, 2);
  assert.ok(result.scale > 0);
  assert.equal(resolveStravaExertion(first, result.scale), 2.5);
});

test('faulty activities are excluded from v1 calibration', () => {
  const valid = activity({ id: 1, avg_hr: 140, max_hr: 180, exertion: 3 });
  const faulty = activity({
    id: 2,
    avg_hr: 180,
    max_hr: 200,
    exertion: 20,
    faulty: true
  });

  const result = computeStravaScoreScale([valid, faulty]);
  const validOnly = computeStravaScoreScale([valid]);

  assert.equal(result.samples, 1);
  assert.equal(result.scale, validOnly.scale);
});
