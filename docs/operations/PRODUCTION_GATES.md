# Production Gates — SOS Eje Cafetero

Este documento define cuándo una versión puede exponerse a usuarios reales. El proyecto **no usa un único concepto de “producción”**: liberamos capacidades gradualmente según su nivel de riesgo.

## Principio

Una capacidad incompleta no debe bloquear todo el sistema si puede desactivarse de forma segura.

Por ejemplo, el reporte SOS online puede operar aunque Face Liveness o WebRTC relay aún no estén terminados. En cambio, ninguna capacidad debe activarse si expone datos sensibles, puede duplicar incidentes o no tiene un rollback claro.

---

## GATE 0 — INTERNAL / SANDBOX

Objetivo: desarrollo y demostración interna con **datos 100% sintéticos**.

Permitido:
- frontend público;
- API;
- PostGIS;
- centro de mando;
- OTP en entorno de pruebas;
- PWA/IndexedDB;
- simulación de unidades;
- matching con datos ficticios;
- pruebas offline.

No permitido:
- PII real;
- documentos de identidad reales;
- fotos/videos reales de víctimas;
- teléfonos ciudadanos reales salvo pruebas autorizadas;
- publicar como canal oficial.

Criterio de entrada: `main` construye y health checks básicos pasan.

---

## GATE 1 — LIMITED PRODUCTION / PILOTO INSTITUCIONAL

Objetivo: prueba controlada con funcionarios autorizados y un grupo limitado de usuarios.

### Capacidades mínimas que deben estar listas

#### Plataforma
- HTTPS/TLS.
- dominio controlado.
- API y DB no expuestas directamente a Internet.
- PostgreSQL/PostGIS cifrado.
- secretos fuera del repositorio.
- backups automáticos.
- logs y alertas básicas.
- health check.

#### SOS
- reporte SOS sin login.
- `Idempotency-Key` obligatoria/reutilizable para retries.
- deduplicación geoespacial sin auto-eliminación.
- límites de tamaño/rate.
- contacto y ubicación nunca aparecen en endpoints públicos.

#### Offline
Solo una de estas dos opciones es válida:

A. `SecureEnvelopeV1` (#8 + #9) completo y probado; o

B. desactivar temporalmente persistencia offline de payload sensible mediante feature flag.

**Nunca permitir IndexedDB persistente con GPS/teléfono/PII plaintext en un piloto real.**

#### Funcionarios
- OTP sin contraseña.
- funcionario debe estar preautorizado.
- RBAC mínimo aprobado.
- ninguna cuenta genérica compartida.
- auditoría de acciones operacionales.

#### Operación
- rollback documentado.
- runbook de caída de API/DB/SMS.
- prueba mínima de carga.
- simulacro con datos sintéticos antes de habilitar datos reales.

### Capacidades que pueden permanecer apagadas

- Face Liveness / biometría.
- documentos de identidad.
- registro formal de damnificados.
- matching automático de ayudas.
- WhatsApp.
- WebRTC/peer relay.
- mapas offline avanzados.

### Regla GO / NO-GO

GO requiere aprobación del Project Lead y al menos una persona responsable de la operación institucional.

NO-GO automático si:
- existe PII sensible persistida en plaintext;
- no existe rollback;
- una credencial real está en Git;
- los endpoints públicos exponen teléfono/GPS exacto de personas;
- una misma petición puede generar incidentes duplicados por retry;
- no hay forma de identificar quién hizo una acción operacional.

---

## GATE 2 — FULL EMERGENCY PRODUCTION

Objetivo: sistema abierto a operación real y tráfico alto durante la emergencia.

Requiere además:

### Disponibilidad
- mínimo 2 instancias API en AZ distintas.
- autoscaling probado.
- RDS Multi-AZ.
- restore de backup probado, no solo configurado.
- observabilidad y alarmas.
- WAF/rate limits.

### Offline seguro
- #8 y #9 cerradas.
- pruebas de tampering/replay.
- IndexedDB contiene ciphertext para información sensible.
- receipts e idempotencia probados.
- matriz Android/iOS documentada.

### Seguridad/identidad
Si identidad de damnificados está habilitada:
- #2 completada o alcance equivalente aprobado.
- cifrado S3/KMS.
- acceso auditado.
- política de retención/borrado.
- consentimiento institucional.
- decisión humana final.

### Instituciones
- #4 cerrada.
- procedimiento de alta/baja.
- protocolo ante teléfono perdido/robado.
- matriz RBAC definitiva.
- responsables operacionales identificados.

### Resiliencia
- #3 cerrada o criterios equivalentes demostrados.
- prueba de carga.
- degraded mode.
- restore test.
- runbooks para proveedores críticos.

---

## Feature flags obligatorias

Todas las capacidades de alto riesgo deben poder apagarse sin redeploy destructivo.

Valores de referencia:

```text
FEATURE_PUBLIC_SOS=true
FEATURE_OPERATIONAL_CENTER=true
FEATURE_OFFLINE_QUEUE=false
FEATURE_SECURE_ENVELOPE=false
FEATURE_AFFECTED_IDENTITY=false
FEATURE_LIVENESS=false
FEATURE_ASSISTANCE_MATCHING=false
FEATURE_WHATSAPP=false
FEATURE_WEBRTC_RELAY=false
FEATURE_OPERATIONAL_LAYERS=false
```

A medida que una capacidad supera su gate, se habilita explícitamente.

---

## Matriz de prioridad actual

| Issue | Gate 1 | Gate 2 | Puede avanzar paralelo |
|---|---:|---:|---:|
| #1 Infra AWS | parcial obligatorio | cierre completo | sí |
| #2 Liveness/identity | puede estar OFF | si identidad está ON | sí |
| #3 Resiliencia | subset mínimo | obligatorio | sí |
| #4 RBAC institucional | mínimo obligatorio | cierre completo | sí |
| #5 Store-and-forward | no bloquea si OFF | obligatorio para relay seguro | sí |
| #6 Capas GIS | no | no | sí |
| #8 SecureEnvelope client | obligatorio si offline ON | obligatorio | sí |
| #9 SecureEnvelope server | obligatorio si offline ON | obligatorio | sí |
| #10 WebRTC relay | no | solo si relay P2P se declara producción | sí |

---

## Política de despliegue durante la emergencia

1. cambios pequeños;
2. PR obligatorio para código;
3. migrations backwards-compatible cuando sea posible;
4. feature flag para capacidades riesgosas;
5. rollback preparado antes del deploy;
6. smoke test post-deploy;
7. datos sintéticos antes de datos reales;
8. incident commander humano puede apagar una capacidad sin esperar nuevo desarrollo.
