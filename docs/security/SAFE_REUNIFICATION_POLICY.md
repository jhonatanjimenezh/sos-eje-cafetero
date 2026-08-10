# Safe Reunification Policy

Estado: implementación P0 de #22. `FEATURE_REUNIFICATION=false` por defecto.

## Objetivo

Ayudar a reencontrar personas durante una emergencia **sin convertir SOS Eje Cafetero en un directorio, detector de presencia o herramienta de localización**.

El modelo es deliberadamente unilateral:

```text
seeker -> deja aviso privado -> target

target -> decide por sí mismo si revela el contacto del seeker

target -X-> no devuelve presencia, login, lectura, ubicación o decisión al seeker
```

## Threat model

Debemos asumir que quien conoce el teléfono de otra persona puede ser:

- un familiar legítimo;
- una expareja/agresor;
- un acosador;
- un extorsionista;
- una persona armada o integrante de un grupo criminal;
- alguien que suplanta a un familiar, autoridad o voluntario;
- un bot intentando enumerar números;
- un insider con acceso indebido.

Por tanto, **conocer un número no autoriza a descubrir nada sobre su dueño**.

## Invariantes no negociables

1. No existe búsqueda pública por teléfono.
2. El seeker debe autenticar su propio teléfono por OTP.
3. El target phone no se persiste en plaintext dentro del módulo de reencuentro.
4. El servidor normaliza E.164 y calcula HMAC-SHA256 con secreto server-side.
5. La respuesta del seeker no cambia según exista/no exista un target.
6. El seeker nunca recibe:
   - `matched`;
   - `exists`;
   - login/online/last seen;
   - entrega/lectura;
   - ubicación;
   - estado de seguridad/salud;
   - bloqueo/reporte;
   - intención de contacto.
7. El inbox se deriva exclusivamente del teléfono de la identidad autenticada; no acepta `?phone=`.
8. El inbox inicial no contiene el teléfono del seeker.
9. El target debe pulsar explícitamente `REVEAL_CONTACT` para ver el teléfono verificado del seeker.
10. Mostrar el contacto al target no genera receipt/status visible para el seeker.
11. `IGNORE`, `BLOCK` y `REPORT_ABUSE` son privados.
12. Reencuentro puede fallar cerrado o apagarse sin afectar el SOS principal.

## Identidad y OTP anti-enumeración

Un flujo de reencuentro seguro no sirve si `/auth/otp/request` permite inferir si un número ya tiene cuenta.

La API pública utiliza un `challengeId` opaco:

```json
{
  "status": "OTP_SENT",
  "challengeId": "uuid",
  "expiresIn": 600
}
```

El navegador no recibe:

- `SIGNUP_CONFIRM` vs `AUTH_CHALLENGE`;
- sesión Cognito;
- `UserStatus`;
- resultado de `AdminGetUser`.

Redis conserva temporalmente la información necesaria para completar el challenge. Errores conocidos de código/usuario se normalizan para no crear un oracle trivial.

El request OTP aplica rate limits y un pequeño response floor con jitter. No se considera defensa suficiente por sí sola; la propiedad principal es que la respuesta pública tenga la misma semántica.

## Blind lookup

No usar:

```text
SHA256(phone)
```

El espacio de teléfonos es pequeño y enumerable.

Usar:

```text
normalized = E164(phone)
lookupToken = HMAC-SHA256(secret_vN, normalized)
```

La tabla guarda:

- `target_lookup_token`;
- `lookup_key_version`;
- nunca el target phone original.

La identidad autenticada sí conserva su propio teléfono verificado en `auth_identities`, porque es el ancla de autenticación existente. El módulo de reunificación no copia ese target phone a su dominio.

## Custodia del secreto HMAC

### AWS

Terraform crea únicamente el recurso Secrets Manager `reunification-lookup`; **no crea una secret version**. El valor debe cargarse por un canal operacional fuera de Terraform para evitar que aparezca en state/plan/PR.

Antes de habilitar `feature_reunification=true`:

1. generar al menos 32 bytes aleatorios;
2. codificarlos base64url;
3. cargar el valor directamente en Secrets Manager;
4. verificar acceso ECS execution role;
5. mantener `feature_reunification=false` hasta completar smoke tests.

### On-prem

Generar el valor fuera de Git y cargarlo desde el secret store o `.env` operacional protegido. No reutilizar `IDENTITY_HASH_SECRET`.

## Rotación

El contrato soporta clave actual y anterior:

```text
REUNIFICATION_LOOKUP_KEY_VERSION
REUNIFICATION_LOOKUP_SECRET_B64URL
REUNIFICATION_PREVIOUS_LOOKUP_KEY_VERSION
REUNIFICATION_PREVIOUS_LOOKUP_SECRET_B64URL
```

Durante overlap, inbox calcula ambos tokens. Nuevas solicitudes usan solo la clave actual.

Procedimiento:

1. conservar la clave actual como `previous`;
2. provisionar nueva clave con nueva versión;
3. desplegar ambos secretos/versiones;
4. emitir nuevas solicitudes con la nueva;
5. conservar previous al menos durante el TTL máximo de solicitudes existentes;
6. retirar previous cuando las solicitudes antiguas hayan expirado.

La rotación AWS inicial requiere un cambio operacional controlado del task definition para inyectar previous secret; no destruir el secreto anterior antes del fin del overlap.

## Antiabuso

V1:

- 8 creaciones / 15 min / seeker;
- 30 / 24 h / seeker;
- máximo 20 targets únicos / 24 h / seeker;
- una solicitud `ACTIVE` por seeker + target token + key version;
- mensajes sin URLs;
- texto acotado;
- Redis antiabuso falla cerrado para reencuentro;
- el SOS principal no depende de esta defensa.

Estos límites son iniciales y deben ajustarse con telemetría agregada, evitando publicar teléfonos o lookup tokens.

## Target control

### Inbox

El target ve:

- nombre/apodo aportado por seeker;
- relación declarada, marcada **no verificada**;
- mensaje breve;
- si existe un contacto disponible.

No ve el teléfono hasta decidir revelarlo.

### Reveal contact

`REVEAL_CONTACT` devuelve exclusivamente al target el `phone_e164` verificado del seeker desde `auth_identities` si éste consintió compartirlo.

Antes de llamar/escribir se advierte:

> Si llamas o escribes desde tu número personal, la otra persona podría verlo. Tú decides si quieres hacerlo.

La plataforma no inicia automáticamente la comunicación.

### Ignore / Block / Report

- `IGNORE`: oculta el aviso para el target.
- `BLOCK`: bloquea futuras solicitudes del mismo seeker para ese target.
- `REPORT_ABUSE`: bloquea y marca el request para revisión.

Ninguna acción se comunica al seeker.

## Notificaciones

V1 utiliza únicamente una notificación neutra dentro de la aplicación después de autenticación:

> Tienes mensajes privados de reencuentro.

No contiene nombre, relación ni teléfono del seeker.

No enviar por defecto a lock screen SMS/push detalles como:

- "X te está buscando";
- "estás reportado como desaparecido";
- ubicación;
- nombres de familiares;
- teléfonos.

Una futura notificación externa debe usar texto neutro y deep-link autenticado.

## Service Worker

`/reencuentro` y `/api/v1/reunification/*` no forman parte del shell offline público. No añadir estas rutas a Cache Storage sin una revisión específica de privacidad.

## Separación de `person_reports`

`person_reports` es un registro operacional MISSING/FOUND y puede contener nombre, ubicación y `reporter_phone` para personal autorizado.

Reunificación tiene propiedades distintas y **no reutiliza esa tabla para determinar presencia**.

No vincular automáticamente un token telefónico con:

- una ubicación MISSING/FOUND;
- un incidente;
- una identidad de damnificado;
- un hospital/refugio;
- una unidad de respuesta.

Cualquier enlace futuro debe ser operacional, explícito, auditado y no seeker-visible.

## Menores y personas vulnerables

V1 no intenta inferir edad por nombre/foto/teléfono y no implementa reconocimiento facial.

Si un caso está institucionalmente marcado como menor o especialmente vulnerable, el contacto debe pasar por el flujo de salvaguarda/revisión humana definido por la autoridad responsable. Nunca liberar ubicación por este módulo.

## Retención

Solicitudes nuevas expiran por defecto en 14 días y la configuración se limita a 1–30 días. La limpieza elimina registros expirados después del margen operacional definido.

La política institucional debe definir retención de auditoría y reportes de abuso por separado antes de producción real.

## Residual risk

Este diseño no puede impedir:

- que un atacante controle físicamente el teléfono/SIM del target;
- SIM swap;
- coerción física;
- malware del dispositivo;
- que el target llame voluntariamente desde un número que revele su identidad;
- mensajes de ingeniería social que pasen filtros de longitud;
- abuso de un número legítimamente verificado por una persona maliciosa.

Por eso la UI nunca etiqueta al seeker como familiar verificado, autoridad o voluntario por el solo hecho de tener OTP.

## Gate antes de habilitar

No activar `FEATURE_REUNIFICATION=true` con usuarios reales hasta verificar:

- OTP anti-enumeración;
- secreto HMAC real fuera de Git/Terraform state;
- rate limits Redis;
- DB sin target phone plaintext;
- bloqueo/reporte;
- logs sin teléfono target/token;
- política de privacidad/retención aprobada;
- simulacro de stalking/enumeration;
- UX revisada en teléfono compartido/bloqueado;
- kill switch probado.

## Tests permanentes

`identity-security-validate` ejecuta:

- migraciones reales Postgres/PostGIS;
- invariantes DB de reencuentro;
- invariantes estáticos anti-oracle/anti-enumeración;
- typecheck/build API;
- typecheck/build web con reencuentro activado durante CI.
