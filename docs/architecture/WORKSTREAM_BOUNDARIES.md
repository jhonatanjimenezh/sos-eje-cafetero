# Workstream Boundaries

Para minimizar conflictos de merge:

- PWA offline: `apps/web` + paquete local de storage; no cambia backend salvo contrato acordado.
- SecureEnvelope client: paquete compartido/client-side crypto; no decide ingestión de dominio.
- SecureEnvelope server: `apps/api` sync/crypto; consume contratos versionados.
- Infra: `infrastructure/`; no cambia comportamiento de dominio.
- Maps/layers: módulos geoespaciales y UI; no expone datos sensibles.
- Load/resilience: tests/runbooks; evita refactors funcionales salvo fixes descubiertos.

Si necesitas atravesar un límite, documenta la dependencia en el issue antes de editar.
