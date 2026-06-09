"""
seed_db.py — Seeds known_models table with 15 reference LLMs.
Safe to re-run (ignores conflicts on name).
"""
import asyncio
import uuid

from sqlalchemy import select
from database import AsyncSessionLocal, KnownModel, create_tables

KNOWN_MODELS = [
    # Anthropic
    {"name": "Claude 3 Opus",      "source": "anthropic", "notes": "Most capable Claude 3; strong reasoning."},
    {"name": "Claude 3.5 Sonnet",  "source": "anthropic", "notes": "Fast Claude 3.5; excellent for agentic tasks."},
    {"name": "Claude 3 Haiku",     "source": "anthropic", "notes": "Smallest Claude 3; optimised for low-latency."},
    # OpenAI
    {"name": "GPT-4o",             "source": "openai",    "notes": "Flagship multimodal model; vision + text."},
    {"name": "GPT-4 Turbo",        "source": "openai",    "notes": "128k context; strong coding and instruction following."},
    {"name": "GPT-3.5 Turbo",      "source": "openai",    "notes": "Cost-efficient; widely deployed for chat."},
    # Meta
    {"name": "Llama 3 70B",        "source": "meta",      "notes": "Open-weight 70B Llama 3; strong general-purpose LLM."},
    {"name": "Llama 3 8B",         "source": "meta",      "notes": "Compact Llama 3; efficient for edge/on-device."},
    # Mistral
    {"name": "Mistral 7B",         "source": "mistral",   "notes": "Efficient 7B; outperforms larger models on many benchmarks."},
    {"name": "Mixtral 8x7B",       "source": "mistral",   "notes": "MoE: 8x7B experts, 2 active per token."},
    # Google
    {"name": "Gemini 1.5 Pro",     "source": "google",    "notes": "1M-token context; multimodal."},
    {"name": "Gemini 1.0 Ultra",   "source": "google",    "notes": "Largest first-gen Gemini; state-of-the-art on MMLU."},
    # Alibaba
    {"name": "Qwen2 72B",          "source": "alibaba",   "notes": "72B open model; strong multilingual and coding."},
    # DeepSeek
    {"name": "DeepSeek V2",        "source": "deepseek",  "notes": "236B MoE (21B active); high-efficiency architecture."},
    # Microsoft
    {"name": "Phi-3 Medium",       "source": "microsoft", "notes": "14B SLM; punches above weight on reasoning tasks."},
]

async def seed():
    await create_tables()
    async with AsyncSessionLocal() as db:
        async with db.begin():
            # Get existing names
            result = await db.execute(select(KnownModel.name))
            existing = {r[0] for r in result.fetchall()}
            new_models = [m for m in KNOWN_MODELS if m["name"] not in existing]
            for m in new_models:
                db.add(KnownModel(id=str(uuid.uuid4()), **m))
    print(f"✅ Seeded {len(new_models)} new models ({len(KNOWN_MODELS) - len(new_models)} already existed)")

if __name__ == "__main__":
    asyncio.run(seed())
