# Backend Deployment Plan
_Last updated: 2026-06-09_

---

## Architecture Overview

```
Internet ──► Elastic IP ──► EC2 t3.small (backend server)
                                │
                    ┌───────────┼───────────┐
                    │           │           │
                 FastAPI     S3 bucket   Neon Postgres
                (port 8000)  (models +   (jobs + known
                             results)     models)
                                │
                         EC2 workers (spawn per job,
                         self-terminate after result)
                         ┌── t3.xlarge  (small models)
                         ├── c5.2xlarge (medium models)
                         └── g4dn.xlarge (large models, GPU)
                                │
                         AWS Bedrock
                         (claude-3-haiku for API probing)
```

---

## Infrastructure

| Resource            | Details                                                            |
|---------------------|--------------------------------------------------------------------|
| Backend server      | EC2 t3.small, Amazon Linux 2023, us-east-1                        |
| Public IP           | Elastic IP (static, survives reboots)                              |
| IAM role            | `model-fingerprint-verify-lambda-role` (EC2+S3+SSM+Bedrock)       |
| Instance profile    | `model-fingerprint-ec2-profile`                                    |
| Security group      | `sg-02acfced4475f51f4` (ports 22, 8000 open)                      |
| S3 bucket           | `model-fingerprint-verify-models-1780978543` (us-east-1)          |
| Database            | Neon Postgres (free tier, serverless) — `DATABASE_URL` in .env    |
| Worker script       | `s3://.../scripts/fingerprint_worker.py` (pre-uploaded)           |

---

## Deployment Steps (automated by deploy.sh)

### 1. Pre-deploy checklist
- [ ] Neon Postgres project created → `DATABASE_URL` in `.env`
- [ ] `fingerprint_worker.py` uploaded to S3
- [ ] All env vars set in `.env`

### 2. Package & upload code
```bash
cd /root/hackathon/backend
tar czf /tmp/backend.tar.gz --exclude=__pycache__ --exclude='*.pyc' \
    --exclude=fingerprints.db --exclude='.env' .
aws s3 cp /tmp/backend.tar.gz s3://model-fingerprint-verify-models-1780978543/deploy/backend.tar.gz
```

### 3. Launch EC2 t3.small
- AMI: Amazon Linux 2023 (latest)
- Instance type: t3.small
- IAM profile: `model-fingerprint-ec2-profile`
- Security group: `sg-02acfced4475f51f4`
- User-data: installs Python, pulls code from S3, starts uvicorn as systemd service

### 4. Allocate & associate Elastic IP
- Allocate new EIP in us-east-1
- Associate with the backend instance
- Public URL: `http://<EIP>:8000`

### 5. Verify
```bash
curl http://<EIP>:8000/health
curl http://<EIP>:8000/models
```

---

## Environment Variables (on server)

```env
# AWS
AWS_DEFAULT_REGION=us-east-1
AWS_S3_BUCKET=model-fingerprint-verify-models-1780978543
EC2_SECURITY_GROUP_ID=sg-02acfced4475f51f4
EC2_IAM_INSTANCE_PROFILE=model-fingerprint-ec2-profile

# Database
DATABASE_URL=postgresql+asyncpg://user:pass@host/db?ssl=require

# App
BACKEND_HOST=0.0.0.0
BACKEND_PORT=8000
```

---

## Update / Redeploy

```bash
# Re-package + upload
tar czf /tmp/backend.tar.gz --exclude=__pycache__ --exclude='*.pyc' --exclude='fingerprints.db' --exclude='.env' -C /root/hackathon/backend .
aws s3 cp /tmp/backend.tar.gz s3://model-fingerprint-verify-models-1780978543/deploy/backend.tar.gz

# SSH into server and pull update
ssh -i ~/.hackathon_ec2_key.pem ec2-user@<EIP>
cd /opt/backend
sudo aws s3 cp s3://model-fingerprint-verify-models-1780978543/deploy/backend.tar.gz .
sudo tar xzf backend.tar.gz
sudo pip install -r requirements.txt -q
sudo systemctl restart fingerprint-backend
```

---

## Neon Postgres Setup (one-time, manual)

1. Go to https://neon.tech → Sign up (GitHub SSO)
2. New Project → name: `model-fingerprint` → Region: `us-east-1` → Postgres 16
3. Connection Details → copy connection string
4. Replace `postgresql://` with `postgresql+asyncpg://` and append `?ssl=require`
5. Add to `.env` on server as `DATABASE_URL`
6. Tables are auto-created on first server start (`create_tables()` in `on_startup`)
7. Seed: `python seed_db.py`

---

## Costs

| Resource         | Cost/mo        |
|------------------|----------------|
| EC2 t3.small     | ~$15           |
| Elastic IP       | ~$3.6          |
| S3 (< 1 GB)      | ~$0.02         |
| Neon Postgres    | Free           |
| EC2 workers      | Pay-per-job (self-terminate) |
| Bedrock (Haiku)  | ~$0.25/1M tokens |
| **Total**        | **~$19/mo + per-job** |
