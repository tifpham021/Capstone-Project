from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InspectionFlag(StrictModel):
    status: Literal["present", "absent", "unknown"]
    confidence: float = Field(ge=0, le=1)
    evidence: str


class InspectionFlags(StrictModel):
    damage: InspectionFlag
    different_item: InspectionFlag
    missing_parts: InspectionFlag
    counterfeit_evidence: InspectionFlag
    insufficient_visual_evidence: InspectionFlag


NormalizedBox = Annotated[
    list[Annotated[int, Field(strict=True, ge=0, le=1000)]],
    Field(min_length=4, max_length=4),
]


class VisualDiscrepancy(StrictModel):
    category: Literal["damage", "different_item", "missing_parts", "counterfeit_evidence"]
    description: str
    confidence: float = Field(ge=0, le=1)
    reference_box: NormalizedBox | None
    query_box: NormalizedBox | None

    @model_validator(mode="after")
    def ordered_boxes(self):
        for box in (self.reference_box, self.query_box):
            if box is not None and not (box[0] < box[2] and box[1] < box[3]):
                raise ValueError("Bounding boxes must have positive width and height")
        return self


class VisualAssessment(StrictModel):
    verdict: Literal["visually_consistent", "discrepancy_detected", "inconclusive"]
    verdict_confidence: float = Field(ge=0, le=1)
    flags: InspectionFlags
    discrepancies: list[VisualDiscrepancy] = Field(max_length=5)
    reference_index: int = Field(ge=0)


class Thresholds(BaseModel):
    """POC defaults, not thresholds calibrated for a deployed product."""

    min_retrieval_cosine: float = Field(default=0.45, ge=-1, lt=1)
    min_geometry_score: float = Field(default=0.52, ge=0, le=1)
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
    alignment_method: str = "features"
    alignment_quality: str = "unknown"
    rotation_degrees: int = 0


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
    decision_engine: Literal["cv", "luna"] = "cv"
    model: str | None = None
    reasoning_effort: str | None = None
    verdict: Literal["visually_consistent", "discrepancy_detected", "inconclusive"] | None = None
    verdict_confidence: float | None = Field(default=None, ge=0, le=1)
    flags: InspectionFlags | None = None
    discrepancies: list[VisualDiscrepancy] = Field(default_factory=list)
    reference_index: int = 0
    source_image_id: int | None = None
    reference_image_url: str | None = None
    annotated_image_url: str | None = None
    annotated_reference_image_url: str | None = None
    original_image_url: str | None = None
    score_is_informational: bool = False
    diagnostic_image_urls: dict[str, str] = Field(default_factory=dict)
    request_id: str
    confidence: float = Field(ge=0, le=1, description="Uncalibrated visual-match score")
    confidence_percent: float = Field(ge=0, le=100)
    confidence_type: Literal["uncalibrated_visual_match", "uncalibrated_model_assessment"] = (
        "uncalibrated_visual_match"
    )
    decision: Literal["consistent", "suspicious", "inconclusive"]
    identified_product: ProductSummary | None
    compared_product: ProductSummary
    expected_product_id: str | None
    identity_consistent: bool
    identity_ambiguous: bool = False
    candidates: list[Candidate] = Field(default_factory=list)
    geometry: GeometryResult | None = None
    patchcore: PatchCoreResult | None = None
    discrepancy_image_url: str | None = None
    capture_image_url: str | None = None
    normalized_reference_image_url: str | None = None
    normalized_image_url: str | None = None
    background_removed: bool = False
    normalization_alignment: Literal["matched_geometry", "orientation_only"] | None = None
    heatmap_image_url: str | None = None
    discrepancy_regions: list[DiscrepancyRegion] = Field(default_factory=list)
    region_coordinate_system: Literal[
        "aligned_letterbox_448x448", "normalized_448x448", "normalized_reference_query_1000"
    ] = "aligned_letterbox_448x448"
    latency_ms: dict[str, float]
    reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


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
