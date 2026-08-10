# Infrastructure

Este directorio contiene despliegues reproducibles para que una autoridad pueda operar SOS Eje Cafetero sin depender del equipo original.

## Modos soportados

### AWS

`infrastructure/aws/`

Topología orientada a producción y alta disponibilidad:

- CloudFront + WAF;
- frontend estático privado en S3;
- ALB público restringido a CloudFront;
- ECS Fargate en subredes privadas;
- RDS PostgreSQL/PostGIS Multi-AZ;
- ElastiCache Redis con cifrado en tránsito y reposo;
- S3 privado/KMS para evidencia;
- Cognito Essentials con SMS OTP passwordless;
- SQS, CloudWatch, autoscaling y alarmas.

Terraform NO contiene credenciales. El operador entrega sus credenciales mediante el mecanismo estándar de AWS CLI/SSO/roles.

### On-premise / local

`infrastructure/onprem/`

Stack autocontenido para laboratorio, centro de datos municipal o servidor local:

- Caddy como reverse proxy;
- Web estática;
- NestJS API;
- PostgreSQL/PostGIS;
- Redis;
- MinIO como almacenamiento S3-compatible para evidencia;
- volúmenes persistentes y scripts de backup/restore.

Por defecto las capacidades de identidad/liveness permanecen OFF en on-prem porque la autenticación actual de producción usa Cognito SMS OTP. El core SOS, mapas, incidentes y centro operacional puede ejecutarse localmente. Un proveedor OTP on-prem debe integrarse antes de habilitar identidad real sin AWS.

## Política

- Ningún secreto real se versiona.
- Todo despliegue parte de archivos `.example`.
- Los defaults de funciones sensibles son OFF.
- Producción requiere ejecutar `docs/operations/PRODUCTION_GATES.md`.
- La IaC aprovisiona; la organización operadora decide región, dominio, presupuesto, retención y políticas institucionales.
