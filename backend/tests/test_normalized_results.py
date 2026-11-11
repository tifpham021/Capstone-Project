"""Service and image-route regressions with deterministic models; no downloads."""
import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
import torch.nn.functional as functional
from PIL import Image

from backend.algorithms import Features, LocalMatch
from backend.config import Settings
from backend.main import create_app
from backend.service import ServiceError, VerificationService
from backend.tests.test_visualization import phone


class Models:
    loaded = True
    device = "cpu"
    valid = True

    def load(self):
        pass

    def features(self, image, valid_mask=None):
        mean = np.asarray(image).mean((0, 1)).astype(np.float32)
        vector = functional.normalize(torch.tensor([*mean, 1.0]), dim=0)
        return Features(vector, vector.repeat(1024, 1), torch.ones(1024, dtype=torch.bool))

    def local_features(self, image):
        return image

    def match(self, reference, query, ref_size):
        return LocalMatch("ALIKED+LightGlue", 100, 90, .9, .8, .95,
                          np.eye(3) if self.valid else None)


def encoded(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


async def get(app, path, method="GET", body=b"", headers=None):
    messages = []
    delivered = False
    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(60)
    async def send(message):
        messages.append(message)
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1",
             "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
             "query_string": b"", "headers": headers or [], "client": ("127.0.0.1", 1),
             "server": ("test", 80), "root_path": ""}
    task = asyncio.create_task(app(scope, receive, send))
    for _ in range(1000):
        if task.done():
            break
        await asyncio.sleep(.01)
    if not task.done():
        task.cancel()
        raise AssertionError("Image request timed out")
    await task
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start, body


class NormalizedResultsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.models = Models()
        self.settings = Settings(data_dir=Path(self.directory.name), alignment_method="features")
        self.service = VerificationService(self.settings, self.models)
        self.photo = encoded(phone())
        self.service.register("phone", "Black phone", "BLACK", "123", [self.photo])

    def test_lightglue_artifacts_are_served_as_png_and_no_heatmap(self):
        result = self.service.verify(self.photo)
        self.assertTrue(result["background_removed"])
        self.assertEqual(result["normalization_alignment"], "matched_geometry")
        self.assertIsNone(result["heatmap_image_url"])
        self.assertEqual(result["discrepancy_regions"], [])
        app = create_app(self.settings, self.service)
        for key in ("capture_image_url", "normalized_reference_image_url", "normalized_image_url", "discrepancy_image_url"):
            with self.subTest(key=key):
                response, body = asyncio.run(get(app, result[key]))
                self.assertEqual(response["status"], 200)
                self.assertIn((b"content-type", b"image/png"), response["headers"])
                Image.open(io.BytesIO(body)).verify()
        self.assertEqual(asyncio.run(get(app, f'/v1/results/{result["request_id"]}/result.json'))[0]["status"], 404)

    def test_sift_does_not_produce_discrepancy_image(self):
        match = LocalMatch("SIFT+RANSAC", 100, 90, .9, .8, .95, np.eye(3))
        with patch("backend.service.sift_match", return_value=match):
            result = self.service.verify(self.photo, local_backend="sift")
        self.assertIsNone(result["discrepancy_image_url"])
        self.assertEqual(result["discrepancy_regions"], [])
        self.assertTrue(result["normalized_image_url"])

    def test_failed_alignment_does_not_localize_differences(self):
        self.models.valid = False
        result = self.service.verify(self.photo)
        self.assertEqual(result["normalization_alignment"], "orientation_only")
        self.assertIsNone(result["discrepancy_image_url"])

    def test_reference_replacement_keeps_product_and_invalidates_index(self):
        self.service.verify(self.photo)
        original = self.service._catalog()["products"][0]
        replacement = encoded(phone("#101010"))
        product = self.service.replace_references("phone", [replacement], "iPhone 15 · Black")
        self.assertEqual(product["name"], "iPhone 15 · Black")
        self.assertEqual(product["barcode"], "123")
        self.assertNotIn("phone", self.service._index)
        current = self.service._catalog()["products"][0]
        self.assertNotEqual(current["references"], original["references"])
        self.assertTrue((self.settings.data_dir / original["references"][0]).exists())
        with self.assertRaises(ServiceError):
            self.service.replace_references("missing", [replacement])

    def test_reference_replacement_api_is_authenticated(self):
        import json
        from dataclasses import replace
        from backend.enroll_iphone15 import multipart

        boundary, body = multipart([self.photo])
        headers = [(b"content-type", f"multipart/form-data; boundary={boundary}".encode())]
        app = create_app(replace(self.settings, api_key="test-key"), self.service)
        path = "/v1/products/phone/references"
        response, _ = asyncio.run(get(app, path, "PUT", body, headers))
        self.assertEqual(response["status"], 401)
        headers.append((b"x-api-key", b"test-key"))
        response, payload = asyncio.run(get(app, path, "PUT", body, headers))
        self.assertEqual(response["status"], 200, payload)
        self.assertEqual(json.loads(payload)["name"], "Apple iPhone 15 · Black")
        self.assertEqual(self.service.products()[0]["reference_count"], 1)


if __name__ == "__main__":
    unittest.main()
