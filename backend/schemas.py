from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Thresholds(BaseModel):
    """POC defaults, not thresholds calibrated for a deployed product."""

    min_retrieval_cosine: float = Field(default=0.45, ge=-1, lt=1)
    min_geometry_score: float = Field(
        default=0.52,
        ge=0,
        le=1,
        deprecated=True,
        description="Legacy field; validated alignment now gates comparison",
    )
    max_foreground_difference: float = Field(default=0.30, ge=0, le=1)
    max_patchcore_anomaly: float = Field(default=0.43, gt=0, le=2)
    min_combined_score: float = Field(default=0.66, ge=0, le=1)
    patchcore_good: float = Field(default=0.24, ge=0, le=2)
    patchcore_bad: float = Field(default=0.56, gt=0, le=2)

    @model_validator(mode="after")
    def ordered_patch_thresholds(self):
        if self.patchcore_bad <= self.patchcore_good:
            raise ValueError("patchcore_bad must be greater than patchcore_good")
        return self


class ProductSummary(BaseModel):
    id: str
    name: str
    sku: str
    barcode: str | None = None
    reference_count: int


class Candidate(BaseModel):
    product_id: str
    name: str
    cosine_similarity: float = Field(ge=-1, le=1)


class GeometryResult(BaseModel):
    backend: str
    matches: int
    inliers: int
    inlier_ratio: float
    coverage: float
    score: float = Field(ge=0, le=1)
    alignment_valid: bool
    estimator: str = "USAC_MAGSAC"
    query_coverage: float = 0
    median_reprojection_error: float | None = None
    rejection_reason: str | None = None
    foreground_iou: float | None = None
    reference_index: int = 0
    references_attempted: int = 0


class SegmentationResult(BaseModel):
    model: str
    valid: bool
    query_foreground_fraction: float
    reference_foreground_fraction: float


class PatchCoreResult(BaseModel):
    anomaly_score: float = Field(ge=0, le=2)
    normality_score: float = Field(ge=0, le=1)
    method: Literal["aligned_spatial", "unaligned_nearest_neighbor"]


class DiscrepancyRegion(BaseModel):
    x: int
    y: int
    width: int
    height: int
    max_anomaly: float


class VerificationResponse(BaseModel):
    request_id: str
    confidence: float = Field(ge=0, le=1, description="Uncalibrated visual-match score")
    confidence_percent: float = Field(ge=0, le=100)
    confidence_type: Literal["uncalibrated_visual_match"] = "uncalibrated_visual_match"
    score_is_informational: bool = False
    decision: Literal["consistent", "suspicious", "inconclusive"]
    identified_product: ProductSummary
    compared_product: ProductSummary
    expected_product_id: str | None
    identity_consistent: bool
    identity_ambiguous: bool = False
    candidates: list[Candidate]
    geometry: GeometryResult
    segmentation: SegmentationResult | None = None
    patchcore: PatchCoreResult
    discrepancy_image_url: str
    heatmap_image_url: str
    diagnostic_image_urls: dict[str, str] = Field(default_factory=dict)
    discrepancy_regions: list[DiscrepancyRegion]
    region_coordinate_system: Literal["aligned_letterbox_448x448"] = "aligned_letterbox_448x448"
    latency_ms: dict[str, float]
    reasons: list[str]
    warnings: list[str]


class BatchItem(BaseModel):
    index: int
    filename: str
    result: VerificationResponse | None = None
    error: str | None = None
    status_code: int = 200


class BatchResponse(BaseModel):
    results: list[BatchItem]
    # Independent per-view results, not a claimed multi-view probability.
    aggregation: Literal["independent_images"] = "independent_images"
