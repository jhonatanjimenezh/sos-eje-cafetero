# ADR-001 — Modular monolith para la respuesta inicial

- Estado: Accepted
- Fecha: 2026-08-10

## Contexto

El proyecto debe entrar en operación rápidamente, con pocos mantenedores iniciales y alta necesidad de coherencia transaccional entre incidentes, unidades, personas, verificación y ayuda.

## Decisión

Mantener un backend NestJS como **modular monolith** con límites de dominio explícitos y PostgreSQL/PostGIS como fuente de verdad común.

## Razones

- menos puntos de falla durante emergencia;
- despliegue y observabilidad simples;
- transacciones locales para invariantes críticas;
- menor coste cognitivo para nuevos colaboradores;
- posibilidad futura de extraer módulos únicamente cuando exista evidencia de necesidad.

## Consecuencias

- los módulos no deben saltarse sus servicios para escribir tablas de otros dominios arbitrariamente;
- contratos compartidos se versionarán en paquete común;
- trabajos pesados/asíncronos pueden desacoplarse con SQS sin convertir cada dominio en microservicio;
- una extracción futura requiere ADR independiente.
