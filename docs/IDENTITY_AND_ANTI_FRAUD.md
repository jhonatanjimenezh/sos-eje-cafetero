# Identidad, deduplicación y antifraude

## Principio
**SOS y rescate inmediato no requieren cuenta.** La identidad reforzada se aplica al registro formal de damnificado y a la asignación de ayudas.

## Flujo de damnificado
`SMS OTP -> nombres -> documento -> dirección -> GPS -> hogar -> consentimiento -> ID frente/reverso -> reto de video en vivo -> revisión oficial -> VERIFIED / NEEDS_INFO / REJECTED`.

El reto de video del MVP es una señal antifraude, no debe presentarse como liveness biométrico certificado. La decisión final sigue siendo humana.

## No duplicidad
- `source + source_idempotency_key` único; WhatsApp usa message ID de Meta.
- Documento: HMAC SHA-256 determinista + UNIQUE; no se almacena número completo en claro.
- Incidentes: tipo + ventana temporal + distancia PostGIS + similitud `pg_trgm`; se sugiere duplicado, no se fusiona automáticamente.
- Personas/animales: proximidad + similitud de nombre + ventana temporal.
- Necesidad activa: única por categoría y damnificado.
- Funcionario: teléfono E.164 único.
- Evidencia: SHA-256 por asset.

## Funcionarios
CSV: `full_name,agency,phone,role`. Roles: `ADMIN`, `COORDINATOR`, `DISPATCHER`, `FIELD_OPERATOR`, `VERIFIER`, `VIEWER`. El OTP solo habilita sesión si el teléfono está precargado y activo.

## Evidencia
La base guarda referencias a objetos privados; documentos y videos viven en almacenamiento privado cifrado con URLs presignadas, política de retención y auditoría.
