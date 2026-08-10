# Despliegue de emergencia en AWS

## Topología recomendada

```text
Internet / WhatsApp
        |
 Route53 + TLS
        |
 CloudFront + WAF
   |           |
Web estática  /api/* -> ALB -> ECS Fargate API (mínimo 2 tareas / 2 AZ)
                              |       |       |
                              |       |       +-> SQS workers
                              |       +----------> ElastiCache Redis
                              +------------------> RDS PostgreSQL/PostGIS Multi-AZ
                              +------------------> S3 evidencia privada + KMS

Cognito User Pool -> SMS OTP
AWS End User Messaging SMS -> celulares
CloudWatch -> logs, métricas y alarmas
```

## Puesta en producción
1. VPC con al menos dos AZ y subredes privadas para datos/API.
2. RDS PostgreSQL Multi-AZ, cifrado, backups y PostGIS.
3. Redis privado.
4. Bucket de evidencias con bloqueo de acceso público, cifrado/KMS, CORS restringido y lifecycle.
5. Cognito User Pool passwordless `SMS_OTP` y app client para web.
6. Habilitar SMS para producción antes de abrir registro público y activar controles antifraude/SMS pumping.
7. ECS Fargate API, mínimo dos tareas, health check `/api/v1/health`, autoscaling.
8. Frontend estático detrás de CloudFront y WAF; idealmente `/api/*` bajo el mismo dominio para simplificar cookies seguras.
9. Dominio `.org`, ACM/TLS.
10. CloudWatch: 5xx, latencia, CPU/memoria, conexiones/almacenamiento RDS, memoria Redis, fallos SMS y backlog SQS.

## Evidencia sensible
Documentos, selfies y videos jamás van a buckets públicos. Se suben con URLs presignadas de corta duración y se eliminan según la política oficial de retención. El IAM de la API debe ser el único principal de lectura operacional.

## Continuidad
- API en al menos dos AZ.
- RDS Multi-AZ + backups.
- Export operativo periódico a S3.
- Runbook para caída de WhatsApp/SMS.
- El reporte SOS web no depende de Cognito y continúa disponible si falla OTP.
