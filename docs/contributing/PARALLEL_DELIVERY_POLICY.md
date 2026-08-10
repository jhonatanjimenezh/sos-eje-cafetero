# Parallel Delivery Policy

Objetivo: maximizar velocidad sin convertir `main` en una rama inestable durante la emergencia.

## Regla de oro

**Paralelizar por contratos y dominios, no editando los mismos archivos centrales.**

Cada workstream debe tener:
- issue;
- owner temporal;
- rama propia;
- criterio de aceptación;
- AI HANDOFF si usa asistente;
- PR pequeño.

## Carriles de trabajo

### Lane A — Production blockers
Prioridad absoluta. Puede requerir revisión inmediata.

- #8 SecureEnvelope client.
- #9 SecureEnvelope server.
- #1 infraestructura piloto.
- #4 RBAC piloto.
- subset crítico de #3.

### Lane B — Production-safe enhancements
Pueden mergearse si están detrás de feature flag y no amplían exposición de datos.

- #6 capas GIS.
- UX/accesibilidad.
- observabilidad.
- documentación/runbooks.
- importadores y herramientas administrativas.

### Lane C — Experimental
Nunca bloquea producción y debe permanecer apagado por defecto.

- #10 WebRTC relay.
- nuevas heurísticas/IA.
- optimizaciones experimentales.

## Contratos compartidos

Los siguientes contratos deben tener owner temporal antes de modificarse:
- `Incident`;
- `SecureEnvelopeV1`;
- auth/RBAC claims;
- esquema de `affected_profiles`;
- contratos de mapa operacional;
- migrations de tablas compartidas.

Si dos workstreams necesitan el mismo contrato:
1. acordar schema primero;
2. documentarlo/versionarlo;
3. cada equipo implementa contra fixtures;
4. integración en PR separado si es necesario.

## Política de PR

- ideal: < 500 líneas funcionales netas; dividir si es razonable;
- no mezclar refactor amplio con feature urgente;
- agregar `Refs #issue`;
- pruebas reproducibles;
- riesgos conocidos explícitos;
- rollback o feature flag cuando aplique.

## Merge a main

Puede mergearse si:
- mantiene backward compatibility o migración segura;
- no introduce secrets;
- no expone PII;
- tests relevantes pasan;
- la capacidad incompleta queda deshabilitada;
- existe observabilidad suficiente para detectar fallo.

No puede mergearse si:
- cambia criptografía sin ADR/revisión;
- elimina idempotencia;
- habilita una capacidad crítica por defecto sin superar el gate;
- requiere datos reales para funcionar en desarrollo;
- introduce una migration destructiva sin plan de rollback.

## Hotfix de emergencia

Para un fallo que afecta operación real:
- rama `hotfix/<slug>`;
- cambio mínimo;
- al menos una revisión humana cuando sea posible;
- rollback inmediato disponible;
- postmortem breve después de estabilizar.

La urgencia reduce alcance, **no elimina trazabilidad**.

## Cadencia recomendada

- integración continua durante el día;
- revisar Production Gate antes de cada habilitación de feature;
- deploys pequeños y frecuentes;
- evitar un “big bang” con múltiples capacidades nuevas simultáneamente.

## Estado visible

Cada workstream debe mantener en su issue uno de estos estados textuales:

```text
AVAILABLE
CLAIMED
IN_PROGRESS
BLOCKED
READY_FOR_REVIEW
DONE
```

No cerrar la issue hasta cumplir su Definition of Done.
