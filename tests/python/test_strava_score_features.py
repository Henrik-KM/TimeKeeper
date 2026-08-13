import unittest

from scripts.fetch_strava import has_final_score_features
from scripts.strava_score_features import (
    derive_stream_score_features,
    get_effective_active_minutes,
)


class StravaScoreFeaturesTest(unittest.TestCase):
    def test_stream_cache_retries_deferred_summary_features(self):
        complete = {
            "score_features": {
                "version": 2,
                "feature_version": 2,
                "source": "streams",
                "stream_status": "complete",
            }
        }
        deferred = {
            "score_features": {
                "version": 2,
                "feature_version": 2,
                "source": "summary",
                "stream_status": "deferred",
            }
        }
        unavailable = {
            "score_features": {
                "version": 2,
                "feature_version": 2,
                "source": "summary",
                "stream_status": "unavailable",
            }
        }
        stale = {
            "score_features": {
                "version": 2,
                "source": "streams",
                "stream_status": "complete",
            }
        }
        self.assertTrue(has_final_score_features(complete))
        self.assertFalse(has_final_score_features(deferred))
        self.assertTrue(has_final_score_features(unavailable))
        self.assertFalse(has_final_score_features(stale))

    def test_zero_moving_time_does_not_fall_back_to_elapsed_cardio_time(self):
        minutes = get_effective_active_minutes(
            {
                "moving_time": 0,
                "elapsed_time": 75 * 60,
                "distance": 10_000,
                "average_speed": 20 / 3.6,
            },
            "cardio",
        )
        self.assertEqual(minutes, 0)

    def test_missing_moving_time_uses_distance_and_speed_conservatively(self):
        minutes = get_effective_active_minutes(
            {
                "elapsed_time": 90 * 60,
                "distance": 10_000,
                "average_speed": 20 / 3.6,
            },
            "cardio",
        )
        self.assertAlmostEqual(minutes, 30)

    def test_cardio_inside_strength_is_detected_from_locomotion(self):
        streams = self._strength_with_cardio_warmup()
        features = derive_stream_score_features(
            {"sport_type": "WeightTraining", "type": "WeightTraining"},
            streams,
            190,
        )
        self.assertIsNotNone(features)
        self.assertGreaterEqual(features["cardio_block_minutes"], 9)
        self.assertGreaterEqual(features["strength_block_minutes"], 45)

    def test_strength_inside_cardio_requires_repeated_work_recovery(self):
        streams = self._ride_with_strength_block()
        features = derive_stream_score_features(
            {"sport_type": "Ride", "type": "Ride"}, streams, 190
        )
        self.assertIsNotNone(features)
        self.assertGreaterEqual(features["strength_block_minutes"], 10)
        self.assertGreaterEqual(features["cardio_block_minutes"], 35)
        self.assertGreaterEqual(features["work_recovery_cycles"], 2)
        self.assertLess(features["strength_density"], 0.6)

    def test_monotonic_cardio_pause_is_not_invented_as_strength(self):
        streams = self._ride_with_monotonic_pause()
        features = derive_stream_score_features(
            {"sport_type": "Ride", "type": "Ride"}, streams, 190
        )
        self.assertIsNotNone(features)
        self.assertEqual(features["strength_block_minutes"], 0)
        self.assertGreaterEqual(features["cardio_block_minutes"], 34)
        self.assertLessEqual(features["cardio_block_minutes"], 36)

    def test_hr_only_cardio_remains_cardio(self):
        times = list(range(0, 30 * 60, 10))
        features = derive_stream_score_features(
            {"sport_type": "Run", "type": "Run"},
            {"time": times, "heartrate": [145] * len(times)},
            190,
        )
        self.assertIsNotNone(features)
        self.assertEqual(features["strength_block_minutes"], 0)
        self.assertGreaterEqual(features["cardio_block_minutes"], 29)

    def test_indoor_ride_uses_moving_stream_when_velocity_is_zero(self):
        times = list(range(0, 30 * 60, 10))
        features = derive_stream_score_features(
            {"sport_type": "Ride", "type": "Ride"},
            {
                "time": times,
                "heartrate": [145] * len(times),
                "moving": [True] * len(times),
                "velocity_smooth": [0.0] * len(times),
            },
            190,
        )
        self.assertIsNotNone(features)
        self.assertEqual(features["strength_block_minutes"], 0)
        self.assertGreaterEqual(features["cardio_block_minutes"], 29)

    @staticmethod
    def _strength_with_cardio_warmup():
        times = list(range(0, 60 * 60, 10))
        heart_rate = []
        moving = []
        cadence = []
        velocity = []
        for second in times:
            if second < 10 * 60:
                heart_rate.append(140)
                moving.append(True)
                cadence.append(80)
                velocity.append(4.0)
            else:
                phase = (second - 10 * 60) % 180
                heart_rate.append(135 if phase < 60 else 100)
                moving.append(False)
                cadence.append(0)
                velocity.append(0.0)
        return {
            "time": times,
            "heartrate": heart_rate,
            "moving": moving,
            "cadence": cadence,
            "velocity_smooth": velocity,
        }

    @staticmethod
    def _ride_with_strength_block():
        times = list(range(0, 50 * 60, 10))
        heart_rate = []
        moving = []
        cadence = []
        velocity = []
        for second in times:
            if 20 * 60 <= second < 32 * 60:
                phase = (second - 20 * 60) % 180
                heart_rate.append(135 if phase < 60 else 100)
                moving.append(False)
                cadence.append(0)
                velocity.append(0.0)
            else:
                heart_rate.append(145)
                moving.append(True)
                cadence.append(85)
                velocity.append(5.0)
        return {
            "time": times,
            "heartrate": heart_rate,
            "moving": moving,
            "cadence": cadence,
            "velocity_smooth": velocity,
        }

    @staticmethod
    def _ride_with_monotonic_pause():
        times = list(range(0, 50 * 60, 10))
        heart_rate = []
        moving = []
        cadence = []
        velocity = []
        for second in times:
            if 20 * 60 <= second < 35 * 60:
                fraction = (second - 20 * 60) / (15 * 60)
                heart_rate.append(145 - 50 * fraction)
                moving.append(False)
                cadence.append(0)
                velocity.append(0.0)
            else:
                heart_rate.append(145)
                moving.append(True)
                cadence.append(85)
                velocity.append(5.0)
        return {
            "time": times,
            "heartrate": heart_rate,
            "moving": moving,
            "cadence": cadence,
            "velocity_smooth": velocity,
        }


if __name__ == "__main__":
    unittest.main()
