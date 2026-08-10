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
SQS + DLQ
CloudWatch + SNS alarms
```

## Requisitos del operador

- cuenta AWS propia;
- AWS CLI autenticado mediante SSO/role/credenciales administradas por la entidad;
- Terraform >= 1.13;
- Docker;
- Git;
- permisos para VPC, IAM, ECS, ECR, RDS, ElastiCache, S3, KMS, Cognito, CloudFront, WAF, Route53/ACM (si usa dominio), SQS, SNS y CloudWatch.

No hay claves AWS en el repositorio.

## Flujo rápido

Desde la raíz:

```bash
# 1. State remoto + ECR
bash infrastructure/aws/scripts/01-bootstrap.sh

# 2. API -> ECR con tag basado en commit
bash infrastructure/aws/scripts/02-build-push-api.sh

# 3. Copiar variables y revisar capacidad/dominio
cp infrastructure/aws/platform/terraform.tfvars.example \
   infrastructure/aws/platform/terraform.tfvars
$EDITOR infrastructure/aws/platform/terraform.tfvars

# 4. Plan + apply de la plataforma
bash infrastructure/aws/scripts/03-apply-platform.sh

# 5. Build estático y publicación S3/CloudFront
bash infrastructure/aws/scripts/04-deploy-web.sh

# 6. Verificación básica
bash infrastructure/aws/scripts/05-smoke-test.sh
```

El `03-apply-platform.sh` siempre genera un plan antes del apply.

## Terraform state

`bootstrap/` se ejecuta una sola vez por cuenta/proyecto y crea:
- bucket S3 versionado y privado;
- KMS para cifrado;
- ECR API.

El script genera `platform/backend.hcl`, que está ignorado por Git y activa locking nativo de state mediante S3.

El state de bootstrap permanece local; la entidad debe custodiarlo o migrarlo a su sistema de state corporativo. No contiene credenciales AWS, pero sigue siendo información sensible de infraestructura.

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

Para un piloto económico se puede usar `single_nat_gateway=true`, pero eso reduce resiliencia de salida de las tareas privadas.

## Dominio

Sin dominio:

```hcl
domain_name     = ""
route53_zone_id = ""
```

CloudFront entrega una URL `https://xxxxx.cloudfront.net`.

Con Route53:

```hcl
domain_name     = "sos.ejemplo.gov.co"
route53_zone_id = "Z012345..."
```

Terraform solicita ACM en `us-east-1`, crea la validación DNS y A/AAAA hacia CloudFront.

## SMS OTP — paso externo obligatorio

Terraform crea Cognito Essentials con `SMS_OTP`, el app client `ALLOW_USER_AUTH` y el rol SNS requerido. Sin embargo, una cuenta nueva puede estar en el sandbox de AWS End User Messaging SMS. La entidad operadora debe completar el proceso AWS para poder enviar a teléfonos reales y definir límites/protecciones anti-fraude antes de habilitar OTP públicamente.

El endpoint SOS público no depende de Cognito.

## Evidencia sensible

- bucket separado y privado;
- Block Public Access completo;
- SSE-KMS por defecto;
- IAM de ECS limitado al prefijo `private/*`;
- lifecycle configurable;
- CORS configurable.

Antes de habilitar `feature_affected_identity=true`, reemplazar:

```hcl
evidence_cors_origins = ["*"]
```

por el origen exacto de producción y aprobar la política institucional de retención.

## Safe Mode

Defaults recomendados para primer despliegue:

```hcl
feature_affected_identity   = false
feature_liveness            = false
feature_assistance_matching = false
feature_whatsapp            = false
feature_operational_layers  = false
feature_secure_envelope     = false
```

Y compilar la web con:

```text
NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=false
```

Esto permite desplegar el core sin activar capacidades que todavía no superaron su gate.

## Rollback de API

Cada imagen ECR usa un tag de commit e inmutabilidad. Para volver a una versión anterior:

1. identificar el tag anterior en ECR;
2. cambiar `api_image`/`.api-image`;
3. ejecutar `03-apply-platform.sh`;
4. ECS hace rolling deployment y su circuit breaker revierte automáticamente si el nuevo deployment no estabiliza.

## Restore RDS

Ver `docs/operations/AWS_RESTORE_RUNBOOK.md`.

La IaC deja backups configurados, pero **Issue #1 no debe considerarse completamente validada hasta que la entidad ejecute un restore drill real en su cuenta** y registre evidencia del resultado.

## Destroy

Producción usa `deletion_protection=true` y RDS genera snapshot final. Destruir la plataforma debe ser una acción deliberada de la entidad, no parte de un pipeline automático.
