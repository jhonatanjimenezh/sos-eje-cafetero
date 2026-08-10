#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BOOT="$ROOT/infrastructure/aws/bootstrap"

command -v docker >/dev/null || { echo "docker no instalado" >&2; exit 1; }
command -v aws >/dev/null || { echo "AWS CLI no instalado" >&2; exit 1; }

ECR_REPO="$(terraform -chdir="$BOOT" output -raw ecr_repository_url)"
REGISTRY="${ECR_REPO%%/*}"
REPOSITORY="${ECR_REPO#*/}"
TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}"
IMAGE="$ECR_REPO:$TAG"
REGION="${TF_VAR_aws_region:-us-east-1}"

if aws ecr describe-images --region "$REGION" --repository-name "$REPOSITORY" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
  echo "La imagen ya existe y ECR es inmutable: $IMAGE"
else
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  docker build -f "$ROOT/apps/api/Dockerfile" -t "$IMAGE" "$ROOT"
  docker push "$IMAGE"
fi

printf '%s\n' "$IMAGE" > "$ROOT/infrastructure/aws/.api-image"
echo "$IMAGE"
