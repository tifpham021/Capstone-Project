from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(__file__).parent / ".runtime")
    device: str = "auto"
    model_cache: Path | None = None
    dino_source: str | None = None
    segmentation_model: str = "u2netp"
    alignment_method: str = "rectangle"
    api_key: str = ""
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    max_upload_bytes: int = 15 * 1024 * 1024
    max_pixels: int = 20_000_000
    max_batch_images: int = 4
    max_references: int = 8
    # Empty means SQLite at <data_dir>/returnscan.db. Any SQLAlchemy URL works,
    # e.g. postgresql+psycopg://user:pass@host/db if the database moves later.
    database_url: str = ""

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            data_dir=Path(os.getenv("RETURNSCAN_DATA_DIR", str(cls().data_dir))).resolve(),
            device=os.getenv("RETURNSCAN_DEVICE", "auto"),
            model_cache=Path(os.environ["RETURNSCAN_MODEL_CACHE"]).resolve()
            if os.getenv("RETURNSCAN_MODEL_CACHE")
            else None,
            dino_source=os.getenv("RETURNSCAN_DINO_SOURCE") or None,
            segmentation_model=os.getenv("RETURNSCAN_SEGMENTATION_MODEL", cls().segmentation_model),
            alignment_method=os.getenv("RETURNSCAN_ALIGNMENT_METHOD", cls().alignment_method),
            api_key=os.getenv("RETURNSCAN_API_KEY", ""),
            database_url=os.getenv("RETURNSCAN_DATABASE_URL", ""),
            cors_origins=tuple(
                filter(
                    None,
                    (
                        item.strip()
                        for item in os.getenv(
                            "RETURNSCAN_CORS_ORIGINS", ",".join(cls().cors_origins)
                        ).split(",")
                    ),
                )
            ),
        )

    @property
    def resolved_database_url(self) -> str:
        return self.database_url or f"sqlite:///{(self.data_dir / 'returnscan.db').as_posix()}"

    @property
    def max_request_bytes(self) -> int:
        return self.max_upload_bytes * max(self.max_batch_images, self.max_references) + 1024 * 1024
