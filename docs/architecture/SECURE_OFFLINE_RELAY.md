# Secure Offline Relay

Estado: **implementación del repositorio en #5 / #8 / #9 / #10**. La aceptación física en dispositivos y redes reales se registra por separado.

## Problema

Durante una emergencia un teléfono puede perder Internet durante horas. El reporte debe poder sobrevivir localmente y, cuando exista un camino, viajar directamente al servidor o mediante otros dispositivos.

El diseño parte de un supuesto deliberadamente hostil:

> **Un relay no es confiable.** Puede pertenecer a un desconocido, estar comprometido o intentar observar, alterar, duplicar, retener o fabricar tráfico.

Por eso el relay recibe solamente ciphertext y metadata mínima firmada. No obtiene GPS, teléfono, nombre, documento, dirección ni descripción en texto claro.

## Lo que la criptografía sí y no garantiza

SecureEnvelope protege:

- confidencialidad del payload durante almacenamiento/transporte offline;
- integridad del ciphertext y de los headers inmutables;
- procedencia de una clave de dispositivo concreta;
- detección de replay/conflicto por `messageId` + digest;
- autenticidad del ACK emitido por el servidor.

SecureEnvelope **no** demuestra:

- identidad civil del emisor;
- que alguien sea realmente damnificado;
- que un voluntario sea confiable;
- que el contenido declarado sea verdadero;
- que un teléfono no haya sido robado.

La verificación de damnificados/beneficiarios corresponde al módulo de identidad (#2) y la decisión operacional sigue siendo humana.

## Suite criptográfica V1

Identificador congelado:

```text
SEV1-RSA-OAEP-256+A256GCM+ECDSA-P256-SHA256
```

Primitivas:

- **payload:** AES-256-GCM;
- **DEK:** 256 bits aleatorios por mensaje;
- **wrapping DEK:** RSA-OAEP con SHA-256;
- **clave pública del servidor:** RSA-3072;
- **firma de origen:** ECDSA P-256 + SHA-256;
- **digest:** SHA-256 del ciphertext;
- **receipt del servidor:** RSA-PSS + SHA-256 con una segunda clave RSA-3072.

No se diseñan primitivas criptográficas propias. Web y API consumen el mismo paquete `@sos/secure-envelope` para canonicalización y contrato.

## SecureEnvelopeV1

```ts
export interface SecureEnvelopeV1 {
  version: 1;
  messageId: string;              // UUID estable de transporte/dominio idempotente
  emitterKeyId: string;           // SHA-256(SPKI público del dispositivo)
  emitterPublicKeySpki: string;   // P-256 SPKI, público
  createdAt: string;
  expiresAt: string;
  kind: 'INCIDENT' | 'PERSON' | 'ANIMAL' | 'RESOURCE' | 'AFFECTED_PROFILE';
  cryptoSuite: string;
  serverKeyId: string;
  iv: string;                     // 96-bit GCM nonce
  wrappedKeyForServer: string;    // DEK RSA-OAEP-SHA256
  ciphertext: string;             // payload + GCM tag
  ciphertextSha256: string;
  signature: string;              // ECDSA P-256/SHA-256
}
```

V1 habilita inicialmente `INCIDENT` en el servidor. Los demás `kind` permanecen reservados para evoluciones compatibles del protocolo.

Los headers externos al ciphertext contienen solo lo necesario para criptografía, TTL, routing mínimo y deduplicación. No deben contener PII.

## Canonicalización y AAD

Headers inmutables:

```text
version
messageId
emitterKeyId
emitterPublicKeySpki
createdAt
expiresAt
kind
cryptoSuite
serverKeyId
iv
wrappedKeyForServer
```

Se canonicalizan ordenando recursivamente las claves del objeto. La representación exacta se comparte entre browser y servidor.

```text
AAD = canonical(headers_inmutables)
signed = canonical({ headers: headers_inmutables, ciphertextSha256 })
```

Modificar TTL, kind, key ID, IV o wrapped DEK rompe la firma y/o autenticación GCM.

## Emisión en browser

```text
payload estructurado
      |
random AES-256 DEK
      |
AES-256-GCM(payload, AAD=headers)
      |
RSA-OAEP-SHA256(DEK, server public key)
      |
SHA-256(ciphertext)
      |
ECDSA-P256-SHA256(headers + digest)
      |
SecureEnvelopeV1
      |
IndexedDB/outbox
```

La clave privada ECDSA se guarda como `CryptoKey` no exportable cuando el navegador lo soporta. Si el navegador no puede conservar la clave con las propiedades requeridas, la persistencia sensible falla cerrada: **no se degrada a plaintext**.

Antes de una caída de red, la PWA precarga `/api/v1/sync/crypto-config`, que contiene únicamente material público y límites del protocolo.

## Migración IndexedDB segura

La versión antigua del `outbox` podía contener el payload original. Al pasar a DB v2:

1. se elimina deliberadamente el store `outbox` legacy;
2. no se intenta migrar PII plaintext;
3. se crean stores de ciphertext/estado:
   - `outbox`;
   - `relay_queue`;
   - `seen_messages`;
   - `sync_receipts`;
   - `device_keys`;
   - `sync_config`.

No existe un fallback que escriba GPS/teléfono/descripción en claro si la criptografía falla.

## Relay

Un relay puede:

1. intercambiar inventario `messageId + ciphertextSha256`;
2. pedir IDs faltantes (`NEED`);
3. recibir/verificar firma/digest/TTL sin descifrar;
4. guardar el envelope en `relay_queue`;
5. reenviarlo a otro peer o al servidor;
6. transportar receipts firmados del servidor.

Un relay **no puede**:

- descifrar el payload;
- reescribir headers firmados sin ser detectado;
- cambiar ciphertext sin romper digest/GCM;
- fabricar un receipt válido del servidor;
- convertir su propia clave en autorización institucional.

## Protocolo have/need

Mensajes de control V1:

```text
INVENTORY -> [(messageId, digest), ...] + receipt IDs
NEED      -> message IDs faltantes + receipt IDs faltantes
ENVELOPE  -> SecureEnvelopeV1
RECEIPT   -> SyncReceiptV1
PING
```

`seen_messages` conserva IDs/digests observados para cortar loops obvios. El mismo `messageId` con un digest distinto se trata como conflicto/tampering y no se propaga automáticamente.

V1 limita inventario, queue, TTL y tamaño. No implementa flooding indiscriminado.

## WebRTC

Primer transporte peer-to-peer web:

- `RTCDataChannel` ordenado;
- `RTCPeerConnection({ iceServers: [] })` para el modo offline;
- pairing manual offer/answer;
- el SDP puede revelar información de red local y no debe publicarse en canales abiertos;
- WebRTC es mejora progresiva: el SOS directo a Internet sigue funcionando sin P2P.

La presencia del código WebRTC **no demuestra** que dos modelos concretos de Android/iPhone puedan conectarse en todas las topologías de hotspot/Wi-Fi Direct. Eso exige una matriz física de aceptación.

## Ingestión server-side

```text
POST /api/v1/sync/envelopes/batch
   |
size / rate / batch limits
   |
version + suite + TTL + serverKeyId
   |
SHA-256(ciphertext)
   |
SHA-256(emitter SPKI) == emitterKeyId
   |
ECDSA signature
   |
revocation check
   |
PostgreSQL advisory lock(messageId)
   |
replay/digest conflict
   |
unwrap RSA-OAEP-SHA256 DEK
   |
AES-256-GCM decrypt/authenticate
   |
strict payload + DTO validation
   |
IncidentsService(..., idempotency=secure:<messageId>)
   |
signed server receipt
```

Las validaciones criptográficas ocurren antes del servicio de dominio. Un envelope rechazado no crea un incidente.

## Replay e idempotencia

Dos barreras:

1. `secure_sync_messages.message_id` + advisory lock serializan procesamiento concurrente;
2. `IncidentsService` recibe `source_idempotency_key = secure:<messageId>`.

Casos:

- mismo `messageId` + mismo digest -> `ALREADY_PROCESSED`;
- mismo `messageId` + digest distinto -> `REJECTED / MESSAGE_ID_DIGEST_CONFLICT`;
- pérdida del ACK después del commit -> retry devuelve resultado lógico sin duplicar dominio.

## Receipt firmado

```ts
export interface SyncReceiptV1 {
  version: 1;
  messageId: string;
  ciphertextSha256: string;
  status: 'ACCEPTED' | 'ALREADY_PROCESSED' | 'REJECTED';
  receivedAt: string;
  publicEntityId?: string;
  reasonCode?: string;
  receiptSigningKeyId: string;
  receiptSignatureSuite: 'RSA-PSS-SHA256';
  serverSignature: string;
}
```

El cliente elimina un envelope pendiente solo después de verificar la firma del receipt y su binding a `messageId + ciphertextSha256`.

Un relay malicioso puede borrar/retener un mensaje y causar pérdida de disponibilidad, pero no puede falsificar que el centro de mando lo recibió.

## Claves del servidor

### AWS

Dos claves KMS asimétricas separadas:

- RSA-3072 `ENCRYPT_DECRYPT` para unwrap de DEK;
- RSA-3072 `SIGN_VERIFY` para receipts.

El task role puede usar únicamente `Decrypt/GetPublicKey` en la primera y `Sign/GetPublicKey` en la segunda. El navegador recibe solamente SPKI público.

### On-prem

Dos RSA-3072 privadas se generan fuera del repositorio dentro de un volumen persistente y se montan read-only en API.

La entidad debe respaldar y custodiar la clave de decrypt mientras puedan existir envelopes pendientes. Perderla hace esos ciphertext irrecuperables.

## Rotación

La rotación no debe destruir disponibilidad:

1. publicar una nueva clave pública con nuevo `serverKeyId`;
2. mantener la privada anterior disponible durante al menos `maxEnvelopeTtlSeconds` + margen operacional;
3. nuevos clientes emiten con la nueva;
4. servidor acepta temporalmente ambas;
5. retirar la anterior solo cuando no puedan quedar envelopes válidos pendientes.

V1 de código expone una clave activa. La operación de rotación/overlap debe validarse antes de una rotación real en emergencia.

## Teléfono perdido o robado

`secure_device_keys` permite marcar un `emitterKeyId` como revocado. Después de `revoked_at` el servidor rechaza nuevos envelopes de esa clave.

Limitación importante: la revocación requiere que el servidor conozca el key ID y que exista conectividad para distribuir/ejecutar la decisión. No sustituye procedimientos institucionales para pérdida de teléfono.

## Service Worker / Cache Storage

El Service Worker guarda únicamente shell público. Existe una frontera explícita:

```js
if (url.pathname.startsWith('/api/')) return;
```

No se cachean respuestas API, OTP, identidad, crypto-config, receipts, evidencias ni endpoints de mando.

Background Sync no implementa una segunda copia del protocolo: solicita a una ventana activa ejecutar el mismo pipeline SecureEnvelope.

## Límites V1

- batches pequeños;
- ciphertext estructurado pequeño;
- TTL finito;
- `outbox` y `relay_queue` acotados;
- inventario acotado;
- fotos/videos grandes **no** viajan por relay V1;
- métricas server-side agregadas y sin PII;
- la telemetría nunca bloquea un reporte de emergencia.

## Degraded mode

Si el proveedor criptográfico server-side no está disponible:

- API responde error reintentable;
- cliente conserva ciphertext;
- no purga la cola;
- no envía plaintext como fallback.

Si la PWA no puede inicializar almacenamiento criptográfico offline pero existe Internet:

- el SOS online directo sigue funcionando;
- se deshabilita solamente la persistencia sensible offline.

Seguridad y disponibilidad no se resuelven bloqueando innecesariamente el canal normal de emergencia.

## Threat model mínimo cubierto

- relay curioso;
- relay que modifica headers/ciphertext;
- receipt falso;
- replay/reenvíos repetidos;
- loops de propagación;
- envelope expirado;
- payload gigante/DoS básico;
- clave de dispositivo revocada;
- metadata que filtre identidad;
- caída temporal del proveedor criptográfico.

Fuera de alcance criptográfico puro:

- fraude humano;
- teléfono robado antes de revocación;
- coerción física;
- dispositivo completamente comprometido antes de cifrar;
- bloqueo/jamming de radio/red;
- veracidad del contenido.

## Evidencia automatizada

El gate `Secure offline relay validate` ejecuta sobre API/DB reales con claves RSA-3072 efímeras:

- envelope browser-compatible -> server -> incidente -> receipt firmado;
- 10 entregas del mismo envelope -> exactamente 1 incidente;
- ciphertext alterado -> rechazo;
- firma alterada -> rechazo;
- header firmado alterado -> rechazo;
- batch mixto aísla inválido y procesa válido;
- envelopes rechazados -> 0 entidades de dominio.

La compatibilidad física A→B→C, cierre/reapertura del navegador, batería y topologías locales se prueban en la issue de aceptación operacional.
