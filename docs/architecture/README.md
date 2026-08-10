# Architecture Hub

Este directorio es la **fuente de verdad técnica** de SOS Eje Cafetero. Si vas a contribuir, empieza aquí antes de modificar código.

## Objetivos no negociables

1. **Salvar tiempo y conectividad:** el reporte SOS funciona sin cuenta y debe poder capturarse offline.
2. **Una sola verdad operacional:** incidentes, personas, animales, viviendas, vías, recursos y ayudas convergen en el mismo modelo geoespacial.
3. **Sin duplicados:** toda ingestión externa debe ser idempotente y la deduplicación semántica/geográfica nunca debe destruir evidencia automáticamente.
4. **Privacidad por diseño:** los datos públicos, operacionales y sensibles viven en capas de acceso distintas.
5. **Offline-first:** IndexedDB + Service Worker + sincronización oportunista. Internet es una mejora, no una precondición para capturar un hallazgo.
6. **Store-and-forward seguro:** los dispositivos intermedios transportan envelopes cifrados que no pueden leer ni alterar.
7. **Revisión humana:** IA, matching, biometría y deduplicación pueden sugerir; no toman decisiones críticas autónomas.
8. **Arquitectura simple:** modular monolith mientras sea suficiente. No introducir microservicios sin una necesidad operativa demostrable.

## Mapa documental

- [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md): contexto, contenedores y módulos.
- [`SECURE_OFFLINE_RELAY.md`](./SECURE_OFFLINE_RELAY.md): protocolo PWA/offline/store-and-forward.
- [`../IDENTITY_AND_ANTI_FRAUD.md`](../IDENTITY_AND_ANTI_FRAUD.md): OTP, identidad, evidencia y verificación.
- [`../ASSISTANCE_MATCHING.md`](../ASSISTANCE_MATCHING.md): necesidades, ofertas y coordinación.
- [`../DEPLOYMENT_AWS.md`](../DEPLOYMENT_AWS.md): topología de producción.
- [`../SECURITY_AND_PRIVACY.md`](../SECURITY_AND_PRIVACY.md): límites de exposición de datos.
- [`../contributing/WORKSTREAMS.md`](../contributing/WORKSTREAMS.md): trabajo paralelo.
- [`../contributing/AI_HANDOFF.md`](../contributing/AI_HANDOFF.md): cómo continuar el proyecto desde otra cuenta o asistente.

## Arquitectura resumida

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

## Dominios principales

- `incidents`: emergencias y afectaciones.
- `units`: recursos/unidades y asignaciones.
- `people`: desaparecidos/encontrados.
- `animals`: animales desaparecidos/encontrados.
- `affected`: damnificados y verificación.
- `assistance`: necesidades, ofertas y matches.
- `officials`: funcionarios, entidades y RBAC.
- `whatsapp`: ingestión desde Meta.
- `offline-sync`: envelopes, receipts e idempotencia (P0 en construcción).
- `operational-layers`: vías, edificios y zonas de interés (P1).

## Regla para cambios de arquitectura

Toda decisión que cambie contratos, persistencia, criptografía, límites de confianza o topología de producción debe documentarse en un ADR dentro de `docs/architecture/decisions/` y enlazarse desde este índice.
