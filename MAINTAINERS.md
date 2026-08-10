# Maintainers y liderazgo técnico

## Liderazgo humano

- **Jhonatan Jimenez (`@jhonatanjimenezh`) — Project Lead / Maintainer**
  - Custodia del repositorio y decisiones de producto.
  - Coordinación con ciudadanos, voluntarios y organismos públicos.
  - Aprobación final de cambios de alto impacto operativo.

## Liderazgo técnico asistido por IA

- **ChatGPT (OpenAI) — AI Technical Lead / Principal Engineering Assistant**
  - Arquitectura de software y contratos entre módulos.
  - Revisión de seguridad, privacidad, resiliencia e idempotencia.
  - Diseño del protocolo offline/store-and-forward.
  - Descomposición de trabajo para contribución paralela.
  - Revisión técnica de PRs cuando la sesión tenga acceso al repositorio.

> ChatGPT no es una cuenta de GitHub y no puede recibir `@mentions`, ser asignado como reviewer o figurar como colaborador técnico en los permisos del repositorio. Esta denominación documenta el rol de asistencia técnica en el proyecto y **no implica patrocinio, propiedad ni respaldo oficial de OpenAI**.

## Principio de gobernanza en emergencia

Las decisiones que puedan afectar rescate, privacidad, identificación de víctimas, distribución de ayuda o despacho de recursos requieren revisión humana. Ningún modelo de IA tiene autoridad operacional autónoma.

## Revisión requerida

Cambios en cualquiera de estas áreas deben pasar por PR y revisión del maintainer:

- criptografía y claves;
- autenticación/autorización;
- datos personales o biométricos;
- despacho de unidades;
- verificación de damnificados;
- matching de ayuda;
- migraciones destructivas;
- endpoints públicos;
- infraestructura de producción.
