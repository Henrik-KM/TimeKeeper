function firstValue(row, ...names) {
  const lowered = {};
  Object.keys(row || {}).forEach((key) => {
    lowered[String(key).trim().toLowerCase()] = row[key];
  });
  for (const name of names) {
    const value = lowered[String(name).toLowerCase()];
    if (value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(',', '.');
  if (!text) return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDurationMinutes(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const parts = text.split(':');
  if (
    (parts.length === 2 || parts.length === 3) &&
    parts.every((part) => /^\d+$/.test(part.trim()))
  ) {
    const nums = parts.map((part) => Number.parseInt(part, 10));
    const [hours, minutes, seconds] =
      nums.length === 2 ? [0, nums[0], nums[1]] : nums;
    return Math.round((hours * 60 + minutes + seconds / 60) * 10) / 10;
  }
  const numeric = parseNumber(text);
  if (numeric !== null) {
    return Math.round((numeric / 60) * 10) / 10;
  }
  return null;
}

export function parseStravaDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const isoLike = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (isoLike) {
    const [, year, month, day, hours = '0', minutes = '0', seconds = '0'] =
      isoLike;
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds)
      )
    ).toISOString();
  }
  const dmy = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmy) {
    const [, day, month, year, hours = '0', minutes = '0', seconds = '0'] = dmy;
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds)
      )
    ).toISOString();
  }
  const native = new Date(text.replace('Z', '+00:00'));
  if (!Number.isNaN(native.getTime())) {
    return native.toISOString();
  }
  return null;
}

export function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = String(csvText || '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headerRow = rows.find((candidate) =>
    candidate.some((value) => String(value).trim())
  );
  if (!headerRow) return [];
  const headerIndex = rows.indexOf(headerRow);
  const headers = headerRow.map((value) => String(value || '').trim());
  return rows
    .slice(headerIndex + 1)
    .filter((candidate) => candidate.some((value) => String(value).trim()))
    .map((values) => {
      const record = {};
      headers.forEach((header, index) => {
        if (header) record[header] = values[index] || '';
      });
      return record;
    });
}

function getExistingActivity(existingActivities, activityId) {
  if (!Array.isArray(existingActivities) || !activityId) return {};
  return (
    existingActivities.find(
      (activity) => String(activity && activity.id) === String(activityId)
    ) || {}
  );
}

export function activityFromStravaCsvRow(row, existingActivities = []) {
  const rawId = firstValue(row, 'Activity ID', 'Activity Id', 'ID', 'Id');
  const parsedId = parseNumber(rawId);
  const activityId =
    parsedId !== null && Number.isSafeInteger(Math.round(parsedId))
      ? Math.round(parsedId)
      : null;
  const existingActivity = getExistingActivity(existingActivities, activityId);
  const startDate =
    parseStravaDate(
      firstValue(
        row,
        'Activity Date',
        'Start Date',
        'Date',
        'Begin Timestamp',
        'Start Time'
      )
    ) || existingActivity.start_date;
  if (!startDate) return null;

  const elapsed = parseDurationMinutes(
    firstValue(row, 'Elapsed Time', 'Elapsed Time.1', 'Elapsed')
  );
  const moving = parseDurationMinutes(firstValue(row, 'Moving Time', 'Moving'));
  const distance = parseNumber(firstValue(row, 'Distance', 'Distance.1'));
  const activity = {
    id: activityId,
    name:
      firstValue(row, 'Activity Name', 'Name', 'Title') ||
      existingActivity.name ||
      'Strava activity',
    type:
      firstValue(row, 'Activity Type', 'Type', 'Sport') ||
      existingActivity.type ||
      'Activity',
    start_date: startDate,
    distance_km: distance !== null ? Math.round(distance * 100) / 100 : null,
    moving_time_min: moving,
    elapsed_time_min: elapsed !== null ? elapsed : moving,
    total_elevation_gain_m: parseNumber(
      firstValue(row, 'Elevation Gain', 'Total Elevation Gain')
    ),
    avg_hr: parseNumber(
      firstValue(row, 'Average Heart Rate', 'Avg Heart Rate', 'Average HR')
    ),
    max_hr: parseNumber(firstValue(row, 'Max Heart Rate', 'Max HR')),
    reported_exertion: parseNumber(
      firstValue(row, 'Relative Effort', 'Perceived Exertion', 'Effort')
    ),
    avg_speed_kmh: null,
    url: activityId ? `https://www.strava.com/activities/${activityId}` : null
  };

  Object.keys(existingActivity).forEach((key) => {
    if (
      (activity[key] === null ||
        activity[key] === undefined ||
        activity[key] === '') &&
      existingActivity[key] !== null &&
      existingActivity[key] !== undefined &&
      existingActivity[key] !== ''
    ) {
      activity[key] = existingActivity[key];
    }
  });
  return activity;
}

export function buildStravaPayloadFromCsv(
  csvText,
  {
    sourceName = 'activities.csv',
    existingActivities = [],
    now = new Date()
  } = {}
) {
  const rows = parseCsvRows(csvText);
  const activities = [];
  const seen = new Set();
  rows.forEach((row) => {
    const activity = activityFromStravaCsvRow(row, existingActivities);
    if (!activity) return;
    const key = String(
      activity.id || `${activity.start_date}:${activity.name || ''}`
    );
    if (seen.has(key)) return;
    seen.add(key);
    activities.push(activity);
  });
  activities.sort((a, b) =>
    String(b.start_date || '').localeCompare(String(a.start_date || ''))
  );
  return {
    updated_utc: now.toISOString(),
    source: `strava-export:${sourceName}`,
    activities,
    error: null
  };
}
