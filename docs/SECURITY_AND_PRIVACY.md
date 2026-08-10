# Seguridad y privacidad

1. El reporte SOS inmediato permanece disponible sin autenticación.
2. Nunca exponer teléfono, documento, evidencia, datos médicos ni coordenadas exactas en vistas públicas.
3. Acceso operacional autenticado, autorizado por rol y auditado.
4. Documentos/videos fuera de PostgreSQL, en almacenamiento privado cifrado.
5. Para deduplicar documentos usar HMAC con secreto independiente; mostrar solo últimos caracteres cuando baste.
6. Consentimiento explícito y versionado antes de recopilar evidencia sensible cuando corresponda.
7. Retención mínima definida por la entidad responsable.
8. IA, similitud, liveness o scoring no pueden negar automáticamente rescate, ayuda vital o derechos.
9. Matching/deduplicación son sugerencias hasta confirmación humana.
10. WAF, rate limiting, protección SMS pumping, backups, Multi-AZ y operación degradada son requisitos de producción.
11. Toda lectura/descarga de evidencia sensible debe generar auditoría.

La entidad pública operadora debe revisar con su responsable jurídico y de protección de datos la base legal, política de tratamiento, autorización, transferencias y retención antes de operar a escala.
