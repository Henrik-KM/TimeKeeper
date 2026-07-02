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
