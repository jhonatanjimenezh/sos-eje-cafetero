ALTER TABLE affected_profiles
  ADD COLUMN IF NOT EXISTS liveness_provider text NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS liveness_provider_session_id text,
  ADD COLUMN IF NOT EXISTS liveness_provider_status text,
  ADD COLUMN IF NOT EXISTS liveness_confidence numeric,
  ADD COLUMN IF NOT EXISTS liveness_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liveness_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS liveness_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS liveness_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS liveness_consent_version text;

ALTER TABLE evidence_assets
  ADD COLUMN IF NOT EXISTS declared_sha256 text,
  ADD COLUMN IF NOT EXISTS declared_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS content_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS malware_scan_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS malware_scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

CREATE INDEX IF NOT EXISTS evidence_assets_security_idx
  ON evidence_assets(affected_profile_id, upload_status, malware_scan_status);

CREATE TABLE IF NOT EXISTS liveness_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_session_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'CREATED',
  confidence numeric,
  attempt_number integer NOT NULL,
  consent_version text NOT NULL,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS liveness_sessions_profile_idx
  ON liveness_sessions(affected_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS identity_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  requested_by_subject text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  resolution_notes text,
  resolved_by_official_id uuid REFERENCES official_profiles(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_review_requests_profile_idx
  ON identity_review_requests(affected_profile_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS identity_review_requests_one_open_uq
  ON identity_review_requests(affected_profile_id, kind)
  WHERE status='OPEN';

CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events(actor_official_id, created_at DESC)
  WHERE actor_official_id IS NOT NULL;
