# AWS — despliegue reproducible

Objetivo: una entidad pública puede desplegar SOS Eje Cafetero en su propia cuenta AWS sin entregar credenciales al equipo del proyecto.

## Qué aprovisiona

```text
Internet
   |
CloudFront + WAF + TLS
   |                 \
S3 web privado       ALB (solo CloudFront)
                      |
              ECS Fargate (2+ tareas)
                 /       |       \
              RDS      Redis      S3 evidencia
           PostGIS     Multi-AZ   KMS privado
              |
          backups

Cognito Essentials + SMS OTP
Rekognition Face Liveness (opcional por feature flag)
GuardDuty Malware Protection for S3
SQS + DLQ
CloudWatch + SNS alarms
```

## Requisitos del operador

- cuenta AWS propia;
- AWS CLI autenticado mediante SSO/role/credenciales administradas por la entidad;
- Terraform >= 1.13;
- Docker;
- Git;
- permisos para los servicios definidos por Terraform, incluyendo IAM, Rekognition y GuardDuty si identidad/liveness se habilitan.

No hay claves AWS en el repositorio.

## Flujo rápido

Desde la raíz:

```bash
bash infrastructure/aws/scripts/01-bootstrap.sh
bash infrastructure/aws/scripts/02-build-push-api.sh
cp infrastructure/aws/platform/terraform.tfvars.example infrastructure/aws/platform/terraform.tfvars
$EDITOR infrastructure/aws/platform/terraform.tfvars
bash infrastructure/aws/scripts/03-apply-platform.sh
bash infrastructure/aws/scripts/04-deploy-web.sh
bash infrastructure/aws/scripts/05-smoke-test.sh
```

El `03-apply-platform.sh` siempre genera un plan antes del apply.

## Terraform state

`bootstrap/` se ejecuta una sola vez por cuenta/proyecto y crea bucket S3 versionado/privado, KMS y ECR API. El script genera `platform/backend.hcl`, ignorado por Git, para state remoto con locking S3.

El state de bootstrap permanece local; la entidad debe custodiarlo o migrarlo a su backend corporativo. Aunque no sea una credencial, sigue siendo información sensible de infraestructura.

## Alta disponibilidad

Defaults de producción:

- 2 AZ mínimo;
- NAT por AZ (`single_nat_gateway=false`);
- ECS desired/min = 2;
- deployment circuit breaker + rollback;
- RDS Multi-AZ;
- Redis con 2 nodos y automatic failover;
- RDS backup 14 días;
- autoscaling ECS por CPU/memoria.

Para un piloto económico puede usarse `single_nat_gateway=true`, reduciendo resiliencia de salida.

## Dominio

Sin dominio:

```hcl
domain_name     = ""
route53_zone_id = ""
```

Con Route53:

```hcl
domain_name     = "sos.ejemplo.gov.co"
route53_zone_id = "Z012345..."
```

Terraform solicita ACM en `us-east-1`, crea validación DNS y A/AAAA hacia CloudFront.

## SMS OTP — paso externo obligatorio

Terraform crea Cognito Essentials con `SMS_OTP`, app client `ALLOW_USER_AUTH` y rol SNS. La entidad operadora debe completar requisitos de envío SMS de su cuenta, cuotas y protecciones antifraude antes de habilitar OTP para usuarios reales.

El endpoint SOS público no depende de Cognito.

## Identidad de damnificados

La infraestructura entrega la capacidad, pero queda apagada por defecto:

```hcl
feature_affected_identity = false
feature_liveness          = false
```

Antes de habilitarla leer:

- `docs/security/IDENTITY_VERIFICATION_POLICY.md`;
- `docs/operations/IDENTITY_VERIFICATION_RUNBOOK.md`;
- `docs/operations/PRODUCTION_GATES.md`.

La regla central es que OTP, documento, GPS, liveness y antimalware son señales. Solo un funcionario autorizado puede cambiar un expediente pendiente a `VERIFIED` o `REJECTED`. Matching y aprobación de ayudas revalidan `VERIFIED`.

## Face Liveness

Configuración AWS:

```hcl
feature_liveness                = true
liveness_provider               = "REKOGNITION"
liveness_max_attempts_per_24h   = 3
```

El backend:

1. crea la sesión de Face Liveness;
2. asume un rol específico para generar credenciales STS temporales;
3. el rol del navegador solo permite `rekognition:StartFaceLivenessSession`;
4. obtiene el resultado desde backend;
5. guarda provider status/confidence como señal para revisión humana.

No existe un threshold Terraform/API que auto-apruebe o auto-rechace beneficiarios.

La web recibe `feature_liveness` y `liveness_provider` desde outputs de Terraform durante `04-deploy-web.sh`; así no puede quedar accidentalmente compilada con una configuración distinta a la plataforma.

## Evidencia sensible

- bucket separado y privado;
- Block Public Access completo;
- SSE-KMS;
- IAM ECS limitado a evidencia privada requerida;
- lifecycle configurable;
- CORS configurable;
- checksum, MIME/tamaño y magic-bytes validados por aplicación;
- acceso oficial con motivo + auditoría;
- URL de descarga oficial de vida corta.

Antes de identidad real cambiar:

```hcl
evidence_cors_origins = ["https://sos.ejemplo.gov.co"]
evidence_retention_days = 90 # o la política aprobada por la entidad
enable_guardduty_malware_protection = true
require_malware_scan = true
```

El valor de retención es técnico; la entidad debe aprobar el período correspondiente.

## GuardDuty Malware Protection

Terraform crea un Malware Protection Plan para:

```text
s3://<evidence-bucket>/private/affected/
```

El rol del servicio se limita a configuración necesaria de EventBridge/S3, lectura/tagging del prefijo y uso de KMS mediante S3. El plan habilita tagging y el API consume `GuardDutyMalwareScanStatus`.

Con scanner requerido, un objeto que no esté `NO_THREATS_FOUND` no puede convertirse en evidencia elegible del expediente ni generar descarga oficial mediante el API.

## Safe Mode

Primer despliegue recomendado:

```hcl
feature_affected_identity   = false
feature_liveness            = false
feature_assistance_matching = false
feature_whatsapp            = false
feature_operational_layers  = false
feature_secure_envelope     = false
```

Y:

```text
NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=false
```

Las capacidades se habilitan únicamente después de superar su gate.

## Rollback de API

Cada imagen ECR usa tag de commit/inmutabilidad. Para volver a una versión anterior:

1. identificar tag anterior;
2. cambiar `api_image`/`.api-image`;
3. ejecutar `03-apply-platform.sh`;
4. ECS hace rolling deployment y circuit breaker revierte si no estabiliza.

## Restore RDS

Ver `docs/operations/AWS_RESTORE_RUNBOOK.md` y la aceptación operacional externa de infraestructura en #17.

## Destroy

Producción usa `deletion_protection=true` y RDS genera snapshot final. Destruir la plataforma debe ser una acción deliberada de la entidad, no parte de un pipeline automático.