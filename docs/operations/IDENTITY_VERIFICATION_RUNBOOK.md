# Runbook — Validación operacional de identidad de damnificados

Este runbook valida el módulo de identidad antes de habilitar datos reales. Todas las pruebas iniciales deben usar expedientes, documentos, teléfonos y rostros de prueba autorizados.

## 1. Precondiciones

Confirmar:

- `FEATURE_AFFECTED_IDENTITY=true` solo en sandbox/piloto controlado;
- almacenamiento de evidencia privado;
- secretos fuera de Git;
- OTP operativo para el entorno elegido;
- scanner antimalware operativo si `REQUIRE_MALWARE_SCAN=true`;
- al menos un funcionario `VERIFIER` o superior;
- política de consentimiento y retención aprobada por la entidad;
- `FEATURE_LIVENESS` permanece `false` hasta completar la sección de dispositivo/proveedor.

## 2. Flujo base sin liveness

Con `FEATURE_LIVENESS=false`:

1. autenticar un ciudadano de prueba por OTP;
2. crear expediente con documento ficticio autorizado;
3. confirmar que un segundo expediente con el mismo documento normalizado es rechazado como duplicado;
4. subir frente y reverso de documento sintético;
5. confirmar que el expediente no se puede enviar mientras falte una evidencia requerida;
6. confirmar que la evidencia completa llega a `NO_THREATS_FOUND` cuando el scanner está requerido;
7. enviar el expediente;
8. confirmar estado `PENDING_OFFICIAL_VERIFICATION`;
9. confirmar que todavía no aparece como elegible en propuestas de matching de ayudas;
10. aprobarlo desde una cuenta `VERIFIER`/`COORDINATOR`/`ADMIN`;
11. confirmar `VERIFIED`;
12. generar nuevamente propuestas de ayuda y confirmar que ahora sí puede ser elegible.

## 3. Prueba de archivo malicioso sintético

Utilizar el archivo de prueba estándar aprobado por el equipo de seguridad de la entidad, por ejemplo EICAR, **nunca malware real**.

Esperado:

- AWS/GuardDuty o on-prem/ClamAV marca `THREATS_FOUND`;
- el expediente no puede utilizar esa evidencia para envío;
- el API no entrega URL de descarga a funcionarios para ese asset;
- existe evento de auditoría `MALWARE_DETECTED` una vez que el estado es consultado/refrescado;
- reemplazar la evidencia por un archivo limpio antes de continuar.

No publicar el archivo de prueba en issues, logs o commits.

## 4. Control de acceso a evidencia

Probar con al menos dos roles:

### Rol no autorizado, por ejemplo `DISPATCHER`

Debe fallar con 403 al intentar:

- listar metadata sensible del expediente;
- solicitar URL de descarga de evidencia;
- ejecutar decisión de identidad.

### Rol `VERIFIER` o superior

Debe poder realizar las acciones permitidas, pero tiene que enviar un motivo de acceso no vacío.

Después de cada acceso, comprobar `audit_events` y verificar:

- actor;
- rol/official id asociado;
- acción;
- entity id;
- timestamp;
- motivo cuando aplica.

Nunca deben aparecer documento completo, tokens, credenciales STS o contenido del archivo en metadata de auditoría.

## 5. NEEDS_INFO

1. funcionario selecciona `NEEDS_INFO` e incluye explicación;
2. ciudadano ve el estado y registra respuesta;
3. expediente vuelve a `DRAFT` para corrección controlada;
4. ciudadano corrige campos y/o reemplaza evidencias;
5. vuelve a enviar;
6. el caso regresa a `PENDING_OFFICIAL_VERIFICATION`;
7. confirmar que el historial anterior sigue auditable.

## 6. REJECTED y apelación

1. funcionario rechaza con explicación;
2. el ciudadano no puede editar directamente el expediente rechazado;
3. el ciudadano crea `APPEAL`;
4. una segunda apelación abierta del mismo tipo debe ser rechazada;
5. funcionario resuelve la apelación;
6. si la reabre, el expediente pasa a `NEEDS_INFO` para corrección y nueva revisión humana.

## 7. AWS Face Liveness

Solo después de validar el flujo base:

```text
feature_affected_identity = true
feature_liveness          = true
liveness_provider         = "REKOGNITION"
```

### Matriz mínima de dispositivos

Probar como mínimo la matriz que realmente usará la entidad. Registrar navegador/versión, sistema operativo, modelo aproximado, cámara frontal, red y resultado.

Casos mínimos:

- dispositivo Android objetivo;
- iPhone/iOS objetivo si forma parte de la población atendida;
- desktop/laptop solo si la entidad piensa permitirlo;
- Wi-Fi estable;
- red móvil degradada razonable.

### Casos funcionales

- consentimiento no marcado: no se crea sesión;
- cámara denegada: mensaje recuperable;
- flujo correcto: provider status `SUCCEEDED` y expediente sigue sin auto-verificarse;
- abandonar captura y reintentar;
- superar `LIVENESS_MAX_ATTEMPTS_PER_24H`: 429 y derivación a revisión humana;
- sesión expirada: debe exigir nueva sesión;
- comprobar que las credenciales del navegador son STS temporales y no las del task role;
- confirmar que ningún confidence score cambia por sí solo `verification_status`.

No documentar rostros reales, videos, SessionId, credenciales temporales o URLs privadas en GitHub.

## 8. On-prem liveness manual

```text
FEATURE_LIVENESS=true
LIVENESS_PROVIDER=MANUAL
NEXT_PUBLIC_FEATURE_LIVENESS=true
NEXT_PUBLIC_LIVENESS_PROVIDER=MANUAL
```

Probar:

- reto generado con código/dirección variable;
- permisos de cámara/micrófono;
- video corto válido;
- MIME/magic bytes/checksum;
- ClamAV limpio;
- revisión del video únicamente por rol autorizado;
- el video no produce auto-aprobación.

Este modo es una señal manual adicional; no debe describirse como equivalente estadístico a Face Liveness.

## 9. Retención

### AWS

Confirmar en S3:

- lifecycle activo sobre `private/`;
- `EVIDENCE_RETENTION_DAYS` coincide con la política aprobada;
- versioning y noncurrent retention revisados;
- backups/snapshots externos tratados por política institucional separada.

### On-prem

Confirmar:

- lifecycle importado en MinIO;
- versioning activo;
- backups fuera del servidor evaluados bajo la misma política.

Para probar eliminación sin esperar el período productivo, usar un bucket/entorno de prueba con lifecycle temporal aprobado por la entidad. No reducir el período productivo solo para facilitar el test.

## 10. Antimalware on-prem

```bash
cd infrastructure/onprem
docker compose ps clamav evidence-scanner minio

docker compose logs --tail=100 clamav
docker compose logs --tail=100 evidence-scanner
```

Esperado:

- ClamAV activo y firmas cargadas;
- scanner conectado a MinIO y `clamd`;
- scanner usa `S3_SCANNER_ACCESS_KEY`, nunca `MINIO_ROOT_USER`;
- API usa `S3_API_ACCESS_KEY`, nunca credenciales root;
- ninguno de los servicios internos publica 3310/9000 hacia Internet mediante este Compose.

## 11. Criterio GO / NO-GO

### GO

Se puede habilitar identidad en piloto si:

- flujo base completo;
- roles y auditoría comprobados;
- antimalware comprobado;
- retención aprobada/configurada;
- corrección y apelación probadas;
- si liveness está ON, matriz de dispositivos/proveedor aprobada;
- matching/entrega solo usa `VERIFIED` y la aprobación revalida ese estado.

### NO-GO

Desactivar `FEATURE_AFFECTED_IDENTITY` y/o `FEATURE_LIVENESS` si:

- evidencia es pública;
- scanner requerido no funciona;
- un rol no autorizado puede descargar evidencia;
- falta auditoría de acceso;
- se detecta auto-aprobación/rechazo por score biométrico;
- matching puede asignar recursos a expedientes no `VERIFIED`;
- consentimiento/retención institucional no están aprobados;
- no existe camino de corrección/apelación.

## 12. Evidencia operacional permitida

Registrar solo datos no sensibles:

```text
Fecha UTC:
Commit:
Modo: AWS_REKOGNITION | ON_PREM_MANUAL | IDENTITY_WITHOUT_LIVENESS
Migraciones: OK/FAIL
OTP: OK/FAIL
Duplicate document control: OK/FAIL
Evidence validation: OK/FAIL
Malware clean test: OK/FAIL
Synthetic malware test: OK/FAIL
RBAC evidence access: OK/FAIL
Human decision only: OK/FAIL
Verified-only assistance: OK/FAIL
NEEDS_INFO: OK/FAIL
Appeal: OK/FAIL
Retention config: OK/FAIL
Device matrix: OK/FAIL/NOT_APPLICABLE
Observaciones no sensibles:
```

Nunca publicar PII, documentos, caras, videos, números de teléfono, URLs presignadas, tokens, credenciales, object keys privados o Terraform state.