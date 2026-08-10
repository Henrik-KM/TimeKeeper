import math
import statistics

SCORE_MODEL_VERSION = 2
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
    "canoeing",
    "ebikeride",
    "elliptical",
    "gravelride",
    "handcycle",
    "hike",
    "iceskate",
    "inlineskate",
    "kayaking",
    "kitesurf",
    "mountainbikeride",
    "nordicski",
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
    "stairstepper",
    "standuppaddling",
    "surfing",
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


def get_effective_active_minutes(activity: dict, modality: str) -> float:
    moving = max(0.0, float(activity.get("moving_time") or 0) / 60.0)
    elapsed = max(0.0, float(activity.get("elapsed_time") or 0) / 60.0)
    if modality == "cardio":
        return min(360.0, moving or elapsed)
    if moving >= 5.0:
        return min(360.0, moving)
    return min(360.0, elapsed or moving)


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
    return max(185.0, observed[percentile_index])


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
        if 0 < numeric_times[index + 1] - numeric_times[index] <= 30
    ]
    default_step = statistics.median(positive_steps) if positive_steps else 1.0
    durations: list[float] = []
    for index, value in enumerate(numeric_times):
        if index + 1 < len(numeric_times):
            step = numeric_times[index + 1] - value
        else:
            step = default_step
        durations.append(min(30.0, max(0.0, step)))
    return durations


def find_stable_cardio_samples(
    heart_rates: list[float | None],
    durations: list[float],
    hr_reference: float,
    minimum_minutes: float,
) -> set[int]:
    stable_indices: set[int] = set()
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
        if duration >= minimum_minutes * 60 and len(values) >= 2:
            variability = statistics.pstdev(values)
            if variability <= 12:
                stable_indices.update(segment)
        segment.clear()

    for index, heart_rate in enumerate(heart_rates):
        if heart_rate is not None and heart_rate / hr_reference >= 0.65:
            segment.append(index)
        else:
            close_segment()
    close_segment()
    return stable_indices


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
    has_movement_signal = any(
        isinstance(stream, list) and bool(stream)
        for stream in (moving_stream, cadence_stream, watts_stream, velocity_stream)
    )
    if not has_hr and not has_movement_signal:
        return None

    modality = get_modality(activity)
    heart_rates = [
        numeric_stream_value(heartrate_stream, index)
        for index in range(sample_count)
    ]
    stable_cardio = find_stable_cardio_samples(
        heart_rates,
        durations,
        hr_reference,
        6.0 if modality == "hybrid" else 8.0,
    )

    density_active_flags: list[bool] = []
    cardio_flags: list[bool] = []
    for index in range(sample_count):
        heart_rate = heart_rates[index]
        moving_value = safe_stream_value(moving_stream, index)
        moving = bool(moving_value) if moving_value is not None else False
        cadence = numeric_stream_value(cadence_stream, index) or 0.0
        watts = numeric_stream_value(watts_stream, index) or 0.0
        velocity = numeric_stream_value(velocity_stream, index) or 0.0
        explicit_locomotion = bool(
            (moving and velocity >= 0.5)
            or cadence >= 20
            or watts >= 35
            or velocity >= 0.8
        )
        hr_work = bool(
            heart_rate is not None and heart_rate / hr_reference >= 0.62
        )
        hr_cardio_active = bool(
            heart_rate is not None and heart_rate / hr_reference >= 0.45
        )
        stable = index in stable_cardio

        if modality in {"strength", "hybrid", "mobility"}:
            density_active = explicit_locomotion or hr_work or (not has_hr and moving)
        else:
            density_active = explicit_locomotion or moving or hr_cardio_active

        if modality == "mobility":
            cardio = False
        else:
            cardio = explicit_locomotion or (
                stable and modality in {"cardio", "hybrid"}
            )

        density_active_flags.append(density_active)
        cardio_flags.append(cardio)

    if modality == "cardio":
        non_cardio_active_seconds = sum(
            duration
            for duration, active, cardio in zip(
                durations, density_active_flags, cardio_flags, strict=True
            )
            if active and not cardio
        )
        if non_cardio_active_seconds < 8 * 60:
            cardio_flags = list(density_active_flags)

    strength_flags = [False] * sample_count
    if modality in {"strength", "hybrid", "mobility"}:
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
            strength_flags[index] = bool(
                density_active_flags[index] and not cardio_flags[index]
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
