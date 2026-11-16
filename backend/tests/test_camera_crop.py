"""Exercise crop coverage and conservative fallback on synthetic table scenes."""

import numpy as np
import pytest
from backend.camera_crop import adaptive_crop, object_bounds


@pytest.mark.parametrize("value", [40, 230])
def test_central_product_coverage_with_padding(value):
    frame = np.full((960, 1280, 3), 150, dtype=np.uint8)
    frame[560:720, 500:780] = value
    x0, y0, x1, y1 = object_bounds(frame)
    assert 0 < x0 < 500 < 780 < x1 < 1280
    assert 0 < y0 < 560 < 720 < y1 < 960
    crop = adaptive_crop(frame)
    assert crop.shape == (y1 - y0, x1 - x0, 3)
    assert np.count_nonzero(crop[:, :, 0] == value) == 160 * 280


def test_empty_table_and_boundary_object_keep_full_frame():
    frame = np.full((960, 1280, 3), 150, dtype=np.uint8)
    assert adaptive_crop(frame) is frame
    frame[850:960, 500:780] = 40
    assert adaptive_crop(frame) is frame


def test_small_object_never_produces_undecodable_crop():
    frame = np.full((240, 320, 3), 150, dtype=np.uint8)
    frame[150:160, 155:165] = 230
    crop = adaptive_crop(frame)
    assert min(crop.shape[:2]) >= 64


def test_dim_bluish_earbud_is_not_discarded_as_table():
    frame = np.full((960, 1280, 3), 150, dtype=np.uint8)
    # A white earbud can appear dim and blue under the station lighting.
    frame[508:552, 588:632] = (235, 205, 180)
    bounds = object_bounds(frame)
    assert bounds is not None
    x0, y0, x1, y1 = bounds
    assert x0 < 588 < 632 < x1
    assert y0 < 508 < 552 < y1


def test_product_above_old_region_is_not_hidden_by_boundary_glare():
    frame = np.full((960, 1280, 3), 150, dtype=np.uint8)
    frame[384:444, 536:588] = 230
    # A large reflection extends beyond the bottom inspection boundary.
    frame[600:960, 700:1000] = 230
    x0, y0, x1, y1 = object_bounds(frame)
    assert x0 < 536 < 588 < x1
    assert y0 < 384 < 444 < y1
    assert x1 < 700


def test_bright_product_touching_dark_table_scratch_still_gets_cropped():
    frame = np.full((960, 1280, 3), 150, dtype=np.uint8)
    frame[404:464, 552:596] = 230
    # The scratch connects the product to the excluded left table edge.
    frame[424:432, 0:556] = 40
    bounds = object_bounds(frame)
    assert bounds is not None
    x0, y0, x1, y1 = bounds
    assert 0 < x0 < 552 < 596 < x1 < 1280
    assert y0 < 404 < 464 < y1
