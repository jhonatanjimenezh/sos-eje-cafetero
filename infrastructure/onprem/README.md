# Despliegue on-premise / local

Este stack permite levantar SOS Eje Cafetero en un único servidor Linux con Docker Compose. Está diseñado para laboratorio, centro de mando local o instalación institucional que no quiera depender de AWS para cómputo/datos.

## Requisitos

- Linux x86_64/arm64 compatible con las imágenes usadas;
- Docker Engine + Compose v2;
- 4 vCPU / 8 GB RAM mínimo recomendado para piloto; aumentar si ClamAV, carga o volumen de evidencia lo requieren;
- almacenamiento persistente para PostgreSQL, MinIO y firmas ClamAV;
- DNS/TLS si se expone a Internet.

## Arranque

```bash
cd infrastructure/onprem
cp .env.example .env
# Editar TODOS los secretos y SITE_ADDRESS

docker compose --env-file .env up -d --build
docker compose ps
curl -f "${SITE_ADDRESS:-http://localhost}/api/v1/health"
```

La única entrada pública definida por este Compose es Caddy. PostgreSQL, Redis, MinIO, ClamAV y el evidence-scanner permanecen en la red interna.

## TLS

- laboratorio local: `SITE_ADDRESS=http://localhost`;
- dominio público: `SITE_ADDRESS=https://sos.ejemplo.gov.co` y DNS hacia el servidor;
- red cerrada: certificado corporativo/institucional y Caddy adaptado.

## Identidad y OTP

El adapter OTP actual usa Amazon Cognito. Por eso el perfil on-prem mantiene por defecto:

```text
FEATURE_AFFECTED_IDENTITY=false
FEATURE_LIVENESS=false
ALLOW_LEGACY_COMMAND_TOKEN=true
```

`ALLOW_LEGACY_COMMAND_TOKEN=true` es únicamente bootstrap/laboratorio. **No es autenticación institucional production-ready.** Para una instalación 100% autónoma sin AWS debe integrarse un proveedor OTP institucional y desactivarse el token legacy.

El reporte SOS de emergencia no depende de este registro de identidad.

## Liveness portable

El modo on-prem incluido usa:

```text
LIVENESS_PROVIDER=MANUAL
```

Cuando la entidad haya validado cámara/micrófono y su política de consentimiento puede habilitar:

```text
FEATURE_LIVENESS=true
NEXT_PUBLIC_FEATURE_LIVENESS=true
NEXT_PUBLIC_LIVENESS_PROVIDER=MANUAL
```

Este adapter genera un reto aleatorio y un video corto. Es una señal adicional para revisión humana; no se presenta como equivalente estadístico a un proveedor biométrico especializado y nunca auto-aprueba ayuda.

## Evidencia privada y mínimo privilegio

MinIO proporciona la API S3-compatible. `minio-init` crea tres identidades con funciones separadas:

- `MINIO_ROOT_USER`: administración/bootstrap; no se entrega al API;
- `S3_API_ACCESS_KEY`: carga/lectura controlada del prefijo privado requerido por el API;
- `S3_SCANNER_ACCESS_KEY`: solo listar, leer y etiquetar objetos de `private/affected/`.

El API usa:

```text
S3_ENDPOINT=http://minio:9000
S3_FORCE_PATH_STYLE=true
EVIDENCE_MALWARE_SCAN_MODE=TAGGED_S3
```

El bucket no se publica. También se habilitan versioning y lifecycle de retención.

## Antimalware local

El stack incorpora:

```text
MinIO -> evidence-scanner -> clamd/ClamAV
```

El worker lee evidencia nueva, la envía por streaming a `clamd` y escribe el tag compatible:

```text
GuardDutyMalwareScanStatus=NO_THREATS_FOUND
GuardDutyMalwareScanStatus=THREATS_FOUND
```

El API consume ese contrato igual que en AWS. Con `REQUIRE_MALWARE_SCAN=true`, evidencia pendiente/infectada no puede usarse para enviar el expediente ni generar una URL oficial de descarga.

Diagnóstico:

```bash
docker compose ps clamav evidence-scanner minio
docker compose logs --tail=100 clamav
docker compose logs --tail=100 evidence-scanner
```

Usar EICAR u otro artefacto sintético aprobado para pruebas; nunca malware real.

## Retención

`EVIDENCE_RETENTION_DAYS` se transforma en lifecycle de MinIO para `private/`. El valor debe corresponder a la política aprobada por la entidad; el default del repositorio no es una decisión jurídica.

Los backups fuera de MinIO también deben entrar en la política institucional de retención/borrado.

## Backup

```bash
./scripts/backup.sh
```

Genera:
- dump PostgreSQL;
- copia de objetos MinIO mediante `mc mirror`.

Restore:

```bash
./scripts/restore.sh /ruta/al/backup
```

Antes de producción, ejecutar al menos un restore completo con datos sintéticos.

## Validación de identidad

Seguir:

- `docs/security/IDENTITY_VERIFICATION_POLICY.md`;
- `docs/operations/IDENTITY_VERIFICATION_RUNBOOK.md`;
- `docs/operations/PRODUCTION_GATES.md`.

La regla operacional central es: una necesidad puede registrarse durante la revisión, pero **matching y aprobación de recursos exigen que la identidad siga en `VERIFIED`**.

## Actualización

```bash
git pull
docker compose --env-file .env build
docker compose --env-file .env up -d
curl -f "${SITE_ADDRESS}/api/v1/health"
```

Mantener backup previo a migraciones o cambios mayores.

## Producción on-prem

Antes de recibir datos reales:

- secretos únicos y largos;
- `ALLOW_LEGACY_COMMAND_TOKEN=false` con autenticación institucional real;
- TLS real;
- antimalware sano;
- retención aprobada;
- roles/auditoría probados;
- consentimiento aprobado;
- corrección/apelación probadas;
- firewall con solo entradas necesarias;
- monitoreo CPU/RAM/disco;
- backup externo + restore probado;
- gates de producción aprobados.