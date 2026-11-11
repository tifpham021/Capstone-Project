"""Image preprocessing and edge-difference tests without models or downloads."""
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

from backend.visualization import foreground, major_discrepancies, normalized_pair


def phone(color="#181a1b"):
    image = Image.new("RGB", (260, 340), "#c8bb9a")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 35, 190, 305), radius=18, fill=color)
    draw.ellipse((83, 50, 113, 80), fill="#555b60")
    draw.ellipse((118, 83, 148, 113), fill="#555b60")
    return image


class VisualizationTests(unittest.TestCase):
    def test_black_and_white_foreground_keep_product_remove_desk(self):
        for color in ("#181a1b", "#f8f8f8"):
            with self.subTest(color=color):
                _, mask, ok = foreground(phone(color))
                self.assertTrue(ok)
                self.assertEqual(mask[170, 130], 1)
                self.assertEqual(mask[10, 10], 0)

    def test_matching_views_are_transparent_and_have_no_boxes(self):
        reference, query, removed = normalized_pair(phone(), phone(), np.eye(3), True)
        self.assertTrue(removed)
        self.assertEqual(reference.size, (448, 448))
        self.assertEqual(reference.getpixel((0, 0))[3], 0)
        np.testing.assert_array_equal(np.asarray(reference), np.asarray(query))
        overlay, regions = major_discrepancies(reference, query)
        self.assertEqual(regions, [])
        np.testing.assert_array_equal(np.asarray(overlay), np.asarray(query))

    def test_transformed_source_is_not_clipped_to_reference(self):
        # Colored edge strips expose clipping on every side of the source.
        image = Image.new("RGB", (100, 80), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 9, 79), fill="red")
        draw.rectangle((90, 0, 99, 79), fill="blue")
        draw.rectangle((10, 0, 89, 9), fill="green")
        draw.rectangle((10, 70, 89, 79), fill="yellow")
        transforms = [
            np.array([[1., 0, x], [0, 1., y], [0, 0, 1.]])
            for x, y in [(70, 50), (-70, -50)]
        ]
        transforms.append(np.array([[.8, -.6, 50], [.6, .8, -30], [0, 0, 1.]]))
        with patch("backend.visualization.foreground", return_value=(
                np.asarray(image), np.ones((80, 100), np.uint8), True)):
            for matrix in transforms:
                with self.subTest(matrix=matrix):
                    _, query, _ = normalized_pair(image, image, matrix, True)
                    pixels = np.asarray(query)
                    for color in [(255, 0, 0), (0, 0, 255), (0, 128, 0), (255, 255, 0)]:
                        self.assertTrue(np.any(np.all(pixels[..., :3] == color, axis=2)
                                               & (pixels[..., 3] == 255)))
                    self.assertFalse(np.any(pixels[[0, -1], :, 3]))
                    self.assertFalse(np.any(pixels[:, [0, -1], 3]))

    def test_new_line_gets_box_without_flooding_image(self):
        reference, query, _ = normalized_pair(phone(), phone(), np.eye(3), True)
        changed = query.copy()
        ImageDraw.Draw(changed).line((185, 200, 255, 250), fill="white", width=5)
        overlay, regions = major_discrepancies(reference, changed)
        self.assertGreaterEqual(len(regions), 1)
        self.assertLessEqual(len(regions), 8)
        self.assertTrue(any(r["x"] < 220 < r["x"] + r["width"] and
                            r["y"] < 225 < r["y"] + r["height"] for r in regions))
        self.assertEqual(overlay.getpixel((0, 0)), changed.getpixel((0, 0)))

    def test_small_alignment_shift_is_ignored(self):
        reference, query, _ = normalized_pair(phone(), phone(), np.eye(3), True)
        shifted = Image.new("RGBA", query.size)
        shifted.paste(query, (1, 0))
        _, regions = major_discrepancies(reference, shifted)
        self.assertEqual(regions, [])

    def test_unsegmented_image_is_reported_and_not_emptied(self):
        blank = Image.new("RGB", (200, 200), "white")
        reference, query, removed = normalized_pair(blank, blank, np.eye(3), True)
        self.assertFalse(removed)
        self.assertGreater(np.asarray(reference)[..., 3].sum(), 0)
        self.assertGreater(np.asarray(query)[..., 3].sum(), 0)

    def test_rotation_is_applied_from_matched_geometry(self):
        image = phone()
        rotated = image.transpose(Image.Transpose.ROTATE_180)
        matrix = np.array([[-1., 0., image.width - 1], [0., -1., image.height - 1], [0., 0., 1.]])
        reference, query, removed = normalized_pair(image, rotated, matrix, True)
        self.assertTrue(removed)
        self.assertLess(np.abs(np.asarray(reference).astype(float) - np.asarray(query)).mean(), 1)
        self.assertEqual(major_discrepancies(reference, query)[1], [])


if __name__ == "__main__":
    unittest.main()
