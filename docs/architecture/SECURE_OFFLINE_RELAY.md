# Secure Offline Relay

Estado: **P0 / en construcción**. Issue de referencia: #5.

## Problema

Durante una emergencia un teléfono puede no tener Internet durante horas. El reporte debe sobrevivir localmente y, cuando sea posible, viajar a otros dispositivos hasta alcanzar uno con conectividad. Los relays no deben poder leer ni modificar el contenido.

## Principio criptográfico

Un hash **no cifra**. El protocolo usa:

- cifrado autenticado del payload;
- wrapping de la clave de datos para el servidor;
- firma digital del dispositivo origen;
- digest para integridad/deduplicación;
- idempotencia server-side.

No se diseñarán primitivas criptográficas propias.

## Envelope v1

```ts
export interface SecureEnvelopeV1 {
  version: 1;
  messageId: string;
  emitterKeyId: string;
  createdAt: string;
  expiresAt: string;
  kind: 'INCIDENT' | 'PERSON' | 'ANIMAL' | 'RESOURCE' | 'AFFECTED_PROFILE';
  cryptoSuite: string;
  iv: string;
  wrappedKeyForServer: string;
  wrappedKeyForEmitter?: string;
  ciphertext: string;
  ciphertextSha256: string;
  signature: string;
}
```

Los campos de routing no pueden contener nombre, teléfono, documento, dirección ni GPS exacto.

## Emisión

```text
canonical payload
    |
random 256-bit DEK
    |
AES-256-GCM(payload, AAD=headers)
    |
wrap DEK -> server public key
    |
SHA-256(ciphertext)
    |
sign(headers + digest)
    |
IndexedDB/outbox
```

La suite exacta de wrapping/firma debe elegirse mediante spike interoperable con Web Crypto en Chrome Android y Safari iOS antes de congelar `cryptoSuite`.

## Relay

Un relay:

1. recibe un envelope;
2. valida formato/tamaño/TTL básico sin descifrar;
3. comprueba `messageId` contra `seen_messages`;
4. almacena ciphertext en `relay_queue`;
5. lo reenvía cuando tenga una oportunidad;
6. nunca cambia headers firmados ni ciphertext.

La firma demuestra procedencia/integridad de una clave de dispositivo; **no demuestra que el reporte sea verdadero**.

## Ingestión server-side

```text
POST /api/v1/sync/envelopes/batch
   |
size/rate limits
   |
messageId + digest idempotency
   |
validate signature
   |
unwrap DEK
   |
AES-GCM decrypt/authenticate
   |
schema validation
   |
domain service
   |
transaction
   |
signed receipt
```

Un envelope repetido debe devolver el mismo resultado lógico sin crear una segunda entidad.

## Receipt

```ts
export interface SyncReceipt {
  messageId: string;
  status: 'ACCEPTED' | 'ALREADY_PROCESSED' | 'REJECTED';
  receivedAt: string;
  publicEntityId?: string;
  reasonCode?: string;
  serverSignature: string;
}
```

Los receipts también pueden propagarse entre dispositivos para limpiar colas posteriormente.

## IndexedDB

Stores mínimos:

- `outbox`: envelopes propios pendientes;
- `relay_queue`: envelopes de terceros;
- `seen_messages`: IDs/digests observados;
- `sync_receipts`: ACKs conocidos;
- `device_keys`: material criptográfico local;
- `offline_map`: capas geoespaciales cacheadas;
- `sync_state`: cursores/versiones.

Solicitar almacenamiento persistente cuando el navegador lo soporte. Nunca asumir que el navegador conservará almacenamiento indefinidamente.

## Triggers de sincronización

No depender solo de Background Sync:

- carga de aplicación;
- evento `online`;
- `visibilitychange`/foreground;
- botón manual;
- Background Sync si existe;
- dispositivo peer con conectividad.

## P2P web-first

Web Bluetooth no se considera dependencia crítica para browser↔browser mesh. Primer spike:

- WebRTC `RTCDataChannel`;
- pairing manual/QR;
- intercambio inicial de IDs/digests;
- transferencia solo de envelopes faltantes.

Si se exige descubrimiento BLE automático, evaluar después un bridge nativo mínimo manteniendo este mismo protocolo.

## Límites V1

Los relays V1 transportan mensajes estructurados pequeños. Fotos/videos grandes permanecen en `media_outbox` hasta disponer de conectividad. No saturar Bluetooth/WebRTC ni batería con evidencia pesada.

## Threat model mínimo

Proteger contra:

- relay curioso;
- modificación de ciphertext;
- replay/reenvíos repetidos;
- loops de propagación;
- envelope expirado;
- payload gigante/DoS;
- clave de dispositivo desconocida o revocada;
- metadata que filtre identidad.

No asumir que una firma de dispositivo elimina fraude humano, teléfono robado o datos falsos.
