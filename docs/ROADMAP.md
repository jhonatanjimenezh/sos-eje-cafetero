# Roadmap de emergencia

## P0 — antes de producción pública
- Infra AWS HA + dominio/TLS/WAF.
- Cognito SMS OTP fuera de sandbox y protección SMS pumping.
- Bucket privado de evidencias + KMS + lifecycle.
- RBAC final y auditoría de lectura de evidencia.
- Pruebas de carga y backups/restauración.
- Política institucional de privacidad/retención.

## V0.2
- SSE/WebSockets para actualización inmediata del centro de mando.
- PWA offline-first + background sync.
- Fotos/video/audio de incidentes en S3.
- Transcripción de audio y extracción estructurada con IA, siempre con revisión humana.
- Matching asistido entre personas/animales desaparecidos y encontrados.
- Refugios, hospitales, puntos de agua/alimentos y cierres viales.

## V1
- Turnos, capacidad de recursos y despacho completo.
- Analítica por municipio/comuna/barrio.
- Integraciones institucionales y exportación GeoJSON/CSV.
- Alta disponibilidad y recuperación ante desastre.
