"""Button capture/API integration tests; no hardware, weights or network needed."""
import asyncio
import json
import os
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import cv2
import numpy as np

from backend.cameras import CameraMonitor
from backend.config import Settings
from backend.main import create_app
from backend.service import ServiceError


async def request(app, method, path, key=None):
    messages = []
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.sleep(60)

    async def send(message):
        messages.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
               "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
               "query_string": b"", "headers": [(b"x-api-key", key.encode())] if key else [],
               "client": ("127.0.0.1", 1), "server": ("test", 80), "root_path": ""}
    # Poll the task with a bounded timeout: restricted sandboxes may suppress
    # the loop's cross-thread socket wakeup from synchronous FastAPI handlers.
    task = asyncio.create_task(app(scope, receive, send))
    deadline = time.monotonic() + 5
    while not task.done() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    if not task.done():
        task.cancel()
        raise AssertionError("ASGI request exceeded five seconds")
    await task
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, json.loads(body)


class CameraScanTests(unittest.TestCase):
    def test_api_auth_disabled_busy_and_scan_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(data_dir=Path(directory), api_key="test-key")
            app = create_app(settings, service=object())
            self.assertEqual(asyncio.run(request(app, "POST", "/v1/cameras/scan"))[0], 401)
            self.assertEqual(asyncio.run(request(app, "POST", "/v1/cameras/scan", "test-key"))[0], 503)
            monitor = CameraMonitor(object())
            monitor._set(status="watching")
            app.state.camera_monitor = monitor
            status, job = asyncio.run(request(app, "POST", "/v1/cameras/scan", "test-key"))
            self.assertEqual(status, 202)
            self.assertEqual(asyncio.run(request(app, "POST", "/v1/cameras/scan", "test-key"))[0], 409)
            status, polled = asyncio.run(request(app, "GET", f'/v1/cameras/scans/{job["scan_id"]}', "test-key"))
            self.assertEqual(status, 200)
            self.assertEqual(polled, job)
            self.assertEqual(asyncio.run(request(app, "GET", "/v1/cameras/scans/missing", "test-key"))[0], 404)

    def test_fresh_two_camera_capture_and_single_inference(self):
        self.check_camera_capture("0,1", [0, 1])

    def test_explicit_single_camera_capture(self):
        self.check_camera_capture("1", [1])

    def test_single_camera_fallback(self):
        for unavailable in (0, 1):
            with self.subTest(unavailable=unavailable):
                self.check_camera_capture("0,1", [1 - unavailable], unavailable=unavailable)

    def test_no_available_cameras(self):
        with patch.dict(os.environ, {"RETURNSCAN_CAMERA_IDS": "0,1"}), patch.dict(
            'sys.modules', {"picamera2": types.SimpleNamespace(
                Picamera2=Mock(side_effect=RuntimeError("unavailable")))}
        ):
            monitor = CameraMonitor(object())
            with self.assertLogs("backend.cameras", level="WARNING"):
                monitor._run()
            self.assertEqual(monitor.snapshot()["status"], "error")
            self.assertEqual(monitor.snapshot()["camera_ids"], ())
            with self.assertRaises(ServiceError) as error:
                monitor.request_scan()
            self.assertEqual(error.exception.status_code, 503)

    def check_camera_capture(self, configured_ids, expected_ids, unavailable=None):
        entered = threading.Event()
        release = threading.Event()
        calls = []
        cameras = []

        class Camera:
            def __init__(self, number):
                self.number = number
                self.closed = False
                cameras.append(self)

            def create_video_configuration(self, **kwargs):
                return kwargs

            def configure(self, config):
                pass

            def start(self):
                if self.number == unavailable:
                    raise RuntimeError("unavailable")

            def capture_array(self, stream):
                return np.full((96, 128, 3), 40 + 80 * self.number, dtype=np.uint8)

            def close(self):
                self.closed = True

        class Verifier:
            def verify(self, image, **kwargs):
                calls.append(cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR).mean())
                entered.set()
                release.wait(5)
                return {"request_id": str(len(calls))}

        with patch.dict(os.environ, {"RETURNSCAN_CAMERA_IDS": configured_ids, "RETURNSCAN_CAMERA_AUTO_SCAN": "0", "RETURNSCAN_CAMERA_INTERVAL_SECONDS": "0.02"}), patch.dict('sys.modules', {"picamera2": types.SimpleNamespace(Picamera2=Camera)}):
            monitor = CameraMonitor(Verifier())
            monitor.start()
            try:
                deadline = time.monotonic() + 8
                while monitor.snapshot()["status"] == "starting" and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(list(monitor.snapshot()["camera_ids"]), expected_ids)
                job = monitor.request_scan()
                self.assertTrue(entered.wait(5))
                with self.assertRaises(ServiceError) as error:
                    monitor.request_scan()
                self.assertEqual(error.exception.status_code, 409)
                release.set()
                while monitor.scan_status(job["scan_id"])["status"] != "complete" and time.monotonic() < deadline:
                    time.sleep(0.02)
                result = monitor.scan_status(job["scan_id"])
                self.assertEqual(result["status"], "complete")
                self.assertEqual([v["camera_id"] for v in result["results"]], expected_ids)
                self.assertEqual(len(calls), len(expected_ids))
                for value, camera_id in zip(calls, expected_ids):
                    self.assertAlmostEqual(value, 40 + 80 * camera_id, delta=2)
            finally:
                release.set()
                monitor.stop()
            self.assertTrue(all(camera.closed for camera in cameras))


if __name__ == "__main__":
    unittest.main()
