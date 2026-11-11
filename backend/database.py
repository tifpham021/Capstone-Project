"""Records database: orders, the original item photos and weights, and returns.

SQLite by default (one file in the data directory, nothing to install). The models
use plain SQLAlchemy types, so pointing RETURNSCAN_DATABASE_URL at PostgreSQL works
without code changes. Images are stored as files; the tables keep their paths.

Weights are stored in grams.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    TypeDecorator,
    create_engine,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from backend.config import Settings

# Mirrors src/returnLifecycle.js (RETURN_STATUS) and src/ReviewDecision.jsx (decisions).
RETURN_STATUSES = ("identified", "inspection_in_progress", "awaiting_decision", "completed")
DECISION_OUTCOMES = ("approve", "secondary", "fraud")
IMAGE_VIEWS = ("front", "back", "top", "side", "label", "other")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Always UTC and timezone-aware, even on SQLite (which drops the offset)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("Datetimes must be timezone-aware")
            value = value.astimezone(timezone.utc)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Base(DeclarativeBase):
    pass


class Order(Base):
    """The original customer order, as it was shipped."""

    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # e.g. ORD-8921
    customer_name: Mapped[str | None] = mapped_column(String(200))
    customer_email: Mapped[str | None] = mapped_column(String(320))
    placed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    items: Mapped[list[OrderItem]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="OrderItem.id"
    )
    returns: Mapped[list[ReturnCase]] = relationship(back_populates="order")


class OrderItem(Base):
    """One product line in an order, with what it should weigh and look like."""

    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    # Matches a product id in the CV reference catalog (POST /v1/products), if enrolled.
    product_id: Mapped[str | None] = mapped_column(String(64), index=True)
    product_name: Mapped[str] = mapped_column(String(200))
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    # Stored now so barcode lookup can be added later without a schema change.
    barcode: Mapped[str | None] = mapped_column(String(128), index=True)
    serial_number: Mapped[str | None] = mapped_column(String(128), index=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price_cents: Mapped[int | None] = mapped_column(Integer)
    expected_weight_g: Mapped[float | None] = mapped_column(Float)
    # Allowed difference for the weight check; null uses the default rule.
    weight_tolerance_g: Mapped[float | None] = mapped_column(Float)

    order: Mapped[Order] = relationship(back_populates="items")
    images: Mapped[list[OrderImage]] = relationship(
        back_populates="item", cascade="all, delete-orphan", order_by="OrderImage.id"
    )


class OrderImage(Base):
    """A photo of the item taken before it shipped (the "original" to compare against)."""

    __tablename__ = "order_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_item_id: Mapped[int] = mapped_column(
        ForeignKey("order_items.id", ondelete="CASCADE"), index=True
    )
    view: Mapped[str] = mapped_column(String(20), default="other")
    file_path: Mapped[str] = mapped_column(String(300))  # relative to the data directory
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    item: Mapped[OrderItem] = relationship(back_populates="images")


class ReturnCase(Base):
    """A return being processed at a station."""

    __tablename__ = "returns"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # e.g. RET-1A2B3C4D5E
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    order_item_id: Mapped[int | None] = mapped_column(ForeignKey("order_items.id"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="identified", index=True)
    # What the reviewer scanned or typed to find the order (order number, SKU, serial...).
    lookup_identifier: Mapped[str | None] = mapped_column(String(128))
    station: Mapped[str | None] = mapped_column(String(64))
    reviewer_email: Mapped[str | None] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    order: Mapped[Order] = relationship(back_populates="returns")
    item: Mapped[OrderItem | None] = relationship()
    events: Mapped[list[ReturnEvent]] = relationship(
        cascade="all, delete-orphan", order_by="ReturnEvent.id"
    )
    weight_checks: Mapped[list[WeightCheck]] = relationship(
        cascade="all, delete-orphan", order_by="WeightCheck.id"
    )
    images: Mapped[list[ReturnImage]] = relationship(
        cascade="all, delete-orphan", order_by="ReturnImage.id"
    )
    verifications: Mapped[list[Verification]] = relationship(
        cascade="all, delete-orphan", order_by="Verification.id"
    )
    decisions: Mapped[list[Decision]] = relationship(
        cascade="all, delete-orphan", order_by="Decision.id"
    )


class ReturnEvent(Base):
    """Status history / audit trail for a return."""

    __tablename__ = "return_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    return_id: Mapped[str] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(200))
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class WeightCheck(Base):
    """A scale reading compared against the original order item's weight."""

    __tablename__ = "weight_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    return_id: Mapped[str] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    measured_weight_g: Mapped[float] = mapped_column(Float)
    # Copied at check time so later order edits don't rewrite history.
    expected_weight_g: Mapped[float] = mapped_column(Float)
    tolerance_g: Mapped[float] = mapped_column(Float)
    difference_g: Mapped[float] = mapped_column(Float)  # measured - expected
    difference_percent: Mapped[float] = mapped_column(Float)
    within_tolerance: Mapped[bool] = mapped_column(Boolean)
    scale_id: Mapped[str | None] = mapped_column(String(64))
    measured_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ReturnImage(Base):
    """A photo of the returned item taken at the station (top-down, side camera...)."""

    __tablename__ = "return_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    return_id: Mapped[str] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    view: Mapped[str] = mapped_column(String(20), default="other")
    file_path: Mapped[str] = mapped_column(String(300))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Verification(Base):
    """Summary of a CV result (POST /v1/verify) attached to a return.

    The full result and its discrepancy images stay in results/<request_id>/.
    """

    __tablename__ = "verifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    return_id: Mapped[str] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[str] = mapped_column(String(32), unique=True)
    confidence: Mapped[float] = mapped_column(Float)
    decision: Mapped[str] = mapped_column(String(20))  # consistent / suspicious / inconclusive
    compared_product_id: Mapped[str] = mapped_column(String(64))
    identity_consistent: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Decision(Base):
    """The reviewer's final call on a return."""

    __tablename__ = "decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    return_id: Mapped[str] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    outcome: Mapped[str] = mapped_column(String(20))  # approve / secondary / fraud
    reason: Mapped[str | None] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(Text)
    reviewer_email: Mapped[str | None] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


def create_session_factory(settings: Settings) -> sessionmaker:
    url = settings.resolved_database_url
    is_sqlite = url.startswith("sqlite")
    engine = create_engine(
        url, connect_args={"check_same_thread": False} if is_sqlite else {}, future=True
    )
    if is_sqlite:

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(connection, _record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")  # safer concurrent reads
            cursor.close()

    # Creates missing tables only. Changing an existing column later needs a
    # migration (e.g. Alembic) or deleting the dev database file.
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)
