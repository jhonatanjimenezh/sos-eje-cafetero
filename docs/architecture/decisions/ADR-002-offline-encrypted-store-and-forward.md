# ADR-002 — Offline-first con store-and-forward cifrado

- Estado: **Accepted / Implemented in repository**
- Fecha: 2026-08-10
- Issues: #5, #8, #9, #10

## Contexto

Puede existir conectividad móvil intermitente o nula. Un reporte capturado debe sobrevivir localmente y poder llegar al servidor posteriormente, incluso mediante otros dispositivos que no son confiables.

El diseño debe tolerar:

- relays curiosos o maliciosos;
- modificación de mensajes;
- replay y múltiples rutas;
- pérdida de un ACK después de commit;
- interrupción temporal del proveedor criptográfico;
- dispositivos que no soporten de forma segura la persistencia requerida.

Al mismo tiempo, una falla del modo offline no debe inutilizar el SOS normal cuando sí existe Internet.

## Decisión

La PWA usa IndexedDB y Service Worker, pero **ningún payload sensible puede persistirse en plaintext**.

Cada reporte offline se representa mediante `SecureEnvelopeV1`:

```text
SEV1-RSA-OAEP-256+A256GCM+ECDSA-P256-SHA256
```

- AES-256-GCM para payload;
- DEK aleatoria de 256 bits por mensaje;
- RSA-OAEP SHA-256 / RSA-3072 para envolver la DEK al servidor;
- ECDSA P-256/SHA-256 para firma del dispositivo;
- SHA-256 del ciphertext para inventario/deduplicación;
- RSA-PSS/SHA-256 con una segunda RSA-3072 para receipts del servidor.

Los headers inmutables se canonicalizan en el paquete compartido `@sos/secure-envelope` y forman el AAD de AES-GCM. La firma cubre esos headers y el digest del ciphertext.

El servidor es el destinatario criptográfico. Un relay solo puede inspeccionar metadata mínima, verificar integridad/firma pública y transportar ciphertext/receipts.

## Idempotencia

`messageId` es UUID estable durante toda la vida del mensaje.

Server-side se combinan:

1. `secure_sync_messages.message_id`;
2. advisory lock PostgreSQL por `messageId`;
3. `source_idempotency_key = secure:<messageId>` en el servicio de incidentes.

Un replay idéntico devuelve `ALREADY_PROCESSED`; un mismo ID con digest distinto se rechaza.

## ACK

El servidor devuelve `SyncReceiptV1` firmado. El cliente solo purga ciphertext después de verificar:

- firma RSA-PSS;
- `receiptSigningKeyId` esperado;
- binding exacto a `messageId + ciphertextSha256`.

Esto evita que un relay pueda fingir que el reporte ya llegó al centro de mando.

## Claves

### Browser

La clave privada del emisor es ECDSA P-256 y se persiste como `CryptoKey` no exportable cuando el navegador lo permite. Si no puede conservarse de forma segura, la persistencia offline falla cerrada.

### AWS

Dos claves asimétricas KMS separadas:

- RSA-3072 ENCRYPT_DECRYPT;
- RSA-3072 SIGN_VERIFY.

### On-prem

Dos RSA-3072 privadas generadas fuera de Git y guardadas en volumen persistente montado read-only en API.

## Relay

WebRTC `RTCDataChannel` es el primer transporte P2P web-first. Usa protocolo have/need por IDs/digests. No es requisito del envío directo a Internet y no transporta evidencia multimedia pesada en V1.

El código WebRTC se considera implementado, pero su comportamiento en topologías/dispositivos reales requiere aceptación física separada.

## Decisiones asociadas

- hash no sustituye cifrado;
- firma de dispositivo no equivale a identidad civil ni veracidad;
- ningún relay se considera confiable;
- no plaintext fallback;
- service worker no cachea `/api/`;
- `FEATURE_SECURE_ENVELOPE` y `FEATURE_WEBRTC_RELAY` permanecen apagables;
- un outage criptográfico server-side conserva ciphertext para retry;
- si falla solo la persistencia offline pero hay Internet, el SOS online permanece disponible;
- evidencia multimedia pesada no viaja por relay V1.

## Consecuencias

Positivas:

- relays no pueden leer el reporte;
- modificación y receipts falsos son detectables;
- retries/múltiples rutas no duplican incidentes;
- AWS y on-prem comparten contrato;
- el P2P puede evolucionar sin rediseñar el envelope.

Costos/riesgos:

- pérdida de la private key de decrypt on-prem hace irrecuperables envelopes pendientes;
- rotación requiere overlap de claves durante TTL;
- browser/device storage debe probarse físicamente;
- P2P depende de la topología local y no puede prometerse universalmente;
- un dispositivo comprometido antes de cifrar sigue pudiendo producir datos falsos.

## Evidencia de implementación

El workflow `Secure offline relay validate` ejecuta interoperabilidad Web Crypto ↔ API, tampering, replay, mixed batches y signed receipts contra PostgreSQL/PostGIS real. La matriz Android/iOS, cierre/reapertura y A→B→C quedan en aceptación operacional externa.
