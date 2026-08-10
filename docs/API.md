# API MVP

Base: `/api/v1`

## Emergencia pública sin cuenta
- `GET /health`
- `POST /incidents`
- `GET /incidents/map/public`
- `POST /reports/persons`
- `POST /reports/animals`
- `GET|POST /whatsapp/webhook`

## OTP
- `POST /auth/otp/request`
- `POST /auth/otp/verify`
- `POST /auth/logout`

## Damnificados autenticados
- `GET /affected/me`
- `POST /affected/profile`
- `POST /affected/:id/liveness/challenge`
- `POST /affected/:id/evidence/presign`
- `POST /affected/evidence/:assetId/complete`
- `POST /affected/:id/submit`
- `POST /assistance/needs`
- `POST /assistance/offers`

## Centro de mando
Requiere funcionario precargado + OTP. El token compartido existe solo para bootstrap local.

- `POST /officials/import`
- `GET /officials`
- `POST /incidents/official`
- `GET /incidents/command`
- `PATCH /incidents/:id/status`
- `GET|POST /units`
- `PATCH /units/:id/location`
- `POST /units/:unitId/assign/:incidentId`
- `GET /affected/command`
- `POST /affected/:id/verify`
- `POST /assistance/matches/propose`
- `GET /assistance/matches/command`
- `POST /assistance/matches/:id/approve`
- `GET /analytics/heatmap/incidents`
- `GET /analytics/heatmap/affected`
