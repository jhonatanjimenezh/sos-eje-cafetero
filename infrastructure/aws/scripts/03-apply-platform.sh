#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLATFORM="$ROOT/infrastructure/aws/platform"
IMAGE_FILE="$ROOT/infrastructure/aws/.api-image"

[ -f "$PLATFORM/backend.hcl" ] || { echo "Ejecute 01-bootstrap.sh primero" >&2; exit 1; }
[ -f "$IMAGE_FILE" ] || { echo "Ejecute 02-build-push-api.sh primero" >&2; exit 1; }

IMAGE="$(cat "$IMAGE_FILE")"

terraform -chdir="$PLATFORM" init -reconfigure -backend-config=backend.hcl
terraform -chdir="$PLATFORM" validate
terraform -chdir="$PLATFORM" plan -out=tfplan -var="api_image=$IMAGE" "$@"
terraform -chdir="$PLATFORM" apply tfplan
rm -f "$PLATFORM/tfplan"

terraform -chdir="$PLATFORM" output
