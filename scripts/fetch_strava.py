import json
import os
from datetime import datetime, timedelta, timezone

import requests

CLIENT_ID = os.environ.get("STRAVA_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "").strip()
PER_PAGE = 200
DEFAULT_LOOKBACK_DAYS = 120
DEFAULT_DETAIL_REQUEST_LIMIT = 40

OUTFILE = "assets/strava.json"
TOKEN_FILE = "_private/strava_token.json"
OVERRIDES_FILE = "assets/strava_overrides.json"


class StravaConfigurationError(RuntimeError):
    pass


def read_int_env(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, value)


LOOKBACK_DAYS = read_int_env("STRAVA_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS)
DETAIL_REQUEST_LIMIT = read_int_env(
    "STRAVA_DETAIL_REQUEST_LIMIT", DEFAULT_DETAIL_REQUEST_LIMIT, minimum=0
)


def load_refresh_token() -> str:
    return load_refresh_token_candidates()[0]


def load_refresh_token_candidates() -> list[str]:
    candidates: list[str] = []
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "r", encoding="utf-8") as token_file:
            payload = json.load(token_file)
            token = payload.get("refresh_token")
            if token:
                candidates.append(token)
    env_token = os.environ.get("STRAVA_REFRESH_TOKEN", "").strip()
    if env_token and env_token not in candidates:
        candidates.append(env_token)
    if candidates:
        return candidates
    raise StravaConfigurationError(
        f"Missing Strava refresh token. Restore {TOKEN_FILE} or add "
        "STRAVA_REFRESH_TOKEN as a GitHub Actions secret."
    )


def persist_refresh_token(refresh_token: str) -> None:
    payload = {
        "refresh_token": refresh_token,
        "updated_utc": datetime.now(timezone.utc).isoformat(),
    }
    outdir = os.path.dirname(TOKEN_FILE)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    with open(TOKEN_FILE, "w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")


def read_existing_payload() -> dict | None:
    if not os.path.exists(OUTFILE):
        return None
    try:
        with open(OUTFILE, "r", encoding="utf-8") as existing_file:
            payload = json.load(existing_file)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    activities = payload.get("activities")
    if not isinstance(activities, list) or not activities:
        return None
    return payload


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


def get_http_status_code(error: requests.HTTPError) -> int | None:
    return error.response.status_code if error.response is not None else None


def format_http_error(error: requests.HTTPError) -> str:
    response = error.response
    if response is None:
        return str(error)
    detail = ""
    try:
        body = response.json()
    except ValueError:
        body = response.text
    if body:
        body_text = json.dumps(body) if isinstance(body, (dict, list)) else str(body)
        detail = f" Response: {body_text[:500]}"
    return f"{error}{detail}"


def can_retry_with_next_refresh_token(
    error: requests.HTTPError, token_index: int, token_count: int
) -> bool:
    if token_index >= token_count - 1:
        return False
    return get_http_status_code(error) in {400, 401, 403}


def get_activities_page(
    access_token: str, page: int, per_page: int, after: int | None = None
) -> list[dict]:
    params = {"per_page": per_page, "page": page}
    if after is not None:
        params["after"] = after
    response = requests.get(
        "https://www.strava.com/api/v3/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_all_activities(
    access_token: str, after: int | None = None
) -> list[dict]:
    activities: list[dict] = []
    page = 1
    while True:
        batch = get_activities_page(
            access_token, page=page, per_page=PER_PAGE, after=after
        )
        if not batch:
            break
        activities.extend(batch)
        if len(batch) < PER_PAGE:
            break
        page += 1
    return activities


def get_activity_details(access_token: str, activity_id: int) -> dict:
    response = requests.get(
        f"https://www.strava.com/api/v3/activities/{activity_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def activity_needs_details(activity: dict) -> bool:
    if not activity.get("id"):
        return False
    return any(
        activity.get(key) is None
        for key in ("average_heartrate", "max_heartrate")
    )


def enrich_activity(activity: dict, access_token: str) -> dict:
    if not activity_needs_details(activity):
        return activity
    details = get_activity_details(access_token, activity["id"])
    for key in ("average_heartrate", "max_heartrate", "perceived_exertion"):
        if activity.get(key) is None and details.get(key) is not None:
            activity[key] = details.get(key)
    return activity


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


def estimate_exertion(
    avg_hr: float | None, max_hr: float | None, elapsed_time_min: float | None
) -> float | None:
    if not avg_hr or not max_hr or not elapsed_time_min:
        return None
    if max_hr <= 0 or elapsed_time_min <= 0:
        return None
    intensity = avg_hr / max_hr
    score = intensity * (elapsed_time_min / 60.0) * 3.5
    score = max(0.0, score)
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


def get_recent_activity_cutoff() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    return int(cutoff.timestamp())


def merge_activities(existing: list[dict], fresh: list[dict]) -> list[dict]:
    merged_by_id: dict[str, dict] = {}
    anonymous: list[dict] = []
    for activity in [*existing, *fresh]:
        activity_id = activity.get("id")
        if activity_id is None:
            anonymous.append(activity)
            continue
        merged_by_id[str(activity_id)] = activity
    merged = [*merged_by_id.values(), *anonymous]
    return sorted(
        merged,
        key=lambda activity: str(activity.get("start_date") or ""),
        reverse=True,
    )


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


def preserve_existing_payload(message: str) -> bool:
    existing = read_existing_payload()
    if not existing:
        return False
    count = len(existing.get("activities") or [])
    updated = existing.get("updated_utc") or "unknown"
    existing["error"] = message
    outdir = os.path.dirname(OUTFILE)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    with open(OUTFILE, "w", encoding="utf-8") as output_file:
        json.dump(existing, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")
    print(
        f"{message} Keeping existing {OUTFILE} with {count} "
        f"activities from {updated} and marking it stale."
    )
    return True


def write_failure_payload(message: str) -> None:
    print(message)
    if not preserve_existing_payload(message):
        write_payload([], error=message)


def main() -> None:
    try:
        if not CLIENT_ID or not CLIENT_SECRET:
            raise StravaConfigurationError(
                "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET."
            )
        refresh_tokens = load_refresh_token_candidates()
        overrides = load_exertion_overrides()
        existing_payload = read_existing_payload() or {}
        existing_activities = existing_payload.get("activities") or []
        access_token = ""
        next_refresh_token = None
        refresh_token = ""
        activities: list[dict] = []
        for token_index, candidate_refresh_token in enumerate(refresh_tokens):
            refresh_token = candidate_refresh_token
            try:
                access_token, next_refresh_token = refresh_access_token(
                    candidate_refresh_token
                )
                activities = get_all_activities(
                    access_token, after=get_recent_activity_cutoff()
                )
                break
            except requests.HTTPError as error:
                if can_retry_with_next_refresh_token(
                    error, token_index, len(refresh_tokens)
                ):
                    print(
                        "Strava token candidate failed; retrying the next "
                        "configured refresh token."
                    )
                    continue
                raise
        if next_refresh_token and next_refresh_token != refresh_token:
            persist_refresh_token(next_refresh_token)
        slimmed: list[dict] = []
        detail_requests = 0
        detail_requests_enabled = DETAIL_REQUEST_LIMIT > 0
        for activity in activities:
            enriched = activity
            if detail_requests_enabled and activity_needs_details(activity):
                if detail_requests >= DETAIL_REQUEST_LIMIT:
                    detail_requests_enabled = False
                    print(
                        "Reached Strava detail request limit; publishing "
                        "remaining activities from summary data."
                    )
                else:
                    try:
                        enriched = enrich_activity(activity, access_token)
                        detail_requests += 1
                    except requests.HTTPError as error:
                        status_code = (
                            error.response.status_code
                            if error.response is not None
                            else None
                        )
                        if status_code == 429:
                            detail_requests_enabled = False
                            print(
                                "Strava detail rate limit reached; publishing "
                                "remaining activities from summary data."
                            )
                        else:
                            print(
                                "Skipping Strava activity "
                                f"{activity.get('id')} details after HTTP "
                                f"{status_code or 'error'}."
                            )
                    except requests.RequestException as error:
                        print(
                            "Skipping Strava activity "
                            f"{activity.get('id')} details after request error: {error}."
                        )
            payload = slim(enriched)
            payload["estimated_exertion"] = estimate_exertion(
                payload.get("avg_hr"),
                payload.get("max_hr"),
                payload.get("elapsed_time_min"),
            )
            override = overrides.get(str(payload.get("id")))
            payload["exertion"] = override.get("exertion") if override else None
            payload["faulty"] = bool(override.get("faulty")) if override else False
            slimmed.append(payload)
        merged = merge_activities(existing_activities, slimmed)
        write_payload(merged)
        print(
            f"Published {len(merged)} Strava activities "
            f"({len(slimmed)} fetched from the last {LOOKBACK_DAYS} days, "
            f"{detail_requests} detail requests)."
        )
    except requests.HTTPError as error:
        status_code = get_http_status_code(error)
        if status_code in {401, 403}:
            message = (
                f"Strava authorization failed: {format_http_error(error)}. "
                "Verify that the refresh token has activity:read_all scope "
                "and that the STRAVA_* secrets are valid."
            )
            write_failure_payload(message)
            raise SystemExit(1) from error
        message = f"HTTP error while fetching Strava data: {format_http_error(error)}"
        write_failure_payload(message)
        raise SystemExit(1) from error
    except StravaConfigurationError as error:
        message = str(error)
        write_failure_payload(message)
        raise SystemExit(1) from error
    except (requests.RequestException, json.JSONDecodeError, KeyError, Exception) as error:
        message = f"Unexpected error while fetching Strava data: {error}"
        write_failure_payload(message)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
