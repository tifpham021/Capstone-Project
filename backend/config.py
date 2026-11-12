from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(__file__).parent / ".runtime")
    device: str = "auto"
    alignment_method: str = "rectangle"
    model_cache: Path | None = None
    dino_source: str | None = None
    api_key: str = ""
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    max_upload_bytes: int = 15 * 1024 * 1024
    max_pixels: int = 20_000_000
    max_batch_images: int = 4
    max_references: int = 8
    decision_engine: str = "luna"
    openai_api_key: str = field(default="", repr=False)
    openai_model: str = "gpt-6-luna"
    openai_reasoning: str = "none"
    openai_timeout_seconds: float = 60

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            data_dir=Path(os.getenv("RETURNSCAN_DATA_DIR", str(cls().data_dir))).resolve(),
            device=os.getenv("RETURNSCAN_DEVICE", "auto"),
            alignment_method=os.getenv("RETURNSCAN_ALIGNMENT_METHOD", "rectangle"),
            model_cache=Path(os.environ["RETURNSCAN_MODEL_CACHE"]).resolve()
            if os.getenv("RETURNSCAN_MODEL_CACHE")
            else None,
            dino_source=os.getenv("RETURNSCAN_DINO_SOURCE") or None,
            api_key=os.getenv("RETURNSCAN_API_KEY", ""),
            decision_engine=os.getenv("RETURNSCAN_DECISION_ENGINE", "luna"),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_model=os.getenv("RETURNSCAN_OPENAI_MODEL", "gpt-6-luna"),
            openai_reasoning=os.getenv("RETURNSCAN_OPENAI_REASONING", "none"),
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
    def max_request_bytes(self) -> int:
        return self.max_upload_bytes * max(self.max_batch_images, self.max_references) + 1024 * 1024
