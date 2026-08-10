#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Falta infrastructure/onprem/.env" >&2
  exit 1
fi

set -a
. ./.env
set +a

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=${1:-"$ROOT/backups/$STAMP"}
MC_IMAGE=${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-07-21T05-28-08Z}
mkdir -p "$DEST/minio"

echo "[1/2] PostgreSQL -> $DEST/postgres.dump"
docker compose --env-file .env exec -T db \
  pg_dump -U "${POSTGRES_USER:-sos}" -d "${POSTGRES_DB:-sos}" -Fc > "$DEST/postgres.dump"

echo "[2/2] MinIO -> $DEST/minio"
docker run --rm --network sos-eje-cafetero_backend \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  -v "$DEST/minio:/backup" "$MC_IMAGE" \
  mirror --overwrite "local/${PRIVATE_EVIDENCE_BUCKET:-sos-private-evidence}" /backup

cat > "$DEST/metadata.txt" <<EOF
created_at=$STAMP
postgres_db=${POSTGRES_DB:-sos}
evidence_bucket=${PRIVATE_EVIDENCE_BUCKET:-sos-private-evidence}
EOF

echo "Backup completado: $DEST"
