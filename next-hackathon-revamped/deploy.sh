#!/bin/bash
# deploy.sh — Deploy revamped backend + frontend to Vercel
# Usage: VERCEL_TOKEN=<your-personal-access-token> bash deploy.sh
#
# Get a personal access token at: https://vercel.com/account/tokens
# Scope: Full Account (NOT a Connected App / vcp_ token)

set -e

if [ -z "$VERCEL_TOKEN" ]; then
  echo "Error: VERCEL_TOKEN is not set."
  echo "Get one at: https://vercel.com/account/tokens (Full Account scope)"
  exit 1
fi

ORG_ID="team_EgTdnqYB5bZFFZAE6O6YEc1R"

echo "=== Deploying backend ==="
cd "$(dirname "$0")/backend"
npm run build
vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN" --scope "$ORG_ID"
BACKEND_URL=$(vercel --token "$VERCEL_TOKEN" --scope "$ORG_ID" ls revamped-backend --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['url'])" 2>/dev/null || echo "")
echo "Backend deployed: https://$BACKEND_URL"

echo ""
echo "=== Deploying frontend ==="
cd "$(dirname "$0")/frontend"
NEXT_PUBLIC_API_URL="https://$BACKEND_URL" npm run build
vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN" --scope "$ORG_ID"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "IMPORTANT: Set these env vars in your Vercel backend project dashboard:"
echo "  DATABASE_URL       = <your Neon postgres connection string>"
echo "  EC2_BACKEND_URL    = http://54.86.179.209:8000"
echo "  VERCEL_URL         = <auto-set by Vercel>"
echo ""
echo "Then update on EC2:"
echo "  VERCEL_BACKEND_URL = https://<backend-url> in /opt/coordinator/.env"
