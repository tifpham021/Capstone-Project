"""Opt-in stillness capture from one or two Raspberry Pi cameras."""
from __future__ import annotations

import copy
import logging
import math
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

LOG = logging.getLogger(__name__)


@dataclass
class StillnessGate:
    """One trigger per quiet scene; sustained motion rearms the gate."""

    settle_seconds: float = 2.0
    rearm_seconds: float = 0.3
    quiet_since: float | None = None
    motion_since: float | None = None
    armed: bool = True

    def update(self, moving: bool, now: float, allow_trigger: bool = True) -> bool:
        if moving:
            self.quiet_since = None
            if self.motion_since is None:
                self.motion_since = now
            if now - self.motion_since >= self.rearm_seconds:
                self.armed = True
            return False
        self.motion_since = None
        if self.quiet_since is None:
            self.quiet_since = now
        if allow_trigger and self.armed and now - self.quiet_since >= self.settle_seconds:
            self.armed = False
            return True
        return False


class CameraMonitor:
    def __init__(self, verifier):
        self.verifier = verifier
        self.ids = tuple(int(x) for x in os.getenv("RETURNSCAN_CAMERA_IDS", "0,1").split(","))
        if not 1 <= len(self.ids) <= 2 or len(set(self.ids)) != len(self.ids) or min(self.ids) < 0:
            raise ValueError("RETURNSCAN_CAMERA_IDS must contain one or two distinct nonnegative IDs")
        self.settle = self._number("RETURNSCAN_CAMERA_SETTLE_SECONDS", 2.0)
        self.interval = self._number("RETURNSCAN_CAMERA_INTERVAL_SECONDS", 0.2)
        self.fraction = self._number("RETURNSCAN_CAMERA_MOTION_FRACTION", 0.015)
        if self.fraction >= 1:
            raise ValueError("Camera motion fraction must be less than 1")
        self.local_backend = os.getenv("RETURNSCAN_CAMERA_LOCAL_BACKEND", "sift")
        if self.local_backend not in {"auto", "sift", "aliked"}:
            raise ValueError("Invalid camera local backend")
        self.expected = os.getenv("RETURNSCAN_CAMERA_PRODUCT_ID") or None
        self.auto_scan = os.getenv("RETURNSCAN_CAMERA_AUTO_SCAN", "1") == "1"
        self.pending_scan = None
        self.busy = False
        self.scans = {}
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.state = {"enabled": True, "status": "starting", "camera_ids": self.ids,
                      "latest": None, "error": None}
        self.thread = threading.Thread(target=self._run, name="camera-monitor", daemon=True)

    def request_scan(self):
        from backend.common import ServiceError

        with self.lock:
            if self.state["status"] in {"starting", "error", "stopped"}:
                raise ServiceError(self.state.get("error") or "Cameras are not ready", 503)
            if self.busy or self.pending_scan:
                raise ServiceError("A scan is already processing. Try again when it finishes.", 409)
            scan_id = uuid.uuid4().hex
            self.pending_scan = scan_id
            self.scans[scan_id] = {"scan_id": scan_id, "status": "queued"}
            while len(self.scans) > 16:
                del self.scans[next(iter(self.scans))]
            return copy.deepcopy(self.scans[scan_id])

    def scan_status(self, scan_id):
        from backend.common import ServiceError

        with self.lock:
            if scan_id not in self.scans:
                raise ServiceError("Scan not found or expired", 404)
            return copy.deepcopy(self.scans[scan_id])

    @staticmethod
    def _number(name, default):
        value = float(os.getenv(name, str(default)))
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be finite and positive")
        return value

    def _set(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        # Never close a camera concurrently with its capture thread.
        self.thread.join(timeout=10)

    def _verify(self, images, captured_at):
        results = []
        for camera_id, image in zip(self.ids, images):
            if self.stop_event.is_set():
                break
            try:
                result = self.verifier.verify(image, expected_product_id=self.expected,
                                              local_backend=self.local_backend)
                if hasattr(result, "model_dump"):
                    result = result.model_dump(mode="json")
                results.append({"camera_id": camera_id, "result": result})
            except Exception as exc:
                LOG.exception("Camera %s verification failed", camera_id)
                results.append({"camera_id": camera_id, "error": str(exc)})
        return {"captured_at": captured_at, "results": results,
                "aggregation": "independent_images"}

    def _run(self):
        cameras = []
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="camera-cv")
        future = None
        active_scan = None
        try:
            import cv2
            from picamera2 import Picamera2

            active_ids = []
            failures = []
            for camera_id in self.ids:
                camera = None
                try:
                    camera = Picamera2(camera_id)
                    camera.configure(camera.create_video_configuration(
                        main={"size": (1280, 960), "format": "RGB888"},
                        controls={"FrameRate": 10}, buffer_count=4, queue=False))
                    camera.start()
                except Exception as exc:
                    LOG.warning("Camera %s unavailable: %s", camera_id, exc)
                    failures.append(f"Camera {camera_id}: {exc}")
                    if camera is not None:
                        try:
                            camera.close()
                        except Exception:
                            LOG.exception("Camera cleanup failed")
                    continue
                cameras.append(camera)
                active_ids.append(camera_id)
            self.ids = tuple(active_ids)
            self._set(camera_ids=self.ids)
            if not cameras:
                raise RuntimeError("No configured cameras could be started. " + "; ".join(failures))
            # Allow auto-exposure/white balance to converge before detecting stillness.
            if self.stop_event.wait(2):
                return
            gate = StillnessGate(self.settle)
            previous = None
            anchor = None
            while not self.stop_event.is_set():
                if future is not None and future.done():
                    completed = future.result()
                    with self.lock:
                        self.state.update(latest=completed, status="watching")
                        self.busy = False
                        if active_scan:
                            self.scans[active_scan].update(status="complete", **completed)
                    active_scan = None
                    future = None
                    # Discard the old motion history after inference; require fresh settling.
                    gate.quiet_since = None
                    previous = anchor = None
                with self.lock:
                    requested = self.pending_scan if future is None else None
                    if requested:
                        self.pending_scan = None
                        self.busy = True
                        active_scan = requested
                        self.scans[requested]["status"] = "processing"
                # Acquire fresh frames after accepting the button request.
                frames = [camera.capture_array("main") for camera in cameras]
                # Picamera2 RGB888 arrays use OpenCV's BGR channel ordering.
                small = [cv2.GaussianBlur(cv2.cvtColor(cv2.resize(frame, (320, 240)),
                                                       cv2.COLOR_BGR2GRAY), (5, 5), 0)
                         for frame in frames]
                first_sample = previous is None
                if first_sample:
                    previous = anchor = small
                    self._set(status="settling" if future is None else "processing", error=None)
                    if not requested:
                        self.stop_event.wait(self.interval)
                        continue
                # Compare to both the last sample and a fixed quiet-period anchor,
                # so slow movement cannot accumulate unnoticed.
                moving = any(float((cv2.absdiff(a, b) > 12).mean()) >= self.fraction
                             for baseline in (previous, anchor)
                             for a, b in zip(small, baseline))
                previous = small
                if moving:
                    anchor = small
                # Keep observing motion during inference, but do not consume a
                # new quiet-scene trigger until the single worker is available.
                trigger = gate.update(moving, time.monotonic(), allow_trigger=future is None)
                if future is None:
                    self._set(status="moving" if moving else "settling" if gate.armed else "watching")
                    with self.lock:
                        start_auto = trigger and self.auto_scan and not self.pending_scan
                        if requested or start_auto:
                            self.busy = True
                    if requested or start_auto:
                        gate.armed = False
                        images = []
                        for frame in frames:
                            ok, encoded = cv2.imencode(".jpg", frame,
                                                      [cv2.IMWRITE_JPEG_QUALITY, 92])
                            if not ok:
                                raise RuntimeError("Camera JPEG encoding failed")
                            images.append(encoded.tobytes())
                        self._set(status="processing")
                        future = executor.submit(self._verify, images, time.time())
                self.stop_event.wait(self.interval)
        except Exception as exc:
            LOG.exception("Camera monitor stopped")
            with self.lock:
                self.state.update(status="error", error=str(exc))
                for scan in self.scans.values():
                    if scan["status"] in {"queued", "processing"}:
                        scan.update(status="error", error=str(exc))
                self.busy = False
                self.pending_scan = None
        finally:
            for camera in reversed(cameras):
                try:
                    camera.close()
                except Exception:
                    LOG.exception("Camera cleanup failed")
            executor.shutdown(wait=True, cancel_futures=True)
            if self.stop_event.is_set():
                self._set(status="stopped")
