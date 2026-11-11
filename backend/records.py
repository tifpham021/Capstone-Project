"""HTTP routes for orders, original item images, returns, weight checks and decisions."""

import json
import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from backend.common import ServiceError, decode_image, read_upload
from backend.config import Settings
from backend.database import (
    DECISION_OUTCOMES,
    IMAGE_VIEWS,
    RETURN_STATUSES,
    Decision,
    Order,
    OrderImage,
    OrderItem,
    ReturnCase,
    ReturnEvent,
    ReturnImage,
    Verification,
    WeightCheck,
)

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
RESULT_ID = re.compile(r"[a-f0-9]{32}\Z")
View = Literal["front", "back", "top", "side", "label", "other"]
Status = Literal["identified", "inspection_in_progress", "awaiting_decision", "completed"]
Outcome = Literal["approve", "secondary", "fraud"]
assert set(View.__args__) == set(IMAGE_VIEWS)
assert set(Status.__args__) == set(RETURN_STATUSES)
assert set(Outcome.__args__) == set(DECISION_OUTCOMES)

STATUS_LABELS = {
    "identified": "Return identified",
    "inspection_in_progress": "Inspection started",
    "awaiting_decision": "Awaiting decision",
    "completed": "Decision recorded",
}
NEXT_STATUS = dict(zip(RETURN_STATUSES, RETURN_STATUSES[1:]))

# Default weight rule when an item has no tolerance of its own:
# allow 2% of the expected weight, but never less than 5 g (scale noise).
DEFAULT_TOLERANCE_PERCENT = 2.0
MIN_TOLERANCE_G = 5.0


def weight_tolerance(item: OrderItem) -> float:
    if item.weight_tolerance_g is not None:
        return item.weight_tolerance_g
    return max(MIN_TOLERANCE_G, item.expected_weight_g * DEFAULT_TOLERANCE_PERCENT / 100)


# ---------- request / response models ----------


class OrderItemIn(BaseModel):
    product_name: str = Field(min_length=1, max_length=200)
    product_id: str | None = Field(default=None, pattern=ID_PATTERN)
    sku: str | None = Field(default=None, max_length=100)
    barcode: str | None = Field(default=None, min_length=1, max_length=128)
    serial_number: str | None = Field(default=None, max_length=128)
    quantity: int = Field(default=1, ge=1, le=1000)
    unit_price_cents: int | None = Field(default=None, ge=0)
    expected_weight_g: float | None = Field(default=None, gt=0, le=1_000_000)
    weight_tolerance_g: float | None = Field(default=None, ge=0, le=1_000_000)


class OrderIn(BaseModel):
    id: str = Field(pattern=ID_PATTERN, description="Order number, e.g. ORD-8921")
    customer_name: str | None = Field(default=None, max_length=200)
    customer_email: str | None = Field(default=None, max_length=320)
    placed_at: AwareDatetime | None = None
    items: list[OrderItemIn] = Field(min_length=1, max_length=200)


class ImageOut(BaseModel):
    id: int
    view: str
    width: int
    height: int
    url: str
    created_at: datetime


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: str | None
    product_name: str
    sku: str | None
    barcode: str | None
    serial_number: str | None
    quantity: int
    unit_price_cents: int | None
    expected_weight_g: float | None
    weight_tolerance_g: float | None
    images: list[ImageOut]


class OrderOut(BaseModel):
    id: str
    customer_name: str | None
    customer_email: str | None
    placed_at: datetime | None
    created_at: datetime
    items: list[OrderItemOut]


class ReturnIn(BaseModel):
    order_id: str = Field(pattern=ID_PATTERN)
    order_item_id: int | None = Field(
        default=None, description="Which item is being returned; optional if the order has one"
    )
    lookup_identifier: str | None = Field(default=None, max_length=128)
    station: str | None = Field(default=None, max_length=64)
    reviewer_email: str | None = Field(default=None, max_length=320)


class StatusIn(BaseModel):
    status: Status


class WeightIn(BaseModel):
    measured_weight_g: float = Field(gt=0, le=1_000_000)
    scale_id: str | None = Field(default=None, max_length=64)


class VerificationIn(BaseModel):
    request_id: str = Field(description="request_id returned by POST /v1/verify")


class DecisionIn(BaseModel):
    outcome: Outcome
    reason: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=5000)
    reviewer_email: str | None = Field(default=None, max_length=320)


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    status: str
    label: str
    occurred_at: datetime


class WeightCheckOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    measured_weight_g: float
    expected_weight_g: float
    tolerance_g: float
    difference_g: float
    difference_percent: float
    within_tolerance: bool
    scale_id: str | None
    measured_at: datetime


class VerificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    request_id: str
    confidence: float
    decision: str
    compared_product_id: str
    identity_consistent: bool
    created_at: datetime
    result_url: str
    discrepancy_image_url: str
    heatmap_image_url: str


class DecisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    outcome: str
    reason: str | None
    note: str | None
    reviewer_email: str | None
    created_at: datetime


class ReturnOut(BaseModel):
    id: str
    status: str
    order_id: str
    lookup_identifier: str | None
    station: str | None
    reviewer_email: str | None
    created_at: datetime
    updated_at: datetime
    customer_name: str | None
    item: OrderItemOut | None
    events: list[EventOut]
    weight_checks: list[WeightCheckOut]
    images: list[ImageOut]
    verifications: list[VerificationOut]
    decision: DecisionOut | None


# ---------- serializers ----------


def order_image_out(image: OrderImage) -> ImageOut:
    return ImageOut(
        id=image.id,
        view=image.view,
        width=image.width,
        height=image.height,
        url=f"/v1/order-images/{image.id}",
        created_at=image.created_at,
    )


def return_image_out(image: ReturnImage) -> ImageOut:
    return ImageOut(
        id=image.id,
        view=image.view,
        width=image.width,
        height=image.height,
        url=f"/v1/return-images/{image.id}",
        created_at=image.created_at,
    )


def item_out(item: OrderItem) -> OrderItemOut:
    data = {c: getattr(item, c) for c in OrderItemOut.model_fields if c != "images"}
    return OrderItemOut(**data, images=[order_image_out(i) for i in item.images])


def order_out(order: Order) -> OrderOut:
    return OrderOut(
        id=order.id,
        customer_name=order.customer_name,
        customer_email=order.customer_email,
        placed_at=order.placed_at,
        created_at=order.created_at,
        items=[item_out(i) for i in order.items],
    )


def verification_out(v: Verification) -> VerificationOut:
    base = f"/v1/results/{v.request_id}"
    return VerificationOut(
        request_id=v.request_id,
        confidence=v.confidence,
        decision=v.decision,
        compared_product_id=v.compared_product_id,
        identity_consistent=v.identity_consistent,
        created_at=v.created_at,
        result_url=base,
        discrepancy_image_url=f"{base}/discrepancy.png",
        heatmap_image_url=f"{base}/heatmap.png",
    )


def return_out(case: ReturnCase) -> ReturnOut:
    return ReturnOut(
        id=case.id,
        status=case.status,
        order_id=case.order_id,
        lookup_identifier=case.lookup_identifier,
        station=case.station,
        reviewer_email=case.reviewer_email,
        created_at=case.created_at,
        updated_at=case.updated_at,
        customer_name=case.order.customer_name,
        item=item_out(case.item) if case.item else None,
        events=[EventOut.model_validate(e) for e in case.events],
        weight_checks=[WeightCheckOut.model_validate(w) for w in case.weight_checks],
        images=[return_image_out(i) for i in case.images],
        verifications=[verification_out(v) for v in case.verifications],
        decision=DecisionOut.model_validate(case.decisions[-1]) if case.decisions else None,
    )


# ---------- router ----------


def create_records_router(
    settings: Settings, session_factory: sessionmaker, dependencies=()
) -> APIRouter:
    router = APIRouter(prefix="/v1", tags=["records"], dependencies=list(dependencies))
    data_dir = settings.data_dir.resolve()

    def get_db():
        with session_factory() as session:
            yield session

    DB = Annotated[Session, Depends(get_db)]

    def load_order(db: Session, order_id: str) -> Order:
        order = db.scalar(
            select(Order)
            .where(Order.id == order_id)
            .options(selectinload(Order.items).selectinload(OrderItem.images))
        )
        if order is None:
            raise ServiceError("Order not found", 404)
        return order

    def load_return(db: Session, return_id: str) -> ReturnCase:
        case = db.get(ReturnCase, return_id)
        if case is None:
            raise ServiceError("Return not found", 404)
        return case

    def add_event(case: ReturnCase, status: str):
        case.status = status
        case.events.append(ReturnEvent(status=status, label=STATUS_LABELS[status]))

    def advance_to(case: ReturnCase, status: str):
        """Move forward through the lifecycle, filling in skipped steps for the audit trail."""
        target = RETURN_STATUSES.index(status)
        while RETURN_STATUSES.index(case.status) < target:
            add_event(case, NEXT_STATUS[case.status])

    def save_image(data: bytes, folder: str) -> tuple[str, int, int]:
        image = decode_image(data, settings)  # sanitized RGB, resized, metadata stripped
        directory = data_dir / folder
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / f"{uuid.uuid4().hex}.jpg"
        image.save(destination, "JPEG", quality=90)
        return destination.relative_to(data_dir).as_posix(), image.width, image.height

    def serve(relative: str):
        source = (data_dir / relative).resolve()
        if not source.is_relative_to(data_dir) or not source.is_file():
            raise ServiceError("Image not found", 404)
        return FileResponse(
            source,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
        )

    # ----- orders -----

    @router.post("/orders", response_model=OrderOut, status_code=201)
    def create_order(body: OrderIn, db: DB):
        if db.get(Order, body.id) is not None:
            raise ServiceError("Order already exists", 409)
        order = Order(
            id=body.id,
            customer_name=body.customer_name,
            customer_email=body.customer_email,
            placed_at=body.placed_at,
            items=[OrderItem(**item.model_dump()) for item in body.items],
        )
        db.add(order)
        db.commit()
        return order_out(load_order(db, order.id))

    @router.get("/orders", response_model=list[OrderOut])
    def list_orders(
        db: DB,
        search: Annotated[
            str | None,
            Query(max_length=128, description="Order number, SKU, serial or customer name"),
        ] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
    ):
        query = select(Order).options(selectinload(Order.items).selectinload(OrderItem.images))
        if search:
            like = f"%{search.strip()}%"
            query = query.where(
                or_(
                    Order.id.ilike(like),
                    Order.customer_name.ilike(like),
                    Order.items.any(
                        or_(OrderItem.sku.ilike(like), OrderItem.serial_number.ilike(like))
                    ),
                )
            )
        orders = db.scalars(query.order_by(Order.created_at.desc()).limit(limit)).all()
        return [order_out(o) for o in orders]

    @router.get("/orders/{order_id}", response_model=OrderOut)
    def get_order(order_id: str, db: DB):
        return order_out(load_order(db, order_id))

    @router.post(
        "/orders/{order_id}/items/{item_id}/images", response_model=ImageOut, status_code=201
    )
    async def add_order_image(
        order_id: str,
        item_id: int,
        file: Annotated[UploadFile, File(description="Original photo of the item before shipping")],
        db: DB,
        view: Annotated[View, Form()] = "other",
    ):
        item = db.get(OrderItem, item_id)
        if item is None or item.order_id != order_id:
            raise ServiceError("Order item not found", 404)
        path, width, height = save_image(await read_upload(file, settings), "order-images")
        image = OrderImage(item=item, view=view, file_path=path, width=width, height=height)
        db.add(image)
        db.commit()
        return order_image_out(image)

    @router.get("/order-images/{image_id}")
    def get_order_image(image_id: int, db: DB):
        image = db.get(OrderImage, image_id)
        if image is None:
            raise ServiceError("Image not found", 404)
        return serve(image.file_path)

    # ----- returns -----

    @router.post("/returns", response_model=ReturnOut, status_code=201)
    def create_return(body: ReturnIn, db: DB):
        order = load_order(db, body.order_id)
        item = None
        if body.order_item_id is not None:
            item = next((i for i in order.items if i.id == body.order_item_id), None)
            if item is None:
                raise ServiceError("Order item not found in this order", 404)
        elif len(order.items) == 1:
            item = order.items[0]
        else:
            raise ServiceError("Order has several items; send order_item_id")
        case = ReturnCase(
            id=f"RET-{uuid.uuid4().hex[:10].upper()}",
            order=order,
            item=item,
            lookup_identifier=body.lookup_identifier,
            station=body.station,
            reviewer_email=body.reviewer_email,
            status="identified",
        )
        case.events.append(ReturnEvent(status="identified", label=STATUS_LABELS["identified"]))
        db.add(case)
        db.commit()
        return return_out(case)

    @router.get("/returns", response_model=list[ReturnOut])
    def list_returns(
        db: DB,
        status: Status | None = None,
        order_id: Annotated[str | None, Query(max_length=64)] = None,
        reviewer_email: Annotated[str | None, Query(max_length=320)] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
    ):
        query = select(ReturnCase)
        if status:
            query = query.where(ReturnCase.status == status)
        if order_id:
            query = query.where(ReturnCase.order_id == order_id)
        if reviewer_email:
            query = query.where(ReturnCase.reviewer_email == reviewer_email)
        cases = db.scalars(query.order_by(ReturnCase.created_at.desc()).limit(limit)).all()
        return [return_out(c) for c in cases]

    @router.get("/returns/{return_id}", response_model=ReturnOut)
    def get_return(return_id: str, db: DB):
        return return_out(load_return(db, return_id))

    @router.post("/returns/{return_id}/status", response_model=ReturnOut)
    def set_status(return_id: str, body: StatusIn, db: DB):
        case = load_return(db, return_id)
        if body.status != case.status:
            if NEXT_STATUS.get(case.status) != body.status:
                raise ServiceError(f"Cannot move a return from {case.status} to {body.status}", 409)
            add_event(case, body.status)
            db.commit()
        return return_out(case)

    @router.post("/returns/{return_id}/weight", response_model=WeightCheckOut, status_code=201)
    def record_weight(return_id: str, body: WeightIn, db: DB):
        case = load_return(db, return_id)
        if case.status == "completed":
            raise ServiceError("Return is already completed", 409)
        if case.item is None or case.item.expected_weight_g is None:
            raise ServiceError("The original order item has no expected weight on file", 409)
        expected = case.item.expected_weight_g
        tolerance = weight_tolerance(case.item)
        difference = body.measured_weight_g - expected
        check = WeightCheck(
            measured_weight_g=body.measured_weight_g,
            expected_weight_g=expected,
            tolerance_g=tolerance,
            difference_g=round(difference, 3),
            difference_percent=round(difference / expected * 100, 3),
            within_tolerance=abs(difference) <= tolerance,
            scale_id=body.scale_id,
        )
        case.weight_checks.append(check)
        advance_to(case, "inspection_in_progress")
        db.commit()
        return WeightCheckOut.model_validate(check)

    @router.post("/returns/{return_id}/images", response_model=ImageOut, status_code=201)
    async def add_return_image(
        return_id: str,
        file: Annotated[UploadFile, File(description="Station photo of the returned item")],
        db: DB,
        view: Annotated[View, Form()] = "other",
    ):
        case = load_return(db, return_id)
        if case.status == "completed":
            raise ServiceError("Return is already completed", 409)
        path, width, height = save_image(await read_upload(file, settings), "return-images")
        image = ReturnImage(view=view, file_path=path, width=width, height=height)
        case.images.append(image)
        advance_to(case, "inspection_in_progress")
        db.commit()
        return return_image_out(image)

    @router.get("/return-images/{image_id}")
    def get_return_image(image_id: int, db: DB):
        image = db.get(ReturnImage, image_id)
        if image is None:
            raise ServiceError("Image not found", 404)
        return serve(image.file_path)

    @router.post(
        "/returns/{return_id}/verifications", response_model=VerificationOut, status_code=201
    )
    def attach_verification(return_id: str, body: VerificationIn, db: DB):
        case = load_return(db, return_id)
        if not RESULT_ID.fullmatch(body.request_id):
            raise ServiceError("Unknown verification result", 404)
        result_path = data_dir / "results" / body.request_id / "result.json"
        if not result_path.is_file():
            raise ServiceError("Unknown verification result", 404)
        if db.scalar(select(Verification).where(Verification.request_id == body.request_id)):
            raise ServiceError("Result is already attached to a return", 409)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        verification = Verification(
            request_id=body.request_id,
            confidence=result["confidence"],
            decision=result["decision"],
            compared_product_id=result["compared_product"]["id"],
            identity_consistent=result["identity_consistent"],
        )
        case.verifications.append(verification)
        advance_to(case, "inspection_in_progress")
        db.commit()
        return verification_out(verification)

    @router.post("/returns/{return_id}/decision", response_model=ReturnOut, status_code=201)
    def record_decision(return_id: str, body: DecisionIn, db: DB):
        case = load_return(db, return_id)
        if case.status == "completed":
            raise ServiceError("A decision has already been recorded for this return", 409)
        case.decisions.append(Decision(**body.model_dump()))
        advance_to(case, "completed")
        db.commit()
        return return_out(case)

    return router
