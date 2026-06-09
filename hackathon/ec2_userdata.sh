#!/bin/bash
set -e
exec > /var/log/user-data.log 2>&1

echo "=== Starting backend setup ==="

# Update + install Python + pip
yum update -y
yum install -y python3.11 python3.11-pip python3.11-devel gcc git

# Make python3/pip3 point to 3.11
alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1
alternatives --install /usr/bin/pip3 pip3 /usr/bin/pip3.11 1

# Create app directory
mkdir -p /opt/backend
cd /opt/backend

# Pull code from S3
aws s3 cp s3://model-fingerprint-verify-models-1780978543/deploy/backend.tar.gz /opt/backend.tar.gz
tar xzf /opt/backend.tar.gz -C /opt/backend
rm /opt/backend.tar.gz

# Pull .env from S3 (uploaded separately)
aws s3 cp s3://model-fingerprint-verify-models-1780978543/deploy/backend.env /opt/backend/.env || true

# Install dependencies
pip3 install -r /opt/backend/requirements.txt -q

# Seed DB (idempotent)
cd /opt/backend && python3 seed_db.py || true

# Write systemd service
cat > /etc/systemd/system/fingerprint-backend.service << 'EOF'
[Unit]
Description=Model Fingerprint Backend (FastAPI)
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/backend
EnvironmentFile=/opt/backend/.env
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --log-level info
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

chown -R ec2-user:ec2-user /opt/backend

systemctl daemon-reload
systemctl enable fingerprint-backend
systemctl start fingerprint-backend

echo "=== Backend setup complete ==="
