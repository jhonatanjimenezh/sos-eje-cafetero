# System Overview

## Contexto

SOS Eje Cafetero es un centro unificado de información y coordinación para emergencias. Debe servir simultáneamente a ciudadanos afectados, voluntarios, funcionarios, organismos de socorro y centros de mando, incluso con conectividad parcial.

## Actores

- **Ciudadano:** reporta SOS, persona/animal, daño, necesidad u oferta de ayuda.
- **Damnificado:** completa verificación reforzada para acceder al circuito formal de ayudas.
- **Funcionario de campo:** registra hallazgos, evidencia y estado de zonas/recursos.
- **Verificador:** valida damnificados y evidencia.
- **Despachador:** asigna unidades a incidentes.
- **Coordinador:** opera matching y visión multi-organismo.
- **Administrador:** alta/baja, importación institucional y configuración.

## Contenedores

### Web/PWA
Next.js + TypeScript + MapLibre.

Responsabilidades:
- captura SOS online/offline;
- IndexedDB y Service Worker;
- mapas y capas cacheables;
- autenticación OTP cuando aplica;
- cifrado/firma local de envelopes;
- sincronización oportunista;
- futura transferencia peer-to-peer.

### API
NestJS modular monolith.

Responsabilidades:
- contratos REST;
- autenticación/autorización;
- idempotencia;
- validación y deduplicación;
- procesamiento de envelopes;
- despacho/matching;
- presigned URLs;
- auditoría.

### PostgreSQL/PostGIS
Fuente de verdad operacional y geoespacial.

### Redis
Cache, rate limiting, estados efímeros y coordinación en tiempo real.

### S3/KMS
Evidencia privada: documentos, imágenes y video. Nunca exponer por URL pública permanente.

### Cognito
Passwordless SMS OTP para ciudadanos verificados y funcionarios precargados.

### WhatsApp Cloud API
Canal alternativo de captura y guiado; `message_id` se usa como clave idempotente.

## Clasificación de información

### PUBLIC
Datos agregados o deliberadamente anonimizados. Nunca teléfono, documento, biometría o coordenada exacta de una persona vulnerable.

### OPERATIONAL
Datos exactos necesarios para organismos autorizados: incidentes, ubicación de unidades, contactos, estado de casos.

### RESTRICTED/SENSITIVE
Documento de identidad, evidencia biométrica, liveness, atributos especialmente sensibles y accesos a dicha evidencia.

## Flujos críticos

### SOS
```text
capture -> local idempotency key -> POST/sync -> incident -> dedup candidate -> command center
```
No exige login.

### Damnificado
```text
OTP -> identity profile -> GPS -> evidence -> liveness -> pending verification -> official review -> verified
```

### Ayuda
```text
verified need + compatible offer + PostGIS distance -> proposed match -> human approval -> coordinated delivery
```

### Offline
```text
capture -> encrypt/sign -> IndexedDB -> optional peer relay -> any device with Internet -> server verify/decrypt -> ACK
```

## Invariantes

- `messageId`/idempotency key estable desde el dispositivo origen.
- No hacer auto-merge destructivo de incidentes/personas.
- Un relay nunca necesita plaintext.
- El servidor puede rechazar envelopes manipulados sin procesar el payload.
- Un fallo de Cognito/OTP nunca bloquea el SOS público.
- Toda acción operacional sensible debe ser auditable.
