#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

BACKUP=${1:-}
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP/postgres.dump" ]; then
  echo "Uso: $0 /ruta/al/backup" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "Falta infrastructure/onprem/.env" >&2
  exit 1
fi

set -a
. ./.env
set +a

read -r answer <<EOF || true
EOF
printf '%s' "Esto reemplazará el contenido de la base ${POSTGRES_DB:-sos}. Escriba RESTORE para continuar: "
read answer
[ "$answer" = "RESTORE" ] || { echo "Cancelado"; exit 1; }

echo "[1/2] Restaurando PostgreSQL"
docker compose --env-file .env exec -T db \
  pg_restore -U "${POSTGRES_USER:-sos}" -d "${POSTGRES_DB:-sos}" --clean --if-exists --no-owner < "$BACKUP/postgres.dump"

if [ -d "$BACKUP/minio" ]; then
  echo "[2/2] Restaurando MinIO"
  docker run --rm --network sos-eje-cafetero_backend \
    -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
    -v "$BACKUP/minio:/backup:ro" minio/mc:latest \
    mirror --overwrite /backup "local/${PRIVATE_EVIDENCE_BUCKET:-sos-private-evidence}"
else
  echo "[2/2] No hay snapshot MinIO en el backup; se omite"
fi

echo "Restore completado. Ejecute smoke tests antes de habilitar tráfico."
