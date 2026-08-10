# AI Handoff Protocol

Este documento permite que un colaborador use su propia cuenta de ChatGPT/Codex/otro asistente sin reconstruir el contexto del proyecto desde cero.

## Fuente de verdad

Antes de pedir cambios a un asistente, adjunta o enlaza como mínimo:

1. `README.md`
2. `MAINTAINERS.md`
3. `docs/architecture/README.md`
4. `docs/architecture/SYSTEM_OVERVIEW.md`
5. el issue asignado;
6. los archivos concretos del módulo a modificar.

Para trabajo offline/relay agrega `docs/architecture/SECURE_OFFLINE_RELAY.md`.

## Prompt de handoff recomendado

```text
Estás contribuyendo al repositorio open source SOS Eje Cafetero.

Objetivo humanitario: construir un centro unificado de respuesta a emergencias que funcione con conectividad degradada.

Lee primero README.md, MAINTAINERS.md, docs/architecture/README.md y docs/architecture/SYSTEM_OVERVIEW.md. Si el cambio toca offline/relay, lee también docs/architecture/SECURE_OFFLINE_RELAY.md.

Estoy trabajando exclusivamente en el issue #[NUMERO]: [TITULO].

Reglas no negociables:
- el SOS público no exige login;
- no usar datos reales de víctimas;
- PUBLIC, OPERATIONAL y SENSITIVE son capas distintas;
- no inventar criptografía;
- no autoaprobar damnificados, matching o despacho mediante IA;
- mantener idempotencia;
- no romper contratos compartidos sin ADR;
- cambios pequeños y revisables.

Antes de editar, identifica archivos afectados, invariantes y pruebas necesarias. Implementa solo el alcance del issue. Devuelve un resumen del cambio, riesgos, pruebas ejecutadas y cualquier decisión que requiera ADR.
```

## Handoff al terminar una sesión

Cada colaborador que use IA debe dejar en el issue o PR un bloque breve:

```text
AI HANDOFF
- Issue:
- Rama/PR:
- Implementado:
- Archivos principales:
- Contratos modificados:
- Pruebas ejecutadas:
- Pendiente:
- Riesgos/conocidos:
- Próximo paso recomendado:
```

No pegar cadenas de pensamiento ni conversaciones completas. Solo decisiones, evidencia técnica y estado reproducible.

## Distribución de consumo de IA

El proyecto no depende de una sesión central. Cada voluntario puede trabajar con su propia cuenta/asistente sobre un workstream independiente siempre que use los documentos y contratos del repositorio como fuente de verdad.

Esto permite paralelizar frontend, backend, infraestructura, pruebas, PWA, mapas y documentación sin duplicar todo el contexto en una sola conversación.

## Qué nunca entregar a un modelo externo

- credenciales AWS/GitHub/Meta;
- `.env` reales;
- documentos de identidad;
- fotos/videos de víctimas;
- números de teléfono reales;
- export de producción;
- secretos HMAC/KMS;
- JWTs/cookies;
- coordenadas sensibles vinculadas a una identidad real.

Usar datos sintéticos en desarrollo y soporte.
