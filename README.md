# SOS Eje Cafetero

Centro unificado open source para respuesta a emergencias y coordinación humanitaria: incidentes geolocalizados, viviendas afectadas, desaparecidos, animales, unidades de respuesta, damnificados verificados y matching de ayuda.

> **Regla de seguridad:** pedir rescate nunca exige cuenta, documento ni biometría. El flujo reforzado de identidad se usa para el registro formal de damnificado y distribución de ayudas.

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

## Arquitectura

```text
Ciudadanos / funcionarios / WhatsApp
                 |
             CloudFront
                 |
          NestJS modular API
           /       |       \
     PostGIS     Redis      S3 privado
        |                     |
  geodatos/dedup        evidencia sensible
        |
  Centro de mando Next.js + MapLibre

Amazon Cognito + SMS OTP -> identidad
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

## Documentación

- `docs/DEPLOYMENT_AWS.md`
- `docs/IDENTITY_AND_ANTI_FRAUD.md`
- `docs/ASSISTANCE_MATCHING.md`
- `docs/SECURITY_AND_PRIVACY.md`
- `docs/API.md`
- `docs/ROADMAP.md`

## Licencia

MIT. Proyecto humanitario open source.
