"""Camera state tests run without camera hardware, models or third-party packages."""
import unittest

from backend.cameras import CameraMonitor, StillnessGate


class StillnessTests(unittest.TestCase):
    def test_once_per_still_scene(self):
        gate = StillnessGate(settle_seconds=2)
        self.assertFalse(gate.update(False, 0))
        self.assertFalse(gate.update(False, 1))
        self.assertTrue(gate.update(False, 2))
        self.assertFalse(gate.update(False, 20))
        self.assertFalse(gate.update(True, 21))
        self.assertFalse(gate.update(True, 22))
        self.assertFalse(gate.update(False, 23))
        self.assertTrue(gate.update(False, 25))

    def test_motion_restarts_settling_and_noise_does_not_rearm(self):
        gate = StillnessGate(settle_seconds=2)
        gate.update(False, 0)
        gate.update(True, 1)
        self.assertFalse(gate.update(False, 2))
        self.assertFalse(gate.update(False, 3))
        self.assertTrue(gate.update(False, 4))
        gate.update(True, 5)
        gate.update(False, 5.1)
        self.assertFalse(gate.update(False, 10))

    def test_busy_worker_preserves_pending_scene(self):
        gate = StillnessGate(settle_seconds=2, armed=False)
        gate.update(True, 0, allow_trigger=False)
        gate.update(True, 1, allow_trigger=False)
        self.assertFalse(gate.update(False, 2, allow_trigger=False))
        self.assertFalse(gate.update(False, 5, allow_trigger=False))
        self.assertTrue(gate.update(False, 6))
        self.assertFalse(gate.update(False, 7))

    def test_partial_failure_does_not_discard_other_view(self):
        class Verifier:
            def verify(self, image, **kwargs):
                if image == b"bad":
                    raise ValueError("unreadable")
                return {"request_id": "test"}

        monitor = CameraMonitor(Verifier())
        with self.assertLogs("backend.cameras", level="ERROR"):
            result = monitor._verify([b"bad", b"good"], 123)
        self.assertEqual(result["captured_at"], 123)
        self.assertEqual(result["results"][0]["error"], "unreadable")
        self.assertEqual(result["results"][1]["result"]["request_id"], "test")


if __name__ == "__main__":
    unittest.main()
