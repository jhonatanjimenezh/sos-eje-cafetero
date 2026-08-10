#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BOOT="$ROOT/infrastructure/aws/bootstrap"
PLATFORM="$ROOT/infrastructure/aws/platform"

command -v terraform >/dev/null || { echo "terraform no instalado" >&2; exit 1; }
command -v aws >/dev/null || { echo "AWS CLI no instalado" >&2; exit 1; }

aws sts get-caller-identity >/dev/null

terraform -chdir="$BOOT" init
terraform -chdir="$BOOT" apply "$@"

STATE_BUCKET="$(terraform -chdir="$BOOT" output -raw state_bucket)"
STATE_KMS="$(terraform -chdir="$BOOT" output -raw state_kms_key_arn)"
REGION="${TF_VAR_aws_region:-us-east-1}"
ENVIRONMENT="${TF_VAR_environment:-prod}"

cat > "$PLATFORM/backend.hcl" <<EOF
bucket       = "$STATE_BUCKET"
key          = "sos-eje-cafetero/$ENVIRONMENT/terraform.tfstate"
region       = "$REGION"
encrypt      = true
kms_key_id   = "$STATE_KMS"
use_lockfile = true
EOF

chmod 600 "$PLATFORM/backend.hcl"

echo
printf 'Bootstrap listo.\nState bucket: %s\nECR: %s\nBackend: %s\n' \
  "$STATE_BUCKET" \
  "$(terraform -chdir="$BOOT" output -raw ecr_repository_url)" \
  "$PLATFORM/backend.hcl"
