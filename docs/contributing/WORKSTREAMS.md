# Workstreams paralelos

Objetivo: permitir que varios desarrolladores trabajen en paralelo sin duplicar esfuerzos ni romper contratos críticos.

## Cómo reclamar trabajo

1. Elige un issue abierto.
2. Comenta `TOMO ESTE WORKSTREAM` con una frase sobre el alcance que asumirás.
3. Crea una rama `feat/<issue>-<slug>` o `fix/<issue>-<slug>`.
4. No cambies contratos compartidos sin avisar en el issue.
5. Abre PR pequeño, con pruebas y notas de seguridad/privacidad cuando aplique.
6. No uses datos reales de víctimas en fixtures, screenshots, logs o PRs.

## P0 — puede comenzar ya

### WS-A — PWA offline shell
Referencia: #5.

Responsabilidad:
- Service Worker/app shell;
- IndexedDB schema/migrations;
- `outbox`, `relay_queue`, `seen_messages`, `sync_receipts`;
- captura SOS en modo avión;
- sync triggers (`online`, foreground, manual, Background Sync progresivo).

No implementar criptografía ad-hoc.

### WS-B — SecureEnvelope client
Referencia: #5 y `docs/architecture/SECURE_OFFLINE_RELAY.md`.

Responsabilidad:
- canonicalización de payload;
- generación de `messageId`;
- Web Crypto;
- cifrado autenticado;
- firma;
- persistencia local del envelope;
- tests de tampering.

La suite criptográfica se congela solo después de validar Chrome Android + Safari iOS.

### WS-C — SecureEnvelope server
Referencia: #5.

Responsabilidad:
- `POST /sync/envelopes/batch`;
- límites de tamaño/rate;
- idempotencia;
- verificación de firma;
- decrypt/authenticate;
- dispatch a domain services;
- receipts firmados;
- tests de replay/tampering.

### WS-D — Infra AWS
Referencia: #1.

Responsabilidad:
- Terraform/CDK;
- VPC multi-AZ;
- ECS Fargate;
- RDS PostgreSQL/PostGIS;
- Redis;
- S3/KMS;
- Cognito OTP;
- WAF/CloudFront;
- CloudWatch;
- CI/CD.

### WS-E — Identidad/liveness
Referencia: #2 y #4.

Responsabilidad:
- hardening OTP;
- workflow de verificación;
- auditoría de evidencia;
- liveness production-grade;
- retención/borrado;
- roles/permisos.

### WS-F — Resiliencia y carga
Referencia: #3.

Responsabilidad:
- k6/Artillery;
- SLOs;
- degraded mode;
- backups/restore;
- circuit breakers;
- runbooks de proveedores caídos.

## P1 — puede avanzar en paralelo si no bloquea P0

### WS-G — Capas geoespaciales
Referencia: #6.

- vías bloqueadas;
- edificaciones afectadas;
- zonas de interés;
- refugios/hospitales/puntos de ayuda;
- cache offline por bbox/versionado.

### WS-H — WebRTC relay spike
Referencia: #5.

- pairing QR;
- `RTCDataChannel`;
- intercambio `have/need` por messageId/digest;
- transferencia de envelopes pequeños;
- matriz Android/iOS/desktop.

No convertir este spike en dependencia del SOS offline local.

### WS-I — UX de crisis/accesibilidad

- formularios de una mano;
- modo alto contraste;
- mensajes claros bajo estrés;
- estados offline/sync visibles;
- español simple;
- accesibilidad WCAG;
- reducción extrema de pasos para SOS.

## Contratos que no deben romperse sin ADR

- `Incident` y claves idempotentes;
- `SecureEnvelopeV1`;
- separación PUBLIC/OPERATIONAL/SENSITIVE;
- OTP sin contraseña;
- SOS sin autenticación obligatoria;
- verificación humana para damnificados/matching;
- datos geoespaciales PostGIS.

## Coordinación entre workstreams

Cuando dos equipos compartan contrato, uno es **owner temporal del contrato** y el otro trabaja contra fixtures/schema versionado. Evitar editar el mismo archivo central simultáneamente.

Los contratos compartidos deben vivir en un paquete común cuando su implementación comience (`packages/contracts`), con versionado explícito y tests.
