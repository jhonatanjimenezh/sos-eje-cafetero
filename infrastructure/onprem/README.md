# Despliegue on-premise / local

Este stack permite levantar el core de SOS Eje Cafetero en un único servidor Linux con Docker Compose. Está diseñado para laboratorio, centro de mando local o una instalación municipal que no quiera depender de AWS para cómputo/datos.

## Requisitos

- Linux x86_64/arm64 compatible con las imágenes usadas.
- Docker Engine + Compose v2.
- 4 vCPU / 8 GB RAM mínimo recomendado para piloto; ajustar según carga.
- almacenamiento persistente para PostgreSQL y MinIO.
- DNS/TLS si se expone a Internet.

## Arranque

```bash
cd infrastructure/onprem
cp .env.example .env
# Editar secretos y SITE_ADDRESS

docker compose --env-file .env up -d --build

docker compose ps
curl -f "${SITE_ADDRESS:-http://localhost}/api/v1/health"
```

La única entrada pública es Caddy. PostgreSQL, Redis y MinIO permanecen en la red interna de Compose.

## TLS

- laboratorio local: `SITE_ADDRESS=http://localhost`;
- dominio público: `SITE_ADDRESS=https://sos.ejemplo.gov.co` y apuntar DNS al servidor; Caddy puede gestionar ACME automáticamente si tiene conectividad y puertos 80/443 accesibles;
- red cerrada: usar un certificado corporativo/municipal y montar una configuración Caddy adaptada.

## Identidad y OTP

El código de autenticación actual usa Amazon Cognito SMS OTP. Por eso el perfil on-prem tiene por defecto:

```text
FEATURE_AFFECTED_IDENTITY=false
FEATURE_LIVENESS=false
ALLOW_LEGACY_COMMAND_TOKEN=true
```

`ALLOW_LEGACY_COMMAND_TOKEN=true` es solo para laboratorio/puesta en marcha. **No convierte este modo en autenticación institucional de producción.** Para operar on-prem sin AWS con funcionarios reales hay que integrar un proveedor OTP compatible y desactivar el token legacy.

El SOS público no depende de Cognito.

## Evidencia

MinIO proporciona una API S3-compatible. El API usa:

```text
S3_ENDPOINT=http://minio:9000
S3_FORCE_PATH_STYLE=true
```

y nunca publica el bucket de evidencia.

## Backup

```bash
./scripts/backup.sh
```

Genera una carpeta versionada con:
- dump PostgreSQL;
- copia de objetos MinIO mediante `mc mirror`.

Para restaurar en un entorno NUEVO:

```bash
./scripts/restore.sh /ruta/al/backup
```

Antes de producción, la organización debe ejecutar y documentar al menos un restore completo con datos sintéticos.

## Actualización

```bash
git pull
docker compose --env-file .env build
docker compose --env-file .env up -d
curl -f "${SITE_ADDRESS}/api/v1/health"
```

Mantener un backup previo a cambios de esquema o versión mayor.

## Producción on-prem

Antes de recibir datos reales:
- usar secretos únicos y largos;
- desactivar `ALLOW_LEGACY_COMMAND_TOKEN`;
- integrar autenticación institucional;
- configurar TLS real;
- monitorear espacio de disco/CPU/RAM;
- backups fuera del mismo servidor;
- firewall permitiendo únicamente 80/443 (o la red interna requerida);
- probar restore;
- ejecutar `docs/operations/PRODUCTION_GATES.md`.
