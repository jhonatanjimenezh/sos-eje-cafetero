# Contribuir

SOS Eje Cafetero es un proyecto humanitario open source en contexto de emergencia. Priorizamos cambios pequeños, verificables y seguros sobre grandes refactors.

## Empieza aquí

1. Lee `README.md`.
2. Lee `docs/architecture/README.md` y `docs/architecture/SYSTEM_OVERVIEW.md`.
3. Elige un workstream en `docs/contributing/WORKSTREAMS.md`.
4. Reclama un issue comentando `TOMO ESTE WORKSTREAM`.
5. Trabaja en una rama `feat/<issue>-<slug>` o `fix/<issue>-<slug>`.
6. Abre PR usando la plantilla del repositorio.

Si usas ChatGPT, Codex u otro asistente, sigue `docs/contributing/AI_HANDOFF.md` para poder distribuir el trabajo entre varias cuentas sin perder el contexto técnico.

## Reglas no negociables

- No incluya datos reales de víctimas en issues, fixtures, screenshots, logs o pruebas.
- El SOS público debe seguir funcionando sin autenticación.
- Mantenga la separación entre datos `PUBLIC`, `OPERATIONAL` y `SENSITIVE`.
- Todo cambio relacionado con despacho, matching, verificación biométrica o IA mantiene revisión humana.
- No invente criptografía. Use primitivas estándar y documente decisiones de protocolo.
- Toda entrada reintentable/webhook/offline debe ser idempotente.
- La deduplicación propone/fusiona con trazabilidad; no debe eliminar evidencia silenciosamente.
- Incluya pruebas para reglas de priorización, privacidad, geolocalización e idempotencia cuando toque esos módulos.

## Cambios de arquitectura

Si cambia un contrato compartido, criptografía, persistencia crítica, límites de confianza o topología de producción, cree un ADR en `docs/architecture/decisions/` y enlace el ADR desde el PR.

## Coordinación de emergencia

No espere a terminar un módulo gigante. Prefiera PRs verticales y pequeños que otro voluntario pueda revisar rápidamente. Si queda bloqueado, deje un `AI HANDOFF`/handoff técnico en el issue con estado, pruebas, riesgos y próximo paso.

## Seguridad

Nunca publique:

- `.env` reales;
- tokens/JWT/cookies;
- secretos AWS/Meta/GitHub;
- claves KMS/HMAC;
- cédulas/documentos;
- fotos o biometría real;
- teléfonos reales;
- dumps de producción.

Use siempre datos sintéticos.
