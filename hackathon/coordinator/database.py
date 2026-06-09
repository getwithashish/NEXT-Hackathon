"""
SQLite database schema and session management for the autonomous model discovery coordinator.
Uses SQLAlchemy 2.x declarative style (sync only).
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)

# ---------------------------------------------------------------------------
# Database location
# ---------------------------------------------------------------------------

DB_PATH = "/root/hackathon/coordinator/coordinator.db"

# Ensure parent directory exists before the engine is created
Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # SQLite-specific
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


# ---------------------------------------------------------------------------
# Declarative base
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _new_uuid() -> str:
    return str(uuid.uuid4())


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class Provider(Base):
    """Discovered AI providers."""

    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_new_uuid
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    base_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    docs_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    pricing_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    free_tier: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    requires_payment: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # Allowed values: discovered / registered / paid / fingerprinting / done / failed / skipped
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="discovered"
    )
    discovered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now_utc
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now_utc, onupdate=_now_utc
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    accounts: Mapped[list["Account"]] = relationship(
        "Account", back_populates="provider", cascade="all, delete-orphan"
    )
    payments: Mapped[list["Payment"]] = relationship(
        "Payment", back_populates="provider", cascade="all, delete-orphan"
    )
    models: Mapped[list["Model"]] = relationship(
        "Model", back_populates="provider", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Provider id={self.id!r} name={self.name!r} status={self.status!r}>"


class Account(Base):
    """Accounts created with providers."""

    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_new_uuid
    )
    provider_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("providers.id", ondelete="CASCADE"), nullable=False
    )
    email_used: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    password_used: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    api_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    tier: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    credits_remaining: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now_utc
    )

    # Relationships
    provider: Mapped["Provider"] = relationship("Provider", back_populates="accounts")

    def __repr__(self) -> str:
        return (
            f"<Account id={self.id!r} provider_id={self.provider_id!r} "
            f"email={self.email_used!r}>"
        )


class Payment(Base):
    """Payment records for providers that require a paid tier."""

    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_new_uuid
    )
    provider_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("providers.id", ondelete="CASCADE"), nullable=False
    )
    amount_usd: Mapped[float] = mapped_column(Float, nullable=False)
    stripe_card_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    stripe_charge_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Allowed values: pending / succeeded / failed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now_utc
    )

    # Relationships
    provider: Mapped["Provider"] = relationship("Provider", back_populates="payments")

    def __repr__(self) -> str:
        return (
            f"<Payment id={self.id!r} provider_id={self.provider_id!r} "
            f"amount_usd={self.amount_usd!r} status={self.status!r}>"
        )


class Model(Base):
    """Models discovered and fingerprinted at each provider."""

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_new_uuid
    )
    provider_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("providers.id", ondelete="CASCADE"), nullable=False
    )
    # The model identifier used in the provider's API (e.g. "gpt-4o")
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    # Human-readable display name
    model_name: Mapped[str] = mapped_column(String(255), nullable=False)
    fingerprint_job_id: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    fingerprint_hash: Mapped[Optional[str]] = mapped_column(
        String(512), nullable=True
    )
    # Interpretation verdict from the fingerprinting pipeline (e.g. "gpt-4o-clone")
    verdict: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    fingerprinted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    provider: Mapped["Provider"] = relationship("Provider", back_populates="models")

    def __repr__(self) -> str:
        return (
            f"<Model id={self.id!r} provider_id={self.provider_id!r} "
            f"model_id={self.model_id!r} verdict={self.verdict!r}>"
        )


# ---------------------------------------------------------------------------
# Database initialisation
# ---------------------------------------------------------------------------


def init_db() -> None:
    """Create all tables (no-op if they already exist)."""
    Base.metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# Session context manager
# ---------------------------------------------------------------------------


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """Yield a transactional SQLAlchemy Session, rolling back on error."""
    session: Session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Convenience: auto-initialise when this module is imported
# ---------------------------------------------------------------------------

init_db()
