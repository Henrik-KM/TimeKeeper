import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function runPython(code) {
  return execFileSync('python', ['-c', code], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: process.env
  });
}

function parseLastJsonLine(output) {
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

test('Strava fetcher does not fetch details just because exertion is missing', () => {
  const result = parseLastJsonLine(
    runPython(`
import json
import scripts.fetch_strava as fetch

calls = []

def fake_details(access_token, activity_id):
    calls.append(activity_id)
    return {}

fetch.get_activity_details = fake_details
activity = {
    "id": 123,
    "average_heartrate": 142,
    "max_heartrate": 181,
    "perceived_exertion": None,
}
fetch.enrich_activity(activity, "test-access-token")
print(json.dumps({
    "needs_details": fetch.activity_needs_details(activity),
    "detail_calls": calls,
}))
`)
  );

  assert.equal(result.needs_details, false);
  assert.deepEqual(result.detail_calls, []);
});

test('Strava fetcher merges recent fetches over existing feed rows', () => {
  const result = parseLastJsonLine(
    runPython(`
import json
import scripts.fetch_strava as fetch

merged = fetch.merge_activities(
    [
        {"id": 1, "name": "Old row", "start_date": "2026-01-01T08:00:00Z"},
        {"id": 2, "name": "Existing row", "start_date": "2026-01-02T08:00:00Z"},
    ],
    [
        {"id": 2, "name": "Fresh row", "start_date": "2026-01-03T08:00:00Z"},
        {"id": 3, "name": "New row", "start_date": "2026-01-04T08:00:00Z"},
    ],
)
print(json.dumps(merged))
`)
  );

  assert.deepEqual(
    result.map((activity) => activity.name),
    ['New row', 'Fresh row', 'Old row']
  );
});

test('Strava fetcher exits nonzero while preserving stale activities on failure', () => {
  const result = parseLastJsonLine(
    runPython(`
import json
import os
import tempfile
import scripts.fetch_strava as fetch

with tempfile.TemporaryDirectory() as tmp:
    fetch.OUTFILE = os.path.join(tmp, "assets", "strava.json")
    fetch.CLIENT_ID = ""
    fetch.CLIENT_SECRET = ""
    os.makedirs(os.path.dirname(fetch.OUTFILE), exist_ok=True)
    with open(fetch.OUTFILE, "w", encoding="utf-8") as output_file:
        json.dump(
            {
                "updated_utc": "2026-06-30T18:56:39Z",
                "activities": [{"id": 99, "name": "Cached workout"}],
                "error": None,
            },
            output_file,
        )
    try:
        fetch.main()
    except SystemExit as error:
        exit_code = error.code
    with open(fetch.OUTFILE, "r", encoding="utf-8") as input_file:
        payload = json.load(input_file)
    print(json.dumps({
        "exit_code": exit_code,
        "activity_count": len(payload["activities"]),
        "error": payload["error"],
        "updated_utc": payload["updated_utc"],
    }))
`)
  );

  assert.equal(result.exit_code, 1);
  assert.equal(result.activity_count, 1);
  assert.match(result.error, /Missing STRAVA_CLIENT_ID/);
  assert.equal(result.updated_utc, '2026-06-30T18:56:39Z');
});

test('Strava fetcher retries a fallback refresh token after authorization failure', () => {
  const result = parseLastJsonLine(
    runPython(`
import json
import os
import tempfile

import requests

import scripts.fetch_strava as fetch

with tempfile.TemporaryDirectory() as tmp:
    fetch.OUTFILE = os.path.join(tmp, "assets", "strava.json")
    fetch.TOKEN_FILE = os.path.join(tmp, "token.json")
    fetch.CLIENT_ID = "client-id"
    fetch.CLIENT_SECRET = "client-secret"
    fetch.LOOKBACK_DAYS = 120
    fetch.DETAIL_REQUEST_LIMIT = 0
    os.makedirs(os.path.dirname(fetch.OUTFILE), exist_ok=True)

    attempts = []

    def fake_refresh(refresh_token):
        attempts.append(refresh_token)
        if refresh_token == "bad-token":
            response = requests.Response()
            response.status_code = 403
            response.url = "https://www.strava.com/oauth/token"
            response._content = b'{"message":"Authorization Error"}'
            raise requests.HTTPError(
                "403 Client Error: Forbidden", response=response
            )
        return "access-token", "rotated-token"

    def fake_activities(access_token, after=None):
        return [
            {
                "id": 456,
                "name": "Recovered workout",
                "type": "WeightTraining",
                "start_date": "2026-07-02T08:00:00Z",
                "elapsed_time": 3600,
                "moving_time": 3600,
                "average_heartrate": 120,
                "max_heartrate": 160,
            }
        ]

    fetch.load_refresh_token_candidates = lambda: ["bad-token", "good-token"]
    fetch.refresh_access_token = fake_refresh
    fetch.get_all_activities = fake_activities
    fetch.load_exertion_overrides = lambda: {}
    fetch.main()

    with open(fetch.OUTFILE, "r", encoding="utf-8") as input_file:
        payload = json.load(input_file)
    with open(fetch.TOKEN_FILE, "r", encoding="utf-8") as input_file:
        token_payload = json.load(input_file)
    print(json.dumps({
        "attempts": attempts,
        "activity_count": len(payload["activities"]),
        "activity_name": payload["activities"][0]["name"],
        "error": payload["error"],
        "persisted_refresh_token": token_payload["refresh_token"],
    }))
`)
  );

  assert.deepEqual(result.attempts, ['bad-token', 'good-token']);
  assert.equal(result.activity_count, 1);
  assert.equal(result.activity_name, 'Recovered workout');
  assert.equal(result.error, null);
  assert.equal(result.persisted_refresh_token, 'rotated-token');
});
