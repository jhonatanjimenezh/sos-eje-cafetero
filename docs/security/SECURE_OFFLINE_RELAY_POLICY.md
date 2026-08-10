# Política de seguridad — comunicación offline y store-and-forward

## Propósito

Proteger reportes de emergencia durante períodos sin Internet y permitir que ciphertext viaje mediante dispositivos de terceros sin entregarles información sensible ni autoridad sobre el reporte.

Esta política aplica a `SecureEnvelopeV1`, IndexedDB, sincronización server-side y relay WebRTC.

## Principio de confianza cero para relays

Todo dispositivo intermediario se trata como **no confiable**.

Un relay puede transportar bytes, pero no obtiene privilegios por hacerlo. En particular:

- no puede leer el payload;
- no puede cambiar el contenido o headers firmados sin detección;
- no puede aprobar/rechazar un reporte;
- no puede verificar identidad civil;
- no puede marcar a alguien como damnificado/voluntario confiable;
- no puede fabricar un ACK válido del centro de mando.

## Separación entre transporte e identidad

Tres conceptos no deben mezclarse:

1. **SecureEnvelope**: confidencialidad/integridad/procedencia de clave del mensaje.
2. **Identity verification (#2)**: elegibilidad e identidad de damnificados/beneficiarios.
3. **Operación humana**: verificación del contenido, priorización y despacho.

Una firma ECDSA válida solo prueba que el envelope fue firmado por la private key correspondiente a `emitterKeyId`. No demuestra quién sostiene el teléfono ni si la declaración es verdadera.

## Datos que nunca deben quedar plaintext en la cola offline

Entre otros:

- GPS exacto;
- dirección;
- teléfono;
- nombre;
- documento;
- descripción del incidente;
- información médica;
- información de menores;
- identidad de damnificados;
- secretos/tokens.

El Service Worker tampoco puede introducir estos datos en Cache Storage.

## Fail-closed limitado

La aplicación falla cerrada **solo para persistencia sensible offline**.

Si no puede crear/custodiar claves o no existe una crypto-config pública válida:

- no guarda PII plaintext;
- informa que el reporte offline no puede persistirse de forma segura.

Si existe Internet, el SOS online directo sigue disponible. Una falla del modo SecureEnvelope no debe bloquear innecesariamente un reporte normal al servidor.

## Claves del dispositivo

- ECDSA P-256;
- private `CryptoKey` no exportable cuando el browser lo soporta;
- key ID derivado del SHA-256 del SPKI público;
- la private key no se envía al servidor ni a peers;
- no registrar private keys en logs, analytics, errores o soporte.

### Pérdida/robo

Si un dispositivo institucional o vinculado a un flujo autenticado se pierde:

1. registrar el `emitterKeyId` afectado si puede identificarse;
2. marcarlo revocado server-side;
3. cerrar/revocar además sesiones, OTP o credenciales institucionales según el módulo correspondiente;
4. no asumir que revocar la firma del dispositivo sustituye el protocolo de baja de funcionario.

## Claves del servidor

### Separación obligatoria

No usar una única RSA para todas las funciones.

- encryption key: RSA-3072 `ENCRYPT_DECRYPT`;
- receipt key: RSA-3072 `SIGN_VERIFY`.

### AWS

Las privadas permanecen en KMS. ECS obtiene únicamente permisos operacionales mínimos sobre cada key.

### On-prem

Las privadas permanecen fuera de Git en storage/volumen restringido. Deben tener backup institucional cifrado y control de acceso.

Nunca copiar private keys a:

- repositorio;
- imagen Docker;
- `.env` versionado;
- issue/PR;
- logs;
- captura de pantalla pública.

## Rotación y continuidad

No retirar una clave de decrypt mientras puedan existir envelopes válidos cifrados para ella.

Una rotación debe incluir overlap por al menos:

```text
maxEnvelopeTtlSeconds + margen operacional
```

Antes de rotar en una emergencia real se debe probar recuperación y procesamiento de mensajes creados con la key anterior.

## Replay

Un mensaje se identifica por:

```text
messageId + ciphertextSha256
```

Reglas:

- mismo ID + mismo digest: idempotent replay;
- mismo ID + digest diferente: conflicto/tampering;
- ningún replay crea una segunda entidad de dominio;
- un receipt `ALREADY_PROCESSED` también debe estar firmado.

## Purga local

Un envelope propio o relayed se elimina por recepción **solo después de verificar** el receipt firmado del servidor y su binding exacto.

No aceptar como prueba de entrega:

- una pantalla de otro relay;
- un mensaje de chat;
- un booleano enviado por peer;
- un ACK sin firma;
- un receipt con otro digest.

## DoS y límites

SecureEnvelope no pretende resolver todo DoS de Internet, pero cada capa debe limitar abuso:

- body HTTP global;
- batch pequeño;
- ciphertext máximo;
- packet relay máximo;
- queue local máxima;
- TTL;
- inventario máximo;
- rate limit perimetral + límite suplementario en app;
- firma/digest antes de operaciones de dominio.

Fotos/videos pesados no viajan por relay V1.

## Pairing P2P y ingeniería social

El pairing manual no convierte al peer en confiable.

Reglas UX/operación:

- emparejar únicamente dispositivos físicamente presentes cuando sea posible;
- no publicar SDP/códigos de pairing en redes sociales o grupos abiertos;
- informar que el código puede contener información de red local;
- no mostrar PII del envelope durante pairing;
- permitir cerrar/desconectar el canal rápidamente;
- no usar el nombre del peer como garantía de identidad.

## Logs y observabilidad

Permitido:

- message ID;
- digest;
- suite/version;
- reason code;
- latencia;
- conteos agregados;
- key ID público;
- estado de procesamiento.

No permitido:

- plaintext descifrado;
- teléfono;
- GPS;
- dirección;
- documento;
- contenido médico;
- ciphertext completo en logs rutinarios;
- wrapped DEK;
- private keys/tokens.

La telemetría no debe bloquear ingestión de emergencia.

## Errores criptográficos

Errores terminales, por ejemplo:

- firma inválida;
- digest inválido;
- GCM authentication failure;
- esquema inválido;
- TTL vencido;
- key revocada.

Deben producir `REJECTED` firmado cuando sea seguro hacerlo.

Errores reintentables, por ejemplo:

- KMS temporalmente no disponible;
- API/DB temporalmente no disponible.

No deben convertir el mensaje en plaintext ni hacer que el cliente lo purgue.

## Feature flags

Defaults seguros:

```text
FEATURE_SECURE_ENVELOPE=false
FEATURE_WEBRTC_RELAY=false
NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=false
NEXT_PUBLIC_FEATURE_SECURE_ENVELOPE=false
NEXT_PUBLIC_FEATURE_WEBRTC_RELAY=false
```

Para persistencia offline sensible se requiere simultáneamente:

```text
NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=true
NEXT_PUBLIC_FEATURE_SECURE_ENVELOPE=true
```

Un mismatch aplica fail-closed para almacenamiento local.

## Condiciones para habilitar SecureEnvelope en piloto

- gate criptográfico CI verde;
- migrations aplicadas;
- provider de keys probado;
- recuperación de key documentada;
- navegador objetivo conserva private CryptoKey de forma aceptable;
- cierre/reapertura offline probado;
- vuelta de Internet produce exactamente una entidad;
- receipt firmado probado;
- no plaintext en IndexedDB/Cache Storage;
- runbook de dispositivo perdido/revocación aprobado.

## Condiciones adicionales para habilitar relay P2P

- SecureEnvelope ya habilitado;
- A→B→C probado físicamente;
- B y C no pueden observar plaintext;
- loops/duplicados controlados;
- pruebas con hotspot/red local objetivo;
- storage/batería medidos;
- personal operador entiende que relay != identidad/confianza.

## Prohibiciones

- no implementar “cifrado” propio;
- no desactivar verificación GCM o firma para mejorar compatibilidad;
- no usar plaintext fallback;
- no aceptar ACK no firmado;
- no auto-confiar en un peer por tener una firma válida;
- no publicar materiales criptográficos privados como evidencia de prueba;
- no declarar compatibilidad de dispositivos que no haya sido probada físicamente.
