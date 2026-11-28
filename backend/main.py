import hmac
import os
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Body, Depends, FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field, model_validator
from starlette.exceptions import HTTPException

from backend.catalog import IMAGE_ARTIFACTS
from backend.common import ServiceError, read_upload
from backend.config import Settings
from backend.database import create_session_factory
from backend.orders import CameraOrder, OrderStore, ensure_demo_reference
from backend.records import create_records_router
from backend.schemas import BatchResponse, ProductSummary, VerificationResponse

LocalBackend = Literal["auto", "aliked", "sift"]


class ScanRequest(BaseModel):
    order_number: str | None = Field(default=None, min_length=1, max_length=64)
    product_id: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def exactly_one_identifier(self):
        if (self.order_number is None) == (self.product_id is None):
            raise ValueError("Supply exactly one order_number or product_id")
        return self


class BodyLimitMiddleware:
    """Bound even chunked request bodies before unbounded multipart spooling."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        total = 0

        async def limited_receive():
            nonlocal total
            message = await receive()
            total += len(message.get("body", b""))
            if total > self.max_bytes:
                raise HTTPException(413, "Request exceeds the total upload limit")
            return message

        await self.app(scope, limited_receive, send)


def create_app(settings: Settings | None = None, service=None, session_factory=None) -> FastAPI:
    settings = settings or Settings.from_env()
    create_default_service = service is None
    if service is None:
        if settings.decision_engine == "luna":
            from backend.vision import LunaVerificationService

            service = LunaVerificationService(settings)
        elif settings.decision_engine == "cv":
            from backend.service import VerificationService

            service = VerificationService(settings)
        else:
            raise ValueError("RETURNSCAN_DECISION_ENGINE must be luna or cv")
    orders = OrderStore(settings.data_dir)
    if create_default_service:
        ensure_demo_reference(service)

    @asynccontextmanager
    async def lifespan(app):
        monitor = None
        if os.getenv("RETURNSCAN_CAMERAS_ENABLED", "0") == "1":
            from backend.cameras import CameraMonitor

            monitor = CameraMonitor(app.state.verifier)
            app.state.camera_monitor = monitor
            monitor.start()
        try:
            yield
        finally:
            if monitor is not None:
                await run_in_threadpool(monitor.stop)
            client = getattr(service, "client", None)
            if client is not None and hasattr(client, "close"):
                client.close()

    app = FastAPI(
        lifespan=lifespan,
        title="ReturnScan Camera Inspection Backend",
        version="2.0.0",
        description="Live Pi camera capture with Luna visual decisions and discrepancy boxes. Confidence is not an authenticity probability.",
    )
    app.state.verifier = service
    app.state.orders = orders
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Content-Type", "X-API-Key"],
    )
    api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

    def authorize(key: Annotated[str | None, Depends(api_key_header)]):
        if settings.api_key and (
            key is None or not hmac.compare_digest(key.encode(), settings.api_key.encode())
        ):
            raise ServiceError("Invalid or missing X-API-Key", 401)

    protected = [Depends(authorize)]

    @app.exception_handler(ServiceError)
    async def service_error(_request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.get("/")
    def root():
        return {"service": app.title, "docs": "/docs", "health": "/v1/health"}

    @app.get("/v1/health")
    def health():
        return {
            "status": "ok",
            "models_loaded": app.state.verifier.loaded,
            "alignment_method": settings.alignment_method,
            "decision_engine": getattr(service, "engine", "cv"),
            "model": settings.openai_model
            if getattr(service, "engine", "cv") == "luna"
            else "dinov2_vits14",
            "reasoning_effort": settings.openai_reasoning
            if getattr(service, "engine", "cv") == "luna"
            else None,
            "configured": bool(settings.openai_api_key)
            if getattr(service, "engine", "cv") == "luna"
            else True,
            "device": "api"
            if getattr(service, "engine", "cv") == "luna"
            else str(service.models.device),
            "authentication_enabled": bool(settings.api_key),
        }

    @app.get("/v1/cameras/status", dependencies=protected)
    def camera_status():
        monitor = getattr(app.state, "camera_monitor", None)
        return monitor.snapshot() if monitor else {"enabled": False, "status": "disabled"}

    @app.get("/v1/cameras/orders/{order_number}", dependencies=protected)
    def get_camera_order(order_number: str) -> CameraOrder:
        order = orders.get(order_number)
        product = next(
            (p for p in app.state.verifier.products() if p["id"] == order["product_id"]), None
        )
        return CameraOrder(**order, reference_count=product["reference_count"] if product else 0)

    @app.post("/v1/cameras/scan", status_code=202, dependencies=protected)
    def scan_cameras(body: Annotated[ScanRequest | None, Body()] = None):
        monitor = getattr(app.state, "camera_monitor", None)
        if monitor is None:
            raise ServiceError("Camera mode is disabled. Enable RETURNSCAN_CAMERAS_ENABLED.", 503)
        if body is None:
            return monitor.request_scan()
        if body.order_number is not None:
            return monitor.request_scan(order=orders.get(body.order_number))
        product = next(
            (item for item in app.state.verifier.products() if item["id"] == body.product_id),
            None,
        )
        if product is None:
            raise ServiceError("Product not found", 404)
        if not product["reference_count"]:
            raise ServiceError("No reference photos are enrolled for this product", 409)
        return monitor.request_scan(
            product={
                "inspection_mode": "product",
                "product_id": product["id"],
                "product_name": product["name"],
                "sku": product["sku"],
                "expected_weight_g": product.get("expected_weight_g"),
                "weight_tolerance_percent": product.get("weight_tolerance_percent"),
                "reference_count": product["reference_count"],
            }
        )

    @app.get("/v1/cameras/scans/{scan_id}", dependencies=protected)
    def camera_scan_result(scan_id: str):
        monitor = getattr(app.state, "camera_monitor", None)
        if monitor is None:
            raise ServiceError("Camera mode is disabled", 503)
        return monitor.scan_status(scan_id)

    @app.get("/v1/products", dependencies=protected)
    @app.get("/v1/catalog", dependencies=protected, include_in_schema=False)
    def products():
        return {"products": app.state.verifier.products()}

    @app.post(
        "/v1/products", response_model=ProductSummary, status_code=201, dependencies=protected
    )
    async def enroll(
        product_id: Annotated[
            str, Form(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
        ],
        name: Annotated[str, Form(min_length=1, max_length=200)],
        references: Annotated[list[UploadFile], File(description="1-8 genuine reference images")],
        sku: Annotated[str, Form(max_length=100)] = "",
        barcode: Annotated[str | None, Form(min_length=1, max_length=128)] = None,
        expected_weight_g: Annotated[float | None, Form(gt=0)] = None,
        weight_tolerance_percent: Annotated[float | None, Form(ge=0, le=100)] = None,
    ):
        try:
            if not 1 <= len(references) <= settings.max_references:
                raise ServiceError(f"Supply 1-{settings.max_references} genuine references")
            if not name.strip():
                raise ServiceError("Product name cannot be blank")
            images = [await read_upload(file, settings) for file in references]
            return await run_in_threadpool(
                app.state.verifier.register,
                product_id,
                name.strip(),
                sku or product_id,
                barcode,
                images,
                expected_weight_g,
                weight_tolerance_percent,
            )
        finally:
            for file in references:
                await file.close()

    @app.put(
        "/v1/products/{product_id}/references",
        response_model=ProductSummary,
        dependencies=protected,
    )
    async def replace_references(
        product_id: str,
        references: Annotated[
            list[UploadFile], File(description="1-8 replacement reference photos")
        ],
        name: Annotated[str | None, Form(max_length=200)] = None,
        expected_weight_g: Annotated[float | None, Form(gt=0)] = None,
        weight_tolerance_percent: Annotated[float | None, Form(ge=0, le=100)] = None,
    ):
        try:
            if not 1 <= len(references) <= settings.max_references:
                raise ServiceError(f"Supply 1-{settings.max_references} genuine references")
            if name is not None and not name.strip():
                raise ServiceError("Product name cannot be blank")
            images = [await read_upload(file, settings) for file in references]
            return await run_in_threadpool(
                app.state.verifier.replace_references,
                product_id,
                images,
                name.strip() if name is not None else None,
                expected_weight_g,
                weight_tolerance_percent,
            )
        finally:
            for file in references:
                await file.close()

    @app.post("/v1/verify", response_model=VerificationResponse, dependencies=protected)
    async def verify(
        file: Annotated[UploadFile, File(description="One JPEG, PNG or WebP photo")],
        expected_product_id: Annotated[str | None, Form(max_length=64)] = None,
        barcode: Annotated[str | None, Form(max_length=128)] = None,
        local_backend: Annotated[LocalBackend, Form()] = "auto",
    ):
        data = await read_upload(file, settings)
        return await run_in_threadpool(
            app.state.verifier.verify,
            data,
            expected_product_id=expected_product_id,
            barcode=barcode,
            local_backend=local_backend,
        )

    @app.post("/v1/verify/batch", response_model=BatchResponse, dependencies=protected)
    async def batch(
        files: Annotated[
            list[UploadFile], File(description="1-4 photos; each produces an independent result")
        ],
        expected_product_id: Annotated[str | None, Form(max_length=64)] = None,
        barcode: Annotated[str | None, Form(max_length=128)] = None,
        local_backend: Annotated[LocalBackend, Form()] = "auto",
    ):
        try:
            if not 1 <= len(files) <= settings.max_batch_images:
                raise ServiceError(f"Supply 1-{settings.max_batch_images} images")
            if expected_product_id and barcode:
                raise ServiceError("Supply expected_product_id or barcode, not both")
            results = []
            for index, file in enumerate(files):
                filename = file.filename or f"image-{index}"
                try:
                    data = await read_upload(file, settings)
                    result = await run_in_threadpool(
                        app.state.verifier.verify,
                        data,
                        expected_product_id=expected_product_id,
                        barcode=barcode,
                        local_backend=local_backend,
                    )
                    results.append({"index": index, "filename": filename, "result": result})
                except ServiceError as exc:
                    results.append(
                        {
                            "index": index,
                            "filename": filename,
                            "error": str(exc),
                            "status_code": exc.status_code,
                        }
                    )
            return {"results": results}
        finally:
            for file in files:
                await file.close()

    @app.get(
        "/v1/results/{request_id}", response_model=VerificationResponse, dependencies=protected
    )
    def result(request_id: str):
        import json

        return json.loads(app.state.verifier.artifact(request_id, "result.json").read_text())

    @app.get("/v1/results/{request_id}/{filename}", dependencies=protected)
    def result_image(request_id: str, filename: str):
        if filename not in IMAGE_ARTIFACTS | {"capture.png", "normalized.png"}:
            raise ServiceError("Image not found", 404)
        return FileResponse(
            app.state.verifier.artifact(request_id, filename),
            media_type="image/png",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    app.include_router(
        create_records_router(
            settings,
            session_factory or create_session_factory(settings),
            protected,
            legacy_camera_order=get_camera_order,
        )
    )

    return app


app = create_app()
