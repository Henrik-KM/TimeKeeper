import argparse
import csv
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path


OUTFILE = "assets/strava.json"
OVERRIDES_FILE = "assets/strava_overrides.json"


def first_value(row: dict, *names: str) -> str:
    lowered = {str(key).strip().lower(): value for key, value in row.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def parse_number(value: str) -> float | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_duration_minutes(value: str) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    numeric = parse_number(text)
    if numeric is not None:
        # Strava export duration columns are normally seconds.
        return round(numeric / 60.0, 1)
    parts = text.split(":")
    if len(parts) in {2, 3} and all(part.strip().isdigit() for part in parts):
        nums = [int(part) for part in parts]
        if len(nums) == 2:
          hours, minutes, seconds = 0, nums[0], nums[1]
        else:
          hours, minutes, seconds = nums
        return round(hours * 60 + minutes + seconds / 60.0, 1)
    return None


def parse_date(value: str) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        parsed = None
    if parsed is None:
        formats = [
            "%b %d, %Y, %I:%M:%S %p",
            "%b %d, %Y, %I:%M %p",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%d/%m/%Y, %H:%M:%S",
            "%d/%m/%Y %H:%M:%S",
            "%d/%m/%Y %H:%M",
        ]
        for fmt in formats:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                pass
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_existing_activities(path: str) -> dict[str, dict]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as existing_file:
            payload = json.load(existing_file)
    except (OSError, json.JSONDecodeError):
        return {}
    activities = payload.get("activities") if isinstance(payload, dict) else None
    if not isinstance(activities, list):
        return {}
    return {
        str(activity.get("id")): activity
        for activity in activities
        if isinstance(activity, dict) and activity.get("id") is not None
    }


def load_exertion_overrides() -> dict[str, dict[str, float | bool]]:
    if not os.path.exists(OVERRIDES_FILE):
        return {}
    with open(OVERRIDES_FILE, "r", encoding="utf-8") as overrides_file:
        payload = json.load(overrides_file)
    overrides: dict[str, dict[str, float | bool]] = {}
    for key, value in payload.items():
        record: dict[str, float | bool] = {}
        if isinstance(value, dict):
            exertion = value.get("exertion")
            if isinstance(value.get("faulty"), bool) and value.get("faulty"):
                record["faulty"] = True
        else:
            exertion = value
        if isinstance(exertion, (int, float)):
            record["exertion"] = float(exertion)
        if record:
            overrides[str(key)] = record
    return overrides


def find_activities_csv(source: Path) -> tuple[str, str]:
    if source.is_dir():
        candidates = list(source.rglob("activities.csv"))
        if not candidates:
            raise FileNotFoundError(f"No activities.csv found under {source}")
        path = candidates[0]
        return path.read_text(encoding="utf-8-sig"), str(path)
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            names = [
                name
                for name in archive.namelist()
                if name.lower().endswith("activities.csv")
            ]
            if not names:
                raise FileNotFoundError(f"No activities.csv found in {source}")
            with archive.open(names[0]) as handle:
                return handle.read().decode("utf-8-sig"), names[0]
    return source.read_text(encoding="utf-8-sig"), str(source)


def activity_from_row(row: dict, existing: dict[str, dict]) -> dict | None:
    raw_id = first_value(row, "Activity ID", "Activity Id", "ID", "Id")
    activity_id_num = parse_number(raw_id)
    activity_id = int(activity_id_num) if activity_id_num is not None else None
    existing_activity = existing.get(str(activity_id)) if activity_id else {}
    start_date = parse_date(
        first_value(
            row,
            "Activity Date",
            "Start Date",
            "Date",
            "Begin Timestamp",
            "Start Time",
        )
    )
    if not start_date and existing_activity:
        start_date = existing_activity.get("start_date")
    if not start_date:
        return None
    name = (
        first_value(row, "Activity Name", "Name", "Title")
        or existing_activity.get("name")
        or "Strava activity"
    )
    activity_type = (
        first_value(row, "Activity Type", "Type", "Sport")
        or existing_activity.get("type")
        or "Activity"
    )
    elapsed = parse_duration_minutes(
        first_value(row, "Elapsed Time", "Elapsed Time.1", "Elapsed")
    )
    moving = parse_duration_minutes(first_value(row, "Moving Time", "Moving"))
    distance = parse_number(first_value(row, "Distance", "Distance.1"))
    avg_hr = parse_number(
        first_value(row, "Average Heart Rate", "Avg Heart Rate", "Average HR")
    )
    max_hr = parse_number(first_value(row, "Max Heart Rate", "Max HR"))
    reported = parse_number(
        first_value(row, "Relative Effort", "Perceived Exertion", "Effort")
    )
    activity = {
        "id": activity_id,
        "name": name,
        "type": activity_type,
        "start_date": start_date,
        "distance_km": round(distance, 2) if distance is not None else None,
        "moving_time_min": moving,
        "elapsed_time_min": elapsed if elapsed is not None else moving,
        "total_elevation_gain_m": parse_number(
            first_value(row, "Elevation Gain", "Total Elevation Gain")
        ),
        "avg_hr": avg_hr,
        "max_hr": max_hr,
        "reported_exertion": reported,
        "avg_speed_kmh": None,
        "url": f"https://www.strava.com/activities/{activity_id}"
        if activity_id
        else None,
    }
    for key, value in existing_activity.items():
        if activity.get(key) in {None, ""} and value not in {None, ""}:
            activity[key] = value
    return activity


def apply_overrides(activity: dict, overrides: dict[str, dict[str, float | bool]]) -> dict:
    override = overrides.get(str(activity.get("id")))
    activity["exertion"] = override.get("exertion") if override else None
    activity["faulty"] = bool(override.get("faulty")) if override else False
    return activity


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import Strava's free data-export activities.csv into TimeKeeper."
    )
    parser.add_argument("source", help="Path to a Strava export zip, folder, or activities.csv")
    parser.add_argument("--output", default=OUTFILE, help=f"Output JSON path, default {OUTFILE}")
    args = parser.parse_args()

    source = Path(args.source).expanduser()
    csv_text, csv_name = find_activities_csv(source)
    existing = read_existing_activities(args.output)
    overrides = load_exertion_overrides()
    rows = csv.DictReader(csv_text.splitlines())
    activities: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        activity = activity_from_row(row, existing)
        if not activity:
            continue
        key = str(activity.get("id") or activity.get("start_date"))
        if key in seen:
            continue
        seen.add(key)
        activities.append(apply_overrides(activity, overrides))
    activities.sort(key=lambda item: item.get("start_date") or "", reverse=True)
    payload = {
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "source": f"strava-export:{csv_name}",
        "activities": activities,
        "error": None,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(activities)} activities to {output_path}")


if __name__ == "__main__":
    main()
