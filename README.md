# llmHash — LLM Fingerprint Verifier

> An agent-driven platform that autonomously discovers, probes, and verifies whether an AI model has been cloned or distilled from another.

![Stack](https://img.shields.io/badge/stack-Next.js%20%7C%20Nitro%20%7C%20Neon%20%7C%20Exa%20%7C%20AWS%20Bedrock-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What It Does

llmHash detects model theft at scale. It sends structured behavioral probes to any OpenAI-compatible API, converts responses into high-dimensional embeddings via AWS Bedrock Titan, and compares them against a database of known model fingerprints — returning a similarity score and a verdict: **Original**, **Clone**, or **Suspicious**.

The entire lifecycle — discovery → documentation extraction → fingerprinting → verdict — is run by a coordinated team of autonomous agents with minimal human involvement.

---

## Agent Architecture

| Agent | Role |
|---|---|
| **Crawler Agent** | Runs on AWS EC2. Continuously discovers new AI providers on the web and registers them for review. |
| **Doc Reader Agent** | Uses Exa search + Claude to autonomously read provider API docs and extract endpoint/auth/body format — no manual config needed. |
| **Fingerprint Agent** | Fires 15 structured probes at a target model, collects responses, generates a 1024-dim Bedrock Titan embedding, and computes cosine similarity against known models. |
| **Approval Agent (HIL)** | Pauses the pipeline via Vercel Workflow and waits for a human operator to approve or reject a newly discovered provider before fingerprinting proceeds. |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), Tailwind CSS, Radix UI, Recharts |
| **Backend** | Nitro v3 (serverless, Vercel preset) |
| **Workflows** | Vercel Workflow SDK v4 — durable multi-step, HIL pause |
| **Database** | Neon Postgres (serverless) via Drizzle ORM + `@neondatabase/serverless` |
| **Embeddings** | AWS Bedrock — `amazon.titan-embed-text-v2:0` (1024 dimensions) |
| **Web Search** | Exa (`exa-js`) for provider and doc discovery |
| **LLM Reasoning** | Anthropic Claude — parses Exa results into structured API templates |
| **Crawler Infra** | AWS EC2 `t3.small` (autonomous, always-on) |
| **Deployment** | Vercel (frontend + backend as separate projects) |

---

## Project Structure

```
hackathon/
└── next-hackathon-revamped/
    ├── frontend/                        # Next.js 16 app
    │   ├── app/
    │   │   ├── page.tsx                 # Dashboard
    │   │   ├── fingerprint/             # Submit a model for fingerprinting
    │   │   ├── jobs/                    # All fingerprint jobs
    │   │   ├── approvals/               # Human-in-the-loop approval queue
    │   │   └── api/                     # API routes (auth, etc.)
    │   ├── components/                  # Navbar, Charts, Badges, Skeletons...
    │   ├── lib/
    │   │   ├── api.ts                   # All backend API calls
    │   │   └── utils.ts
    │   └── middleware.ts
    │
    └── backend/                         # Nitro serverless API
        ├── routes/api/
        │   ├── fingerprint/
        │   │   ├── submit.post.ts       # POST /api/fingerprint/submit
        │   │   ├── status.[runId].get.ts   # GET /api/fingerprint/status/:runId
        │   │   └── [jobId].similar.get.ts  # GET /api/fingerprint/:jobId/similar
        │   ├── approval/
        │   │   ├── pending.get.ts       # GET /api/approval/pending
        │   │   ├── decide.[providerId].post.ts  # POST /api/approval/decide/:providerId
        │   │   └── start.post.ts        # POST /api/approval/start
        │   ├── jobs.get.ts              # GET /api/jobs (paginated)
        │   ├── stats.get.ts             # GET /api/stats
        │   └── init-db.post.ts          # POST /api/init-db
        ├── lib/
        │   └── agents/
        │       └── index.ts             # DocReaderAgent, FingerprintAgent
        └── nitro.config.ts              # Workflow SDK integration
```

---

## Environment Variables

### Frontend (`/frontend`)

| Variable | Description | Example |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL | `https://your-backend.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | Frontend base URL | `https://your-frontend.vercel.app` |

> ⚠️ `NEXT_PUBLIC_*` variables are baked in at **build time**. You must inject them as environment variables during `vercel build`, not just set them in the Vercel dashboard.

### Backend (`/backend`)

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Neon Postgres pooled connection string | `postgresql://user:pass@host/db?sslmode=require` |
| `AWS_ACCESS_KEY_ID` | AWS credentials for Bedrock | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret | `...` |
| `AWS_REGION` | AWS region | `us-east-1` |
| `EXA_API_KEY` | Exa search API key | `exa-...` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | `sk-ant-...` |
| `QSTASH_TOKEN` | Vercel Workflow QStash token | `eyJ...` |
| `QSTASH_CURRENT_SIGNING_KEY` | QStash signing key | `sig_...` |
| `QSTASH_NEXT_SIGNING_KEY` | QStash next signing key | `sig_...` |

---

## Local Development

### Prerequisites

- Node.js 20+
- A Neon Postgres database
- AWS account with Bedrock enabled (`us-east-1`)
- Exa API key
- Anthropic API key

### 1. Clone the repo

```bash
git clone git@github.com:getwithashish/NEXT-Hackathon.git
cd NEXT-Hackathon/next-hackathon-revamped
```

### 2. Install dependencies

```bash
# Frontend
cd frontend && npm install

# Backend
cd ../backend && npm install
```

### 3. Set up environment variables

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

```bash
# backend/.env
DATABASE_URL=postgresql://...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
EXA_API_KEY=...
ANTHROPIC_API_KEY=...
```

### 4. Initialize the database

```bash
curl -X POST http://localhost:3001/api/init-db
```

### 5. Run locally

```bash
# Terminal 1 — backend (port 3001)
cd backend && npm run dev

# Terminal 2 — frontend (port 3000)
cd frontend && npm run dev
```

---

## Deployment

Both frontend and backend are deployed as separate Vercel projects.

### Backend

```bash
cd backend

# Set correct project
echo '{"projectId":"<BACKEND_PROJECT_ID>","orgId":"<ORG_ID>","projectName":"backend"}' \
  > .vercel/project.json

# Build + deploy
VERCEL_TOKEN=<token> VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<project_id> \
  npx vercel build --prod && npx vercel deploy --prebuilt --prod
```

### Frontend

```bash
cd frontend

# Inject NEXT_PUBLIC vars at build time
VERCEL_TOKEN=<token> \
VERCEL_ORG_ID=<org> \
VERCEL_PROJECT_ID=<frontend_project_id> \
NEXT_PUBLIC_API_URL=https://your-backend.vercel.app \
NEXT_PUBLIC_APP_URL=https://your-frontend.vercel.app \
  npx vercel build --prod && npx vercel deploy --prebuilt --prod
```

> ⚠️ Never run both deploy scripts from the same working directory — they each need their own `.vercel/project.json` pointing to the correct project.

### After first deploy — initialize the database

```bash
curl -X POST https://your-backend.vercel.app/api/init-db
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/stats` | Dashboard stats (total jobs, verdicts) |
| `GET` | `/api/jobs` | Paginated job list. Query: `?page=1&limit=20&status=done&verdict=clone` |
| `POST` | `/api/fingerprint/submit` | Submit a model for fingerprinting |
| `GET` | `/api/fingerprint/status/:runId` | Workflow run status + step events |
| `GET` | `/api/fingerprint/:jobId/similar` | Similar fingerprints for a job |
| `GET` | `/api/approval/pending` | List providers awaiting human approval |
| `POST` | `/api/approval/decide/:providerId` | Approve or reject a provider |
| `POST` | `/api/approval/start` | Trigger approval workflow (called by crawler) |
| `POST` | `/api/init-db` | Run DB migrations |

---

## How Fingerprinting Works

1. **Submit** — provide an API endpoint, key, and optional model name
2. **Probe** — 15 structured behavioral prompts are sent to the target model
3. **Embed** — each response is converted to a 1024-dim vector via AWS Bedrock Titan Embeddings v2
4. **Compare** — cosine similarity is computed against all known model fingerprints in the database
5. **Verdict** — the system returns one of:
   - ✅ `original` — no strong match found
   - ⚠️ `suspicious` — moderate similarity to a known model
   - 🚨 `clone` — high similarity, likely distilled or copied
