CREATE TABLE IF NOT EXISTS secure_device_keys (
  emitter_key_id text PRIMARY KEY,
  public_key_spki_sha256 text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text
);

CREATE TABLE IF NOT EXISTS secure_sync_messages (
  message_id uuid PRIMARY KEY,
  ciphertext_sha256 text NOT NULL,
  emitter_key_id text NOT NULL,
  server_key_id text NOT NULL,
  kind text NOT NULL,
  processing_status text NOT NULL,
  public_entity_id text,
  rejection_code text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS secure_sync_messages_status_idx
  ON secure_sync_messages(processing_status, received_at DESC);
CREATE INDEX IF NOT EXISTS secure_sync_messages_emitter_idx
  ON secure_sync_messages(emitter_key_id, received_at DESC);
CREATE INDEX IF NOT EXISTS secure_sync_messages_expires_idx
  ON secure_sync_messages(expires_at);

CREATE TABLE IF NOT EXISTS secure_sync_receipts (
  id bigserial PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES secure_sync_messages(message_id) ON DELETE CASCADE,
  ciphertext_sha256 text NOT NULL,
  status text NOT NULL,
  public_entity_id text,
  reason_code text,
  receipt_signing_key_id text NOT NULL,
  server_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS secure_sync_receipts_message_idx
  ON secure_sync_receipts(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS secure_sync_metrics (
  minute_bucket timestamptz PRIMARY KEY,
  batches bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  replayed bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  total_latency_ms bigint NOT NULL DEFAULT 0
);
