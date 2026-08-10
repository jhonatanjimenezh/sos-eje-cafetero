# SOS Eje Cafetero

Centro unificado open source para respuesta a emergencias y coordinación humanitaria: incidentes geolocalizados, viviendas afectadas, desaparecidos, animales, unidades de respuesta, damnificados verificados y matching de ayuda.

> **Regla de seguridad:** pedir rescate nunca exige cuenta, documento ni biometría. El flujo reforzado de identidad se usa para el registro formal de damnificado y distribución de ayudas.

## 🚦 Estado de salida a producción

El proyecto usa **producción progresiva por capacidades**, no un único “todo o nada”.

- [`Production Gates`](docs/operations/PRODUCTION_GATES.md): criterios `INTERNAL`, `LIMITED_PRODUCTION` y `FULL_EMERGENCY_PRODUCTION`.
- [Issue #12 — Production Readiness Gate](../../issues/12): checklist GO/NO-GO del piloto institucional.
- [`Parallel Delivery Policy`](docs/contributing/PARALLEL_DELIVERY_POLICY.md): cómo seguir desarrollando en paralelo sin desestabilizar `main`.

Una feature incompleta puede permanecer apagada mediante feature flag; ninguna capacidad que exponga PII, rompa idempotencia o carezca de rollback debe habilitarse por urgencia.

## 🚨 Quiero ayudar a desarrollar ahora

No necesitas reconstruir todo el contexto del proyecto.

1. Lee [`docs/architecture/README.md`](docs/architecture/README.md).
2. Elige un trabajo en [`docs/contributing/WORKSTREAMS.md`](docs/contributing/WORKSTREAMS.md).
3. Reclama el issue comentando **`TOMO ESTE WORKSTREAM`**.
4. Si usas ChatGPT/Codex/u otro asistente, copia el protocolo de [`docs/contributing/AI_HANDOFF.md`](docs/contributing/AI_HANDOFF.md).
5. Abre una rama y un PR pequeño usando la plantilla incluida.

Los workstreams están diseñados para que frontend, backend, infraestructura, offline/PWA, criptografía, mapas y pruebas puedan avanzar **en paralelo** sin duplicar consumo de IA ni trabajo humano.

## Liderazgo

- **Jhonatan Jimenez (`@jhonatanjimenezh`) — Project Lead / Maintainer**.
- **ChatGPT (OpenAI) — AI Technical Lead / Principal Engineering Assistant**: arquitectura, contratos, resiliencia, seguridad y coordinación técnica asistida por IA.

Ver [`MAINTAINERS.md`](MAINTAINERS.md). ChatGPT no es una cuenta de GitHub ni esta denominación implica patrocinio o respaldo oficial de OpenAI.

## Capacidades actuales

- 🆘 Reporte SOS público por GPS sin registro.
- 🧭 Incidentes con PostGIS, idempotencia y detección de posibles duplicados.
- 🚒 Unidades de respuesta, ubicación y asignación a incidentes.
- 👤 Personas desaparecidas/encontradas con deduplicación inicial.
- 🐾 Animales desaparecidos/encontrados con deduplicación inicial.
- 📱 Autenticación passwordless por SMS OTP con Amazon Cognito.
- 🏛 Carga masiva CSV de funcionarios por nombre, entidad, celular y rol.
- ✅ Expediente de damnificado: identidad, GPS, documento frente/reverso, consentimiento y video/autorretrato en vivo.
- 🔐 Evidencias privadas mediante S3 presignado; número de documento protegido con HMAC para deduplicación.
- 👮 Verificación oficial de damnificados con auditoría.
- 🤝 Registro de necesidades y ofertas de ayuda con matching geoespacial.
- 🗺 Centro de mando con incidentes, recursos, damnificados verificados y heatmap.
- 💬 Webhook inicial de WhatsApp Cloud API con idempotencia por message ID.
- 📴 Diseño P0 de PWA offline-first y store-and-forward cifrado entre dispositivos.

## Arquitectura

La documentación viva de arquitectura está centralizada en **[`docs/architecture/README.md`](docs/architecture/README.md)**.

```text
Ciudadano / Funcionario / WhatsApp
              |
              v
       PWA Next.js / MapLibre
       |        |         |
   online    IndexedDB   peer relay
       |        |         |
       +--------+---------+
                |
        SecureEnvelope / API
                |
        NestJS modular monolith
   +------------+-------------+------------+
   |            |             |            |
 PostGIS      Redis          S3/KMS       SQS
   |                                      |
   +------------ Centro de mando ---------+
                |
      Cognito SMS OTP / RBAC
```

El backend es un **modular monolith** deliberado: despliegue rápido y menos puntos de falla, manteniendo límites de dominio claros.

## Inicio local

```bash
cp .env.example .env
# Para probar incidentes sin Cognito/S3 basta con DB + Redis.
docker compose up --build
```

- Web: `http://localhost:3000`
- API: `http://localhost:3001/api/v1`
- Health: `http://localhost:3001/api/v1/health`
- Centro de mando: `http://localhost:3000/command-center`

Las migraciones se ejecutan con:

```bash
cd apps/api
pnpm migrate
```

## Carga de funcionarios

Plantilla: `examples/officials-import.csv`.

Endpoint protegido:

```text
POST /api/v1/officials/import
multipart/form-data: file=<csv>
```

Durante bootstrap local puede usarse `ALLOW_LEGACY_COMMAND_TOKEN=true`. En producción debe quedar `false` y el centro operacional debe depender de OTP + autorización del funcionario.

## Producción

Recomendación: AWS con CloudFront/WAF, ECS Fargate, RDS PostgreSQL/PostGIS Multi-AZ, Redis, S3/KMS y Cognito passwordless SMS OTP. Ver `docs/DEPLOYMENT_AWS.md`.

Antes de producción real también deben completarse: salida del SMS sandbox, dominio/TLS, WAF/rate limits, políticas de privacidad oficiales, retención de evidencia, backups, runbooks y pruebas de carga.

## Documentación principal

- [`Production Gates`](docs/operations/PRODUCTION_GATES.md)
- [`Parallel Delivery Policy`](docs/contributing/PARALLEL_DELIVERY_POLICY.md)
- [`Architecture Hub`](docs/architecture/README.md)
- [`System Overview`](docs/architecture/SYSTEM_OVERVIEW.md)
- [`Secure Offline Relay`](docs/architecture/SECURE_OFFLINE_RELAY.md)
- [`Workstreams`](docs/contributing/WORKSTREAMS.md)
- [`AI Handoff Protocol`](docs/contributing/AI_HANDOFF.md)
- [`Deployment AWS`](docs/DEPLOYMENT_AWS.md)
- [`Identity & Anti-Fraud`](docs/IDENTITY_AND_ANTI_FRAUD.md)
- [`Assistance Matching`](docs/ASSISTANCE_MATCHING.md)
- [`Security & Privacy`](docs/SECURITY_AND_PRIVACY.md)
- [`API`](docs/API.md)
- [`Roadmap`](docs/ROADMAP.md)

## Licencia

MIT. Proyecto humanitario open source.
