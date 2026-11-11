import hmac
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import APIKeyHeader
from starlette.exceptions import HTTPException

from backend.config import Settings
from backend.schemas import BatchResponse, ProductSummary, VerificationResponse
from backend.service import IMAGE_ARTIFACTS, ServiceError, VerificationService

IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
LocalBackend = Literal["auto", "aliked", "sift"]


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


async def read_upload(file: UploadFile, settings: Settings) -> bytes:
    try:
        if file.content_type not in IMAGE_MIME_TYPES:
            raise ServiceError("Supported content types: image/jpeg, image/png, image/webp", 415)
        data = await file.read(settings.max_upload_bytes + 1)
        if not data:
            raise ServiceError("Image is empty", 400)
        if len(data) > settings.max_upload_bytes:
            raise ServiceError("Image exceeds the upload limit", 413)
        return data
    finally:
        await file.close()


def create_app(settings: Settings | None = None, service=None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(
        title="ReturnScan CV Backend",
        version="1.2.0",
        description="DINOv2 retrieval, foreground rectangle alignment and PatchCore-style discrepancies. Feature alignment is optional. Scores are not calibrated authenticity probabilities.",
    )
    app.state.verifier = service if service is not None else VerificationService(settings)
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
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
            "device": str(app.state.verifier.models.device),
            "alignment_method": settings.alignment_method,
            "authentication_enabled": bool(settings.api_key),
        }

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
            )
        finally:
            for file in references:
                await file.close()

    @app.post("/v1/verify", response_model=VerificationResponse, dependencies=protected)
    async def verify(
        file: Annotated[UploadFile, File(description="One JPEG, PNG or WebP photo")],
        expected_product_id: Annotated[str | None, Form(max_length=64)] = None,
        barcode: Annotated[str | None, Form(max_length=128)] = None,
        local_backend: Annotated[
            LocalBackend, Form(description="Only used with RETURNSCAN_ALIGNMENT_METHOD=features")
        ] = "auto",
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
        local_backend: Annotated[
            LocalBackend, Form(description="Only used with RETURNSCAN_ALIGNMENT_METHOD=features")
        ] = "auto",
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
        if filename not in IMAGE_ARTIFACTS:
            raise ServiceError("Image not found", 404)
        return FileResponse(
            app.state.verifier.artifact(request_id, filename),
            media_type="image/png",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    return app


app = create_app()
