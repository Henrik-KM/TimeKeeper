import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStravaPayloadFromCsv,
  parseCsvRows,
  parseDurationMinutes,
  parseStravaDate
} from '../../src/features/strava/import.mjs';

test('parseCsvRows handles quoted commas and blank trailing lines', () => {
  const rows = parseCsvRows(
    'Activity ID,Activity Name,Activity Type\n123,"Ride, Outside",Ride\n\n'
  );

  assert.deepEqual(rows, [
    {
      'Activity ID': '123',
      'Activity Name': 'Ride, Outside',
      'Activity Type': 'Ride'
    }
  ]);
});

test('parseDurationMinutes accepts seconds and clock values', () => {
  assert.equal(parseDurationMinutes('3600'), 60);
  assert.equal(parseDurationMinutes('1:02:30'), 62.5);
  assert.equal(parseDurationMinutes('45:00'), 45);
});

test('parseStravaDate accepts ISO and exported day/month values', () => {
  assert.equal(
    parseStravaDate('2026-06-02 09:30:00'),
    '2026-06-02T09:30:00.000Z'
  );
  assert.equal(parseStravaDate('02/06/2026 09:30'), '2026-06-02T09:30:00.000Z');
});

test('buildStravaPayloadFromCsv converts free Strava export rows', () => {
  const payload = buildStravaPayloadFromCsv(
    [
      'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Moving Time,Distance,Average Heart Rate,Max Heart Rate,Relative Effort',
      '998877,2026-06-02 09:00:00,Browser CSV Ride,Ride,2700,2500,21.4,140,170,3.2'
    ].join('\n'),
    {
      sourceName: 'activities.csv',
      now: new Date('2026-06-03T08:00:00Z')
    }
  );

  assert.equal(payload.updated_utc, '2026-06-03T08:00:00.000Z');
  assert.equal(payload.source, 'strava-export:activities.csv');
  assert.equal(payload.activities.length, 1);
  assert.deepEqual(payload.activities[0], {
    id: 998877,
    name: 'Browser CSV Ride',
    type: 'Ride',
    start_date: '2026-06-02T09:00:00.000Z',
    distance_km: 21.4,
    moving_time_min: 41.7,
    elapsed_time_min: 45,
    total_elevation_gain_m: null,
    avg_hr: 140,
    max_hr: 170,
    reported_exertion: 3.2,
    avg_speed_kmh: null,
    url: 'https://www.strava.com/activities/998877'
  });
});
