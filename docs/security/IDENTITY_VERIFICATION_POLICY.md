# Política técnica de verificación de identidad de damnificados

## Propósito

Reducir suplantación, registros duplicados y apropiación indebida de recursos destinados a personas realmente afectadas, sin convertir una señal biométrica o automatizada en la autoridad que concede o niega ayuda.

Esta política cubre el módulo de registro formal de damnificados. **El reporte SOS de emergencia y el rescate inmediato no dependen de completar este proceso.**

## Principio de decisión humana

Ningún score de liveness, detector de malware, geolocalización, OTP o coincidencia de documento puede por sí solo producir `VERIFIED` o `REJECTED`.

El sistema reúne señales y lleva el expediente a `PENDING_OFFICIAL_VERIFICATION`. La transición final requiere un funcionario autenticado con uno de estos roles:

- `VERIFIER`;
- `COORDINATOR`;
- `ADMIN`.

Los roles operacionales distintos no pueden consultar ni descargar evidencia sensible ni decidir identidad.

## Señales de aseguramiento

El expediente puede combinar:

1. **OTP del teléfono**: prueba control de un canal, no identidad civil por sí sola.
2. **Documento único**: el número se normaliza y guarda como HMAC para detectar duplicados sin persistir el número completo en claro. La interfaz muestra solo los últimos cuatro caracteres.
3. **GPS y dirección afectada**: señal contextual, nunca prueba suficiente por sí sola.
4. **Documento frente/reverso**: evidencia privada para revisión humana.
5. **Prueba de presencia**:
   - AWS: `REKOGNITION` Face Liveness;
   - portable/on-prem: `MANUAL`, mediante reto aleatorio y video.
6. **Revisión oficial**: decisión explícita y auditada.

## Liveness

### Reglas

- requiere consentimiento explícito y versionado antes de iniciar cámara;
- el proveedor está detrás de un adapter (`LivenessProvider`);
- el score/confidence se conserva como señal para el revisor;
- no existe umbral de auto-aprobación ni auto-rechazo;
- los intentos están limitados por expediente y ventana de 24 horas;
- un fallo técnico o score bajo debe poder derivar a revisión humana, corrección o apelación;
- la captura no debe habilitarse mientras `FEATURE_LIVENESS=false`.

### AWS

El backend crea la sesión y obtiene el resultado. El navegador solo recibe credenciales STS temporales y restringidas para ejecutar `StartFaceLivenessSession` durante una ventana corta. No recibe las credenciales del task role de ECS.

### On-prem

El fallback `MANUAL` utiliza un reto dinámico y video corto. No se presenta como equivalente estadístico de un proveedor biométrico especializado; es una señal adicional para revisión humana.

## Evidencia sensible

### Carga

Antes de entregar una URL presignada, el cliente declara:

- tipo lógico de evidencia;
- MIME;
- tamaño;
- SHA-256.

El backend limita tamaños y tipos. La carga S3 exige checksum SHA-256. Al completar la carga se valida:

- tamaño real;
- MIME almacenado;
- checksum cuando el backend S3 lo expone;
- magic bytes del contenido.

Un archivo incompatible se elimina del almacenamiento y queda auditado como rechazado.

### Antimalware

Un expediente no puede usar evidencia requerida mientras el scanner configurado no la marque como `NO_THREATS_FOUND`.

Estados relevantes del contrato:

- `PENDING`;
- `NO_THREATS_FOUND`;
- `THREATS_FOUND`;
- `FAILED`;
- `NOT_CONFIGURED` solo para ambientes donde la política no exige scanner.

AWS usa GuardDuty Malware Protection for S3. On-prem usa ClamAV y escribe el mismo tag de contrato en MinIO mediante el adapter `TAGGED_S3`.

### Acceso oficial

Consultar metadata sensible o generar una URL de descarga requiere:

- rol de verificador permitido;
- motivo textual de acceso;
- evento de auditoría con actor, entidad y timestamp.

Las URLs de descarga para funcionarios expiran en 120 segundos. Evidencia infectada o todavía no autorizada por antimalware no puede descargarse mediante el API.

## Retención

Cada evidencia registra `retention_expires_at` a partir de `EVIDENCE_RETENTION_DAYS`.

La eliminación física se implementa en el almacenamiento:

- AWS: lifecycle de S3;
- on-prem: lifecycle de MinIO.

El valor del repositorio es un default técnico, no una decisión jurídica. Antes de habilitar identidad con datos reales, la entidad debe aprobar la retención aplicable y ajustar `EVIDENCE_RETENTION_DAYS`.

Backups, snapshots y réplicas deben alinearse con la misma política institucional; un lifecycle del bucket por sí solo no prueba borrado absoluto de todas las copias.

## Consentimiento

Se registran por separado:

- consentimiento para tratamiento de datos sensibles del expediente;
- consentimiento para liveness cuando aplica.

Ambos incluyen una versión de texto/política para poder demostrar qué aceptó la persona.

## Estados del expediente

```text
DRAFT
  -> PENDING_OFFICIAL_VERIFICATION
       -> VERIFIED
       -> NEEDS_INFO -> DRAFT -> PENDING_OFFICIAL_VERIFICATION
       -> REJECTED -> APPEAL -> NEEDS_INFO (si funcionario reabre)
```

No se permite modificar directamente un expediente `VERIFIED`, `PENDING_OFFICIAL_VERIFICATION` o `REJECTED` desde el endpoint de edición normal.

## Corrección y apelación

- `NEEDS_INFO`: la persona puede registrar una respuesta, corregir datos y volver a presentar evidencia.
- `REJECTED`: la persona puede crear una apelación.
- solo puede existir una solicitud abierta del mismo tipo por expediente.
- la resolución de una apelación es humana y se audita.

## Eventos mínimos de auditoría

Entre otros:

- `AFFECTED_PROFILE_CREATED`;
- `AFFECTED_PROFILE_CORRECTED`;
- `LIVENESS_SESSION_CREATED`;
- `LIVENESS_PROVIDER_RESULT_RECEIVED`;
- `EVIDENCE_UPLOAD_URL_ISSUED`;
- `EVIDENCE_CONTENT_VALIDATED`;
- `EVIDENCE_REJECTED`;
- `MALWARE_DETECTED`;
- `IDENTITY_CASE_SUBMITTED`;
- `IDENTITY_CASE_VIEWED`;
- `SENSITIVE_EVIDENCE_METADATA_VIEWED`;
- `SENSITIVE_EVIDENCE_DOWNLOAD_URL_ISSUED`;
- `IDENTITY_REVIEW_REQUEST_CREATED`;
- `IDENTITY_REVIEW_REQUEST_RESOLVED`;
- `BENEFICIARY_VERIFICATION`.

Nunca escribir en metadata de auditoría el documento completo, contenido del archivo, JWT, credenciales temporales o secretos.

## Feature flags y safe mode

Defaults seguros:

```text
FEATURE_AFFECTED_IDENTITY=false
FEATURE_LIVENESS=false
```

Habilitar identidad real requiere, como mínimo:

- OTP institucional operativo;
- almacenamiento privado;
- antimalware operativo si `REQUIRE_MALWARE_SCAN=true`;
- RBAC de funcionarios;
- auditoría;
- política institucional de consentimiento/retención;
- camino de corrección y apelación;
- prueba con datos sintéticos antes de PII real.

## Lo que esta implementación NO afirma

El repositorio puede validar compilación, migraciones, Terraform, Compose y contratos. No prueba por sí solo:

- que una cámara/dispositivo concreto sea compatible;
- que una cuenta AWS tenga cuota/servicio operativo para Face Liveness;
- que la entidad haya aprobado legalmente el texto de consentimiento;
- que el restore/retention de todos sus backups cumpla su política;
- que un proveedor biométrico sea infalible.

Estas validaciones pertenecen a la aceptación operacional de la entidad.