# Mascotas Seguras — política de privacidad y anti-extorsión

## Propósito

Ayudar a reunir mascotas perdidas con sus familias durante una emergencia sin convertir el catálogo en una fuente de teléfonos, domicilios, ubicaciones exactas o pruebas de propiedad reutilizables por terceros.

## Regla pública

La proyección pública V1 contiene únicamente:

- fotografía de catálogo sanitizada y aprobada;
- nombre de la mascota, o `Sin identificar` para FOUND;
- LOST / FOUND;
- estado operativo mínimo.

No publica teléfono, identidad de propietario/finder, coordenadas, dirección, barrio, microchip, documento, rasgos privados ni evidencia.

## Identidad

Toda persona que registra una mascota, afirma haberla encontrado o reclama un FOUND debe autenticar su propio teléfono mediante el flujo ciudadano OTP. Un teléfono escrito en texto libre no prueba identidad.

## Propiedad

Más PII no equivale a más seguridad. El sistema no exige domicilio para demostrar propiedad. Utiliza señales que sí ayudan:

- control OTP del teléfono propio;
- evidencia histórica anterior al incidente;
- microchip si existe;
- rasgos privados no publicados;
- decisión humana.

Documento y microchip se representan con HMAC keyed + últimos cuatro caracteres cuando son necesarios para comparación. Los detalles privados de perfil se cifran con AES-256-GCM usando una clave independiente fuera de Git.

## LOST: alguien afirma haber encontrado la mascota

1. Finder OTP-verificado crea claim.
2. Backend emite challenge aleatorio de 10 minutos.
3. Finder graba video continuo mostrando animal + código sin forzar ni estresar al animal.
4. Video se carga a almacenamiento privado con checksum, MIME/magic-byte validation, malware scan y retención.
5. Propietario autenticado recibe aviso neutro y puede abrir el video mediante URL temporal auditada.
6. Propietario decide si autoriza compartir su teléfono, consulta el teléfono del finder si éste consintió, rechaza, bloquea o reporta abuso.

Un video es evidencia fuerte, no prueba matemática irrefutable. No existe decisión automática de identidad/propiedad.

## FOUND: animal encontrado sin reporte previo

FOUND puede existir sin LOST previo. El catálogo muestra `Sin identificar`.

Un supuesto propietario:

1. OTP-verifica su teléfono;
2. selecciona un perfil privado propio;
3. aporta evidencia histórica privada;
4. la persona que encontró el animal la revisa;
5. acepta/rechaza/bloquea/reporta;
6. los teléfonos solo se revelan según el consentimiento de cada parte y después de aceptación.

## Anti-oracles

`REJECT`, `BLOCK` y `REPORT_ABUSE` se almacenan como acciones privadas y no cambian el lifecycle público del claim. No se exponen motivos, read receipts, last seen ni actividad de la contraparte.

Las decisiones de consentimiento, rechazo, bloqueo y abuso se escriben en la misma transacción PostgreSQL que su evento de auditoría. Si la auditoría crítica falla, la decisión no queda parcialmente persistida.

## Anti-extorsión

- no teléfonos públicos;
- no ubicación exacta pública;
- no pagos/recompensas dentro de V1;
- texto público no acepta teléfonos, emails, URLs ni handles;
- prueba de vida privada antes de contacto sobre LOST;
- evidencia histórica privada antes de aceptar un supuesto propietario sobre FOUND;
- rate limits por identidad/caso;
- report abuse y block privados;
- recomendación de entrega en autoridad, veterinaria, refugio o punto seguro, no domicilio;
- endpoint legacy `/reports/animals` se cierra cuando `FEATURE_PET_SAFETY=true`.

## Fotografías públicas

El bucket permanece privado. La API entrega URLs firmadas de corta duración.

Antes de que una fotografía pueda aparecer en el catálogo debe superar **dos barreras independientes**:

1. validación técnica;
2. moderación humana oficial.

La validación técnica comprueba checksum, tipo real, cifrado KMS en producción y malware. JPEG/PNG eliminan EXIF/XMP/IPTC/text metadata; WebP con EXIF/XMP se rechaza en V1. Esto evita publicar coordenadas GPS embebidas accidentalmente.

La eliminación de metadatos no detecta datos dibujados dentro de los píxeles. Por eso `pet_case_media.moderation_status` comienza en `PENDING` y el catálogo solo sirve imágenes `APPROVED` por una identidad oficial autenticada. El moderador debe rechazar afiches/capturas o fotografías donde se vea teléfono, dirección, QR, documento, placa, domicilio u otro dato personal innecesario.

La revisión usa una URL privada de 120 segundos y queda auditada. Un rechazo cambia primero el estado en base de datos —por lo que deja de ser servible— y luego intenta eliminar el objeto; si la eliminación falla, el objeto continúa privado.

## Evidencia privada

- S3 privado;
- TLS en tránsito;
- SSE-KMS obligatorio en producción;
- URLs de revisión de 120 segundos;
- object keys opacos sin PII;
- checksum SHA-256;
- MIME + magic bytes;
- malware scan fail-closed cuando la política lo exige;
- acceso auditado;
- retención limitada.

La evidencia privada **no** entra en la cola de moderación del catálogo: solo la contraparte autenticada que participa en el claim puede abrirla mediante enlace temporal.

## Secretos

`PET_PROFILE_ENCRYPTION_SECRET_B64URL` y `PET_IDENTITY_HASH_SECRET_B64URL` son secretos independientes de 32 bytes. Nunca deben guardarse en Git, Terraform variables/state, issues, logs o capturas.

Terraform solo crea contenedores Secrets Manager. Su valor se carga por un procedimiento operacional fuera de Terraform.

## Cache y dispositivos compartidos

`/mascotas` y `/command-center/pet-photos` no pertenecen al shell offline persistente del Service Worker. La notificación global es neutra y nunca contiene nombre de mascota, persona, teléfono o ubicación.

## IA

Una futura IA puede sugerir similitud visual entre LOST/FOUND. Nunca puede decidir por sí sola que una persona es propietaria, liberar un teléfono, revelar ubicación ni ordenar una entrega. Tampoco sustituye la moderación humana previa a publicación en V1.

## Activación

Merge de código no autoriza uso real. `FEATURE_PET_SAFETY=false` y `NEXT_PUBLIC_FEATURE_PET_SAFETY=false` siguen siendo los defaults. Issue #26 contiene el gate GO/NO-GO físico, OTP, KMS, malware, extorsión, teléfono compartido, moderación y entrega segura.
