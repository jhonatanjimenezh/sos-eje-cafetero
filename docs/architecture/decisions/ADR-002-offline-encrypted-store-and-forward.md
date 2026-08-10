# ADR-002 — Offline-first con store-and-forward cifrado

- Estado: Accepted para diseño; suite criptográfica final pendiente de spike
- Fecha: 2026-08-10

## Contexto

Puede existir conectividad móvil intermitente o nula. Un reporte capturado debe sobrevivir localmente y poder llegar al servidor posteriormente, incluso mediante otros dispositivos.

## Decisión

La PWA será offline-first usando IndexedDB y Service Worker. Cada reporte offline se representa mediante un `SecureEnvelope` cifrado y firmado. Los relays transportan ciphertext sin acceso al plaintext. El servidor es el destinatario criptográfico y la ingestión es idempotente.

## Decisiones asociadas

- hash no sustituye cifrado;
- cifrado autenticado para payload;
- firma del origen para integridad/procedencia;
- ACK/receipt firmado por servidor;
- `messageId` estable para retries y múltiples rutas;
- WebRTC es el primer spike peer-to-peer puramente web;
- Web Bluetooth no es una dependencia crítica para mesh browser↔browser;
- evidencia multimedia pesada no viaja por relay V1.

## Consecuencias

- nuevas rutas de sync deben aceptar duplicados de transporte sin duplicar dominio;
- metadata externa al ciphertext debe minimizarse;
- la firma del dispositivo no equivale a veracidad del reporte;
- una suite criptográfica no puede congelarse hasta probar interoperabilidad en navegadores objetivo.
