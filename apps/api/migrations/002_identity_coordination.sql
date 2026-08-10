CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_idempotency_key text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reported_by_official_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_idempotency_uq
  ON incidents(source, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agencies_name_ci_uq ON agencies ((lower(name)));

CREATE TABLE IF NOT EXISTS auth_identities (
  subject text PRIMARY KEY,
  phone_e164 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_identities_phone_idx ON auth_identities(phone_e164);

CREATE TABLE IF NOT EXISTS official_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE,
  full_name text NOT NULL,
  phone_e164 text NOT NULL UNIQUE,
  agency_id uuid NOT NULL REFERENCES agencies(id),
  role text NOT NULL DEFAULT 'FIELD_OPERATOR',
  status text NOT NULL DEFAULT 'ACTIVE',
  imported_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profiles_agency_idx ON official_profiles(agency_id, status);

ALTER TABLE incidents
  ADD CONSTRAINT incidents_reported_by_official_fk
  FOREIGN KEY (reported_by_official_id) REFERENCES official_profiles(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS affected_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('DAM-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  auth_subject text NOT NULL UNIQUE REFERENCES auth_identities(subject),
  full_name text NOT NULL,
  document_type text NOT NULL,
  document_number_hash text NOT NULL UNIQUE,
  document_last4 text NOT NULL,
  address text NOT NULL,
  location geography(Point,4326) NOT NULL,
  city text NOT NULL DEFAULT 'Manizales',
  neighborhood text,
  household_size integer NOT NULL DEFAULT 1,
  notes text,
  verification_status text NOT NULL DEFAULT 'DRAFT',
  consent_sensitive_data_at timestamptz NOT NULL,
  consent_version text NOT NULL,
  liveness_challenge_id uuid,
  liveness_status text NOT NULL DEFAULT 'NOT_STARTED',
  liveness_score numeric,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affected_profiles_location_gix ON affected_profiles USING gist(location);
CREATE INDEX IF NOT EXISTS affected_profiles_status_idx ON affected_profiles(verification_status, created_at DESC);

CREATE TABLE IF NOT EXISTS verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  challenge_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE affected_profiles
  ADD CONSTRAINT affected_profiles_liveness_challenge_fk
  FOREIGN KEY (liveness_challenge_id) REFERENCES verification_challenges(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS evidence_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  sha256 text,
  size_bytes bigint,
  upload_status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS evidence_assets_profile_idx ON evidence_assets(affected_profile_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_assets_sha_kind_uq
  ON evidence_assets(affected_profile_id, kind, sha256)
  WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS beneficiary_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  official_id uuid NOT NULL REFERENCES official_profiles(id),
  decision text NOT NULL,
  method text NOT NULL DEFAULT 'FIELD_OR_DESK_REVIEW',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beneficiary_verifications_profile_idx ON beneficiary_verifications(affected_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistance_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('NEE-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  affected_profile_id uuid NOT NULL REFERENCES affected_profiles(id) ON DELETE CASCADE,
  category text NOT NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unidad',
  priority text NOT NULL DEFAULT 'MEDIUM',
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assistance_needs_active_uq
  ON assistance_needs(affected_profile_id, category)
  WHERE status IN ('OPEN','MATCHED','IN_PROGRESS');

CREATE TABLE IF NOT EXISTS assistance_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('OFR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  auth_subject text NOT NULL REFERENCES auth_identities(subject),
  provider_name text NOT NULL,
  phone_e164 text NOT NULL,
  category text NOT NULL,
  description text,
  quantity_available numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unidad',
  location geography(Point,4326) NOT NULL,
  radius_meters integer NOT NULL DEFAULT 10000,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistance_offers_location_gix ON assistance_offers USING gist(location);
CREATE INDEX IF NOT EXISTS assistance_offers_category_idx ON assistance_offers(category, status);

CREATE TABLE IF NOT EXISTS assistance_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_id uuid NOT NULL REFERENCES assistance_needs(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES assistance_offers(id) ON DELETE CASCADE,
  score numeric NOT NULL,
  distance_meters numeric NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED',
  approved_by_official_id uuid REFERENCES official_profiles(id),
  approved_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(need_id, offer_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_subject text,
  actor_official_id uuid REFERENCES official_profiles(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

ALTER TABLE person_reports ADD COLUMN IF NOT EXISTS potential_duplicate_of uuid REFERENCES person_reports(id);
ALTER TABLE person_reports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WEB';
ALTER TABLE animal_reports ADD COLUMN IF NOT EXISTS potential_duplicate_of uuid REFERENCES animal_reports(id);
ALTER TABLE animal_reports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WEB';
