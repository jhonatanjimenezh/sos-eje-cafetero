#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLATFORM="$ROOT/infrastructure/aws/platform"
URL="$(terraform -chdir="$PLATFORM" output -raw public_url)"
WEB_BUCKET="$(terraform -chdir="$PLATFORM" output -raw web_bucket)"
EVIDENCE_BUCKET="$(terraform -chdir="$PLATFORM" output -raw evidence_bucket)"

printf 'Smoke test: %s\n' "$URL"

curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 5 "$URL/" >/dev/null
curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 5 "$URL/api/v1/health" >/dev/null

for bucket in "$WEB_BUCKET" "$EVIDENCE_BUCKET"; do
  aws s3api get-public-access-block --bucket "$bucket" \
    --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
    --output text | grep -q $'True\tTrue\tTrue\tTrue'
done

echo "OK: web, health API y public-access-block S3"
