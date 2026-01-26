import json
import os
from datetime import datetime, timezone

import requests

CLIENT_ID = os.environ["STRAVA_CLIENT_ID"]
CLIENT_SECRET = os.environ["STRAVA_CLIENT_SECRET"]
PER_PAGE = 200

OUTFILE = "assets/strava.json"
TOKEN_FILE = "_private/strava_token.json"
OVERRIDES_FILE = "assets/strava_overrides.json"


def load_refresh_token() -> tuple[str, bool]:
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "r", encoding="utf-8") as token_file:
            payload = json.load(token_file)
            token = payload.get("refresh_token")
            if token:
                return token, True
    return os.environ["STRAVA_REFRESH_TOKEN"], False


def persist_refresh_token(refresh_token: str) -> None:
    outdir = os.path.dirname(TOKEN_FILE)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    payload = {
        "refresh_token": refresh_token,
        "updated_utc": datetime.now(timezone.utc).isoformat(),
    }
    with open(TOKEN_FILE, "w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")


def refresh_access_token(refresh_token: str) -> tuple[str, str | None]:
    response = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    return payload["access_token"], payload.get("refresh_token")


def get_activities_page(access_token: str, page: int, per_page: int) -> list[dict]:
    response = requests.get(
        "https://www.strava.com/api/v3/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"per_page": per_page, "page": page},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_all_activities(access_token: str) -> list[dict]:
    activities: list[dict] = []
    page = 1
    while True:
        batch = get_activities_page(access_token, page=page, per_page=PER_PAGE)
        if not batch:
            break
        activities.extend(batch)
        if len(batch) < PER_PAGE:
            break
        page += 1
    return activities


def load_exertion_overrides() -> dict[str, float]:
    if not os.path.exists(OVERRIDES_FILE):
        return {}
    with open(OVERRIDES_FILE, "r", encoding="utf-8") as overrides_file:
        payload = json.load(overrides_file)
    overrides: dict[str, float] = {}
    for key, value in payload.items():
        if isinstance(value, dict):
            exertion = value.get("exertion")
        else:
            exertion = value
        if isinstance(exertion, (int, float)):
            overrides[str(key)] = float(exertion)
    return overrides


def estimate_exertion(
    avg_hr: float | None, max_hr: float | None, elapsed_time_min: float | None
) -> float | None:
    if not avg_hr or not max_hr or not elapsed_time_min:
        return None
    if max_hr <= 0 or elapsed_time_min <= 0:
        return None
    intensity = avg_hr / max_hr
    score = intensity * (elapsed_time_min / 60.0) * 3.5
    score = max(0.0, min(5.0, score))
    return round(score, 2)


def slim(activity: dict) -> dict:
    return {
        "id": activity.get("id"),
        "name": activity.get("name"),
        "type": activity.get("type"),
        "start_date": activity.get("start_date"),
        "distance_km": round(((activity.get("distance") or 0.0) / 1000.0), 2),
        "moving_time_min": round(((activity.get("moving_time") or 0) / 60.0), 1),
        "elapsed_time_min": round(((activity.get("elapsed_time") or 0) / 60.0), 1),
        "total_elevation_gain_m": activity.get("total_elevation_gain"),
        "avg_hr": activity.get("average_heartrate"),
        "max_hr": activity.get("max_heartrate"),
        "reported_exertion": activity.get("perceived_exertion"),
        "avg_speed_kmh": (
            round((activity.get("average_speed", 0.0) * 3.6), 2)
            if activity.get("average_speed")
            else None
        ),
        "url": (
            f"https://www.strava.com/activities/{activity.get('id')}"
            if activity.get("id")
            else None
        ),
    }


def write_payload(activities: list[dict], error: str | None = None) -> None:
    payload = {
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "activities": activities,
        "error": error,
    }

    outdir = os.path.dirname(OUTFILE)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    with open(OUTFILE, "w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")


def main() -> None:
    try:
        refresh_token, token_from_file = load_refresh_token()
        access_token, next_refresh_token = refresh_access_token(refresh_token)
        if next_refresh_token and (not token_from_file or next_refresh_token != refresh_token):
            persist_refresh_token(next_refresh_token)
        overrides = load_exertion_overrides()
        activities = get_all_activities(access_token)
        slimmed: list[dict] = []
        for activity in activities:
            payload = slim(activity)
            payload["estimated_exertion"] = estimate_exertion(
                payload.get("avg_hr"),
                payload.get("max_hr"),
                payload.get("elapsed_time_min"),
            )
            override = overrides.get(str(payload.get("id")))
            payload["exertion"] = override if override is not None else None
            slimmed.append(payload)
        write_payload(slimmed)
    except requests.HTTPError as error:
        status_code = error.response.status_code if error.response else None
        if status_code in {401, 403}:
            message = (
                "Strava authorization failed. Verify that the refresh token "
                "has activity:read_all scope and that the STRAVA_* secrets are valid."
            )
            print(message)
            write_payload([], error=message)
            return
        # Handle other HTTP errors by writing an error payload instead of crashing
        message = f"HTTP error while fetching Strava data: {error}"
        print(message)
        write_payload([], error=message)
        return
    except (requests.RequestException, json.JSONDecodeError, KeyError, Exception) as error:
        # Catch other errors (connection issues, JSON problems, missing keys, etc.)
        message = f"Unexpected error while fetching Strava data: {error}"
        print(message)
        write_payload([], error=message)
        return


if __name__ == "__main__":
    main()
