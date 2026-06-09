"""
database.py — SQLAlchemy 2.x async Postgres (asyncpg driver)
DATABASE_URL env var: postgresql+asyncpg://user:pass@host/db?ssl=require
Falls back to SQLite for local dev if DATABASE_URL not set.
"""

import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Index, String
from sqlalchemy.ext.asyncio import (
    AsyncAttrs, AsyncSession, async_sessionmaker, create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///./fingerprints.db"   # local fallback
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    **({} if DATABASE_URL.startswith("sqlite") else {"pool_size": 5, "max_overflow": 10})
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)

class Base(AsyncAttrs, DeclarativeBase):
    pass

class ModelFingerprint(Base):
    __tablename__ = "fingerprints"

    id:               Mapped[str]       = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id:           Mapped[str]       = mapped_column(String, nullable=False)
    model_name:       Mapped[str|None]  = mapped_column(String, nullable=True)
    model_type:       Mapped[str]       = mapped_column(String, nullable=False)
    fingerprint_hash: Mapped[str|None]  = mapped_column(String, nullable=True)
    fingerprint_data: Mapped[dict|None] = mapped_column(JSON, nullable=True)
    s3_model_key:     Mapped[str|None]  = mapped_column(String, nullable=True)
    status:           Mapped[str]       = mapped_column(String, nullable=False, default="pending")
    created_at:       Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False,
                                            default=lambda: datetime.now(timezone.utc))
    __table_args__ = (
        Index("ix_fingerprints_job_id", "job_id", unique=True),
        Index("ix_fingerprints_hash", "fingerprint_hash"),
    )

class KnownModel(Base):
    __tablename__ = "known_models"

    id:               Mapped[str]       = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name:             Mapped[str]       = mapped_column(String, nullable=False)
    source:           Mapped[str]       = mapped_column(String, nullable=False)
    fingerprint_hash: Mapped[str|None]  = mapped_column(String, nullable=True)
    fingerprint_data: Mapped[dict|None] = mapped_column(JSON, nullable=True)
    notes:            Mapped[str|None]  = mapped_column(String, nullable=True)

    __table_args__ = (
        Index("ix_known_models_name", "name", unique=True),
    )

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

if __name__ == "__main__":
    import asyncio
    asyncio.run(create_tables())
    print("✅ Tables created")
