import math
import statistics

SCORE_MODEL_VERSION = 2
STREAM_FEATURE_VERSION = 2
DEFAULT_MAX_HR = 190.0

STRENGTH_TYPES = {"weighttraining"}
HYBRID_TYPES = {
    "crossfit",
    "highintensityintervaltraining",
    "hiit",
    "workout",
}
MOBILITY_TYPES = {"pilates", "yoga"}
CARDIO_TYPES = {
    "alpineski",
    "backcountryski",
    "badminton",
    "canoeing",
    "ebikeride",
    "elliptical",
    "golf",
    "gravelride",
    "handcycle",
    "hike",
    "iceskate",
    "inlineskate",
    "kayaking",
    "kitesurf",
    "mountainbikeride",
    "nordicski",
    "pickleball",
    "racquetball",
    "ride",
    "rockclimbing",
    "rollerski",
    "rowing",
    "run",
    "sail",
    "skateboard",
    "snowboard",
    "snowshoe",
    "soccer",
    "squash",
    "stairstepper",
    "standuppaddling",
    "surfing",
    "tabletennis",
    "tennis",
    "swim",
    "trailrun",
    "velomobile",
    "virtualride",
    "virtualrow",
    "virtualrun",
    "walk",
    "watersport",
    "wheelchair",
    "windsurf",
}


def normalize_type(value: object) -> str:
    normalized = str(value or "").lower()
    return "".join(character for character in normalized if character.isalnum())


def get_modality(activity: dict) -> str:
    activity_type = normalize_type(
        activity.get("sport_type") or activity.get("type")
    )
    if activity_type in STRENGTH_TYPES:
        return "strength"
    if activity_type in HYBRID_TYPES:
        return "hybrid"
    if activity_type in MOBILITY_TYPES:
        return "mobility"
    if activity_type in CARDIO_TYPES:
        return "cardio"
    if (activity.get("distance") or 0) > 0:
        return "cardio"
    if (activity.get("average_speed") or 0) > 0:
        return "cardio"
    return "strength"


def parse_non_negative_number(value: object) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric) or numeric < 0:
        return None
    return numeric


def estimate_cardio_seconds_from_distance(activity: dict) -> float:
    distance = parse_non_negative_number(activity.get("distance"))
    average_speed = parse_non_negative_number(activity.get("average_speed"))
    if not distance or not average_speed:
        return 0.0
    estimate = distance / average_speed
    return estimate if math.isfinite(estimate) and estimate > 0 else 0.0


def get_effective_active_minutes(activity: dict, modality: str) -> float:
    moving_seconds = parse_non_negative_number(activity.get("moving_time"))
    elapsed_seconds = parse_non_negative_number(activity.get("elapsed_time"))
    has_moving_time = "moving_time" in activity and moving_seconds is not None

    if modality == "cardio":
        if has_moving_time:
            active_seconds = moving_seconds
        else:
            active_seconds = estimate_cardio_seconds_from_distance(activity)
        if elapsed_seconds is not None:
            active_seconds = min(active_seconds, elapsed_seconds)
        return min(360.0, active_seconds / 60.0)

    moving = (moving_seconds or 0.0) / 60.0
    elapsed = (elapsed_seconds or 0.0) / 60.0
    if elapsed > 0:
        if not has_moving_time or moving < 5.0:
            return min(360.0, elapsed)
        return min(
            360.0,
            elapsed,
            max(moving + 30.0, moving * 1.5, 15.0),
        )
    return min(360.0, moving)


def estimate_hr_reference(activities: list[dict], existing: list[dict]) -> float:
    observed: list[float] = []
    for activity in [*activities, *existing]:
        value = activity.get("max_heartrate")
        if value is None:
            value = activity.get("max_hr")
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if 100 <= numeric <= 240:
            observed.append(numeric)
    if not observed:
        return DEFAULT_MAX_HR
    observed.sort()
    percentile_index = min(
        len(observed) - 1, max(0, math.ceil(0.95 * len(observed)) - 1)
    )
    return max(DEFAULT_MAX_HR, observed[percentile_index])


def get_hr_zone(heart_rate: float | None, hr_reference: float) -> int:
    if heart_rate is None or not math.isfinite(heart_rate) or heart_rate <= 0:
        return 1
    ratio = heart_rate / hr_reference
    if ratio < 0.60:
        return 0
    if ratio < 0.70:
        return 1
    if ratio < 0.80:
        return 2
    if ratio < 0.90:
        return 3
    return 4


def get_summary_score_features(activity: dict, hr_reference: float) -> dict:
    modality = get_modality(activity)
    active_minutes = get_effective_active_minutes(activity, modality)
    zone_minutes = [0.0, 0.0, 0.0, 0.0, 0.0]
    average_hr = activity.get("average_heartrate")
    if average_hr is None:
        average_hr = activity.get("avg_hr")
    try:
        average_hr_value = float(average_hr) if average_hr is not None else None
    except (TypeError, ValueError):
        average_hr_value = None
    strength_minutes = 0.0
    strength_density = 0.0
    strength_factor = 1.0

    if modality == "cardio":
        zone_minutes[get_hr_zone(average_hr_value, hr_reference)] = active_minutes
    elif modality == "hybrid":
        strength_minutes = active_minutes * 0.75
        zone_minutes[get_hr_zone(average_hr_value, hr_reference)] = (
            active_minutes * 0.25
        )
        strength_density = 0.25
    else:
        strength_minutes = active_minutes
        if modality == "mobility":
            strength_density = 0.2
            strength_factor = 0.65

    cardio_minutes = sum(zone_minutes)
    return {
        "version": SCORE_MODEL_VERSION,
        "feature_version": STREAM_FEATURE_VERSION,
        "source": "summary",
        "active_minutes": round(strength_minutes + cardio_minutes, 2),
        "effective_active_minutes": round(strength_minutes + cardio_minutes, 2),
        "strength_minutes": round(strength_minutes, 2),
        "strength_block_minutes": round(strength_minutes, 2),
        "cardio_zone_minutes": [round(value, 2) for value in zone_minutes],
        "cardio_block_minutes": round(cardio_minutes, 2),
        "strength_density": round(strength_density, 3),
        "strength_factor": strength_factor,
        "work_recovery_cycles": 0,
        "hr_max_reference": round(hr_reference, 1),
    }


def safe_stream_value(values: list | None, index: int) -> object | None:
    if not isinstance(values, list) or index >= len(values):
        return None
    return values[index]


def numeric_stream_value(values: list | None, index: int) -> float | None:
    value = safe_stream_value(values, index)
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def get_sample_durations(times: list) -> list[float]:
    numeric_times: list[float] = []
    for index, value in enumerate(times):
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            numeric = float(index)
        numeric_times.append(numeric)
    positive_steps = [
        numeric_times[index + 1] - numeric_times[index]
        for index in range(len(numeric_times) - 1)
        if 0 < numeric_times[index + 1] - numeric_times[index] <= 300
    ]
    default_step = statistics.median(positive_steps) if positive_steps else 1.0
    maximum_step = max(30.0, min(300.0, default_step * 3.0))
    durations: list[float] = []
    for index, value in enumerate(numeric_times):
        if index + 1 >= len(numeric_times):
            durations.append(0.0)
            continue
        step = numeric_times[index + 1] - value
        durations.append(min(maximum_step, max(0.0, step)))
    return durations


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * min(1.0, max(0.0, fraction))
    lower_index = math.floor(position)
    upper_index = math.ceil(position)
    if lower_index == upper_index:
        return ordered[lower_index]
    weight = position - lower_index
    return (
        ordered[lower_index] * (1.0 - weight)
        + ordered[upper_index] * weight
    )


def count_work_recovery_cycles(values: list[float]) -> int:
    if len(values) < 4:
        return 0
    low = percentile(values, 0.30)
    high = percentile(values, 0.70)
    if high - low < 10.0:
        return 0

    cycles = 0
    state = "seek_low"
    for value in values:
        if state == "seek_low":
            if value <= low:
                state = "seek_high"
        elif value >= high:
            cycles += 1
            state = "seek_low"
    return cycles


def find_strength_like_samples(
    locomotion_flags: list[bool],
    heart_rates: list[float | None],
    durations: list[float],
    hr_reference: float,
    minimum_minutes: float = 8.0,
) -> set[int]:
    strength_indices: set[int] = set()
    segment: list[int] = []

    def close_segment() -> None:
        if not segment:
            return
        duration = sum(durations[index] for index in segment)
        values = [
            heart_rates[index]
            for index in segment
            if heart_rates[index] is not None
        ]
        high_enough = any(value / hr_reference >= 0.62 for value in values)
        if (
            duration >= minimum_minutes * 60
            and high_enough
            and count_work_recovery_cycles(values) >= 2
        ):
            strength_indices.update(segment)
        segment.clear()

    for index, heart_rate in enumerate(heart_rates):
        candidate = bool(
            not locomotion_flags[index]
            and heart_rate is not None
            and heart_rate / hr_reference >= 0.45
        )
        if candidate:
            segment.append(index)
        else:
            close_segment()
    close_segment()
    return strength_indices


def derive_stream_score_features(
    activity: dict, streams: dict[str, list], hr_reference: float
) -> dict | None:
    times = streams.get("time")
    if not isinstance(times, list) or len(times) < 2:
        return None
    durations = get_sample_durations(times)
    sample_count = len(durations)
    heartrate_stream = streams.get("heartrate")
    moving_stream = streams.get("moving")
    cadence_stream = streams.get("cadence")
    watts_stream = streams.get("watts")
    velocity_stream = streams.get("velocity_smooth")

    has_hr = isinstance(heartrate_stream, list) and bool(heartrate_stream)
    has_moving_stream = isinstance(moving_stream, list) and bool(moving_stream)
    has_detailed_stream = any(
        isinstance(stream, list) and bool(stream)
        for stream in (cadence_stream, watts_stream, velocity_stream)
    )
    if not has_hr and not has_moving_stream and not has_detailed_stream:
        return None

    modality = get_modality(activity)
    heart_rates = [
        numeric_stream_value(heartrate_stream, index)
        for index in range(sample_count)
    ]
    moving_flags = [
        bool(safe_stream_value(moving_stream, index))
        for index in range(sample_count)
    ]
    detailed_locomotion_flags = []
    for index in range(sample_count):
        cadence = numeric_stream_value(cadence_stream, index) or 0.0
        watts = numeric_stream_value(watts_stream, index) or 0.0
        velocity = numeric_stream_value(velocity_stream, index) or 0.0
        detailed_locomotion_flags.append(
            bool(cadence >= 20 or watts >= 35 or velocity >= 0.8)
        )
    has_meaningful_detailed_motion = any(detailed_locomotion_flags)
    has_movement_signal = has_moving_stream or has_meaningful_detailed_motion
    if modality == "hybrid" and not has_movement_signal:
        return None

    density_active_flags: list[bool] = []
    locomotion_flags: list[bool] = []
    for index in range(sample_count):
        heart_rate = heart_rates[index]
        moving = moving_flags[index]
        detailed_locomotion = detailed_locomotion_flags[index]
        if modality == "cardio":
            locomotion = (
                detailed_locomotion
                if has_meaningful_detailed_motion
                else moving
            )
        else:
            # A generic moving flag is too permissive for strength-tagged
            # activities. Require cadence, power or velocity evidence before
            # assigning any part of them to cardio.
            locomotion = detailed_locomotion

        hr_work = bool(
            heart_rate is not None and heart_rate / hr_reference >= 0.62
        )
        hr_cardio_active = bool(
            heart_rate is not None and heart_rate / hr_reference >= 0.45
        )
        if modality in {"strength", "hybrid", "mobility"}:
            density_active = locomotion or hr_work or (not has_hr and moving)
        else:
            density_active = locomotion or hr_cardio_active

        locomotion_flags.append(locomotion)
        density_active_flags.append(density_active)

    has_affirmative_locomotion = any(locomotion_flags)
    detected_strength = (
        find_strength_like_samples(
            locomotion_flags, heart_rates, durations, hr_reference
        )
        if modality == "cardio" and has_movement_signal and has_hr
        else set()
    )

    cardio_flags: list[bool] = []
    strength_flags: list[bool] = [False] * sample_count
    if modality in {"strength", "hybrid", "mobility"}:
        cardio_flags = [
            locomotion and modality != "mobility"
            for locomotion in locomotion_flags
        ]
        evidence_indices = [
            index
            for index in range(sample_count)
            if density_active_flags[index] and not cardio_flags[index]
        ]
        if evidence_indices:
            first_strength = evidence_indices[0]
            last_strength = evidence_indices[-1]
            for index in range(first_strength, last_strength + 1):
                strength_flags[index] = not cardio_flags[index]
    else:
        for index in range(sample_count):
            strength_flags[index] = index in detected_strength
            cardio_flags.append(
                bool(
                    not strength_flags[index]
                    and (
                        locomotion_flags[index]
                        or (
                            not has_affirmative_locomotion
                            and density_active_flags[index]
                        )
                    )
                )
            )
            if strength_flags[index]:
                heart_rate = heart_rates[index]
                density_active_flags[index] = bool(
                    heart_rate is not None
                    and heart_rate / hr_reference >= 0.62
                )

    zone_seconds = [0.0, 0.0, 0.0, 0.0, 0.0]
    cardio_seconds = 0.0
    strength_seconds = 0.0
    active_strength_seconds = 0.0
    strength_indices: list[int] = []
    for index, duration in enumerate(durations):
        if duration <= 0:
            continue
        if cardio_flags[index] and density_active_flags[index]:
            zone = get_hr_zone(heart_rates[index], hr_reference)
            zone_seconds[zone] += duration
            cardio_seconds += duration
        elif strength_flags[index]:
            strength_seconds += duration
            strength_indices.append(index)
            if density_active_flags[index]:
                active_strength_seconds += duration

    if strength_seconds <= 0 and cardio_seconds <= 0:
        return None

    strength_density = (
        active_strength_seconds / strength_seconds if strength_seconds > 0 else 0.0
    )

    cycles = 0
    cycle_state = "recovery"
    for index in strength_indices:
        heart_rate = heart_rates[index]
        if heart_rate is None:
            continue
        ratio = heart_rate / hr_reference
        if cycle_state == "recovery" and ratio >= 0.68:
            cycles += 1
            cycle_state = "work"
        elif cycle_state == "work" and ratio <= 0.58:
            cycle_state = "recovery"

    strength_factor = 0.65 if modality == "mobility" else 1.0
    strength_minutes = strength_seconds / 60.0
    cardio_minutes = cardio_seconds / 60.0
    effective_minutes = strength_minutes + cardio_minutes
    return {
        "version": SCORE_MODEL_VERSION,
        "feature_version": STREAM_FEATURE_VERSION,
        "source": "streams",
        "active_minutes": round(effective_minutes, 2),
        "effective_active_minutes": round(effective_minutes, 2),
        "strength_minutes": round(strength_minutes, 2),
        "strength_block_minutes": round(strength_minutes, 2),
        "cardio_zone_minutes": [
            round(seconds / 60.0, 2) for seconds in zone_seconds
        ],
        "cardio_block_minutes": round(cardio_minutes, 2),
        "strength_density": round(min(1.0, max(0.0, strength_density)), 3),
        "strength_factor": strength_factor,
        "work_recovery_cycles": cycles,
        "hr_max_reference": round(hr_reference, 1),
    }
