# next-hackathon-revamped

Revamped Model Fingerprint Verifier — FastAPI agents on EC2 + Vercel Workflows backend + Next.js frontend.

## Architecture

```
Browser → Next.js (Vercel) → Nitro backend (Vercel Workflows)
                                    ↕ HTTP
                           EC2 FastAPI (Python agents)
                                    ↕ HTTP
                           EC2 Coordinator (autonomous crawler, systemd timer)
```

## Env vars

### Vercel backend (set in Vercel project dashboard)
| Var | Value |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (e.g. `postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`) |
| `EC2_BACKEND_URL` | `http://54.86.179.209:8000` |

### Vercel frontend
| Var | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | URL of the deployed Nitro backend |

### EC2 coordinator (`/opt/coordinator/.env`)
| Var | Value |
|---|---|
| `VERCEL_BACKEND_URL` | URL of the deployed Nitro backend |
| `BACKEND_URL` | `http://54.86.179.209:8000` (existing FastAPI, for legacy path) |
| `EXA_API_KEY` | Already set |

## Deploy

```bash
# Get a personal access token at https://vercel.com/account/tokens (Full Account scope)
VERCEL_TOKEN=<your-token> bash deploy.sh
```

## DB migration

The Neon schema is in `backend/lib/db/schema.ts`.  
Run migration via Drizzle Kit:

```bash
cd backend
npx drizzle-kit push --config=drizzle.config.ts
```

Or apply manually — the table DDL matches what's in `schema.ts`.

## EC2 coordinator

```bash
# Check status
ssh -i ~/.hackathon_ec2_key.pem ec2-user@54.86.179.209 'sudo systemctl status fingerprint-coordinator.timer'

# Run manually
ssh -i ~/.hackathon_ec2_key.pem ec2-user@54.86.179.209 'sudo systemctl start fingerprint-coordinator'

# Tail logs
ssh -i ~/.hackathon_ec2_key.pem ec2-user@54.86.179.209 'sudo journalctl -u fingerprint-coordinator -f'

# Check existing backend is still up
ssh -i ~/.hackathon_ec2_key.pem ec2-user@54.86.179.209 'sudo systemctl status fingerprint-backend'
```

## Workflows

| Workflow | Trigger | Steps |
|---|---|---|
| `fingerprint-on-demand` | `POST /api/fingerprint/submit` | resolve-template → batch-0 → batch-1 → batch-2 → compare+persist |
| `payment-approval` | `POST /api/approval/start` (EC2 crawler) | persist-for-review → **HIL PAUSE** → process-approval → trigger-fingerprint |
| `crawl-fingerprint` | `POST /api/fingerprint/crawl-start` | resolve-template → batch-0 → batch-1 → batch-2 → compare+persist |

## HIL flow

1. Crawler discovers provider that needs an API key
2. Crawler POSTs to `POST /api/approval/start` → starts `payment-approval` workflow
3. Workflow pauses at step 2 (HIL)
4. Frontend `/approvals` page shows the pending provider card
5. User enters API key in the input field → Approve button becomes enabled
6. User clicks Approve → `POST /api/approval/decide/:providerId` → workflow resumes
7. Workflow saves api_key → triggers `crawl-fingerprint` workflow for each model
