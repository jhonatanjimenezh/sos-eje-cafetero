#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLATFORM="$ROOT/infrastructure/aws/platform"
REGION="${TF_VAR_aws_region:-us-east-1}"

WEB_BUCKET="$(terraform -chdir="$PLATFORM" output -raw web_bucket)"
DISTRIBUTION="$(terraform -chdir="$PLATFORM" output -raw cloudfront_distribution_id)"
FEATURE_LIVENESS="$(terraform -chdir="$PLATFORM" output -raw feature_liveness)"
LIVENESS_PROVIDER="$(terraform -chdir="$PLATFORM" output -raw liveness_provider)"
TAG="sos-eje-cafetero-web-build:$(git -C "$ROOT" rev-parse --short=12 HEAD)"
TMP="$(mktemp -d)"
CID=""
trap 'test -z "$CID" || docker rm -f "$CID" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

docker build \
  --build-arg NEXT_PUBLIC_API_URL=/api/v1 \
  --build-arg NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE="${NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE:-false}" \
  --build-arg NEXT_PUBLIC_FEATURE_LIVENESS="$FEATURE_LIVENESS" \
  --build-arg NEXT_PUBLIC_LIVENESS_PROVIDER="$LIVENESS_PROVIDER" \
  --build-arg NEXT_PUBLIC_MAP_STYLE_URL="${NEXT_PUBLIC_MAP_STYLE_URL:-https://demotiles.maplibre.org/style.json}" \
  -t "$TAG" "$ROOT/apps/web"

CID="$(docker create "$TAG")"
docker cp "$CID:/usr/share/nginx/html/." "$TMP/"

aws s3 sync "$TMP" "s3://$WEB_BUCKET" --region "$REGION" --delete --cache-control "public,max-age=300"
aws s3 cp "$TMP" "s3://$WEB_BUCKET" --region "$REGION" --recursive \
  --exclude "*" --include "*.html" --include "sw.js" --cache-control "no-cache,no-store,must-revalidate"

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths '/*' >/dev/null

echo "Web desplegada: $(terraform -chdir="$PLATFORM" output -raw public_url)"
echo "Liveness web: enabled=$FEATURE_LIVENESS provider=$LIVENESS_PROVIDER"
