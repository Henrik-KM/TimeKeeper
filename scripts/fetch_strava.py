import json
import os
from datetime import datetime, timezone

import requests


def _get_env_var(name: str) -> str:
    """
    Retrieve a required environment variable or raise a descriptive error.
    """
    try:
        value = os.environ[name]
    except KeyError as exc:
        raise RuntimeError(
            f"Required environment variable '{name}' is not set. "
            "Please set it before running this script."
        ) from exc

    if not value:
        raise RuntimeError(
            f"Required environment variable '{name}' is empty. "
            "Please set it to a non-empty value before running this script."
        )

    return value


CLIENT_ID = _get_env_var("STRAVA_CLIENT_ID")
CLIENT_SECRET = _get_env_var("STRAVA_CLIENT_SECRET")
REFRESH_TOKEN = _get_env_var("STRAVA_REFRESH_TOKEN")
OUTFILE = "assets/strava.json"


def refresh_access_token() -> str:
    response = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": REFRESH_TOKEN,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def get_activities(access_token: str, per_page: int = 20) -> list[dict]:
    response = requests.get(
        "https://www.strava.com/api/v3/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"per_page": per_page},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def slim(activity: dict) -> dict:
    return {
        "id": activity.get("id"),
        "name": activity.get("name"),
        "type": activity.get("type"),
        "start_date": activity.get("start_date"),
        "distance_km": round((activity.get("distance", 0.0) / 1000.0), 2),
        "moving_time_min": round((activity.get("moving_time", 0) / 60.0), 1),
        "elapsed_time_min": round((activity.get("elapsed_time", 0) / 60.0), 1),
        "total_elevation_gain_m": activity.get("total_elevation_gain"),
        "avg_hr": activity.get("average_heartrate"),
        "max_hr": activity.get("max_heartrate"),
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


def main() -> None:
    token = refresh_access_token()
    activities = get_activities(token, per_page=20)

    payload = {
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "activities": [slim(activity) for activity in activities],
    }

    os.makedirs(os.path.dirname(OUTFILE), exist_ok=True)
    with open(OUTFILE, "w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")


if __name__ == "__main__":
    main()
