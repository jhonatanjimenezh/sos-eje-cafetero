CREATE TABLE IF NOT EXISTS pet_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('PET-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  owner_auth_subject text NOT NULL REFERENCES auth_identities(subject),
  pet_name text NOT NULL,
  animal_type text NOT NULL,
  sex text NOT NULL DEFAULT 'UNKNOWN',
  approximate_age_months integer,
  breed text,
  color text,
  sterilized boolean,
  microchip_hash text,
  microchip_last4 text,
  owner_document_hash text,
  owner_document_last4 text,
  private_payload_ciphertext bytea NOT NULL,
  private_payload_iv bytea NOT NULL,
  private_payload_tag bytea NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_profiles_animal_type_ck CHECK (animal_type IN ('DOG','CAT','BIRD','OTHER')),
  CONSTRAINT pet_profiles_sex_ck CHECK (sex IN ('FEMALE','MALE','UNKNOWN')),
  CONSTRAINT pet_profiles_age_ck CHECK (approximate_age_months IS NULL OR approximate_age_months BETWEEN 0 AND 600),
  CONSTRAINT pet_profiles_status_ck CHECK (status IN ('ACTIVE','ARCHIVED')),
  CONSTRAINT pet_profiles_cipher_iv_ck CHECK (octet_length(private_payload_iv)=12),
  CONSTRAINT pet_profiles_cipher_tag_ck CHECK (octet_length(private_payload_tag)=16)
);
CREATE INDEX IF NOT EXISTS pet_profiles_owner_idx ON pet_profiles(owner_auth_subject, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pet_profiles_microchip_owner_uq
  ON pet_profiles(owner_auth_subject, microchip_hash)
  WHERE microchip_hash IS NOT NULL AND status='ACTIVE';

CREATE TABLE IF NOT EXISTS pet_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('PETC-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  pet_profile_id uuid REFERENCES pet_profiles(id),
  created_by_subject text NOT NULL REFERENCES auth_identities(subject),
  kind text NOT NULL,
  animal_type text NOT NULL,
  public_name text NOT NULL,
  public_description text,
  breed text,
  color text,
  city text NOT NULL DEFAULT 'Manizales',
  area_hint text,
  exact_location geography(Point,4326),
  occurred_at timestamptz,
  share_creator_phone boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_cases_kind_ck CHECK (kind IN ('LOST','FOUND')),
  CONSTRAINT pet_cases_animal_type_ck CHECK (animal_type IN ('DOG','CAT','BIRD','OTHER')),
  CONSTRAINT pet_cases_status_ck CHECK (status IN ('OPEN','MATCH_REVIEW','REUNITED','CLOSED','ABUSE_HOLD')),
  CONSTRAINT pet_cases_lost_profile_ck CHECK (kind <> 'LOST' OR pet_profile_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pet_cases_public_idx ON pet_cases(kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pet_cases_location_gix ON pet_cases USING gist(exact_location);
CREATE UNIQUE INDEX IF NOT EXISTS pet_cases_active_lost_profile_uq
  ON pet_cases(pet_profile_id)
  WHERE kind='LOST' AND status IN ('OPEN','MATCH_REVIEW');

CREATE TABLE IF NOT EXISTS pet_case_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES pet_cases(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'PUBLIC_PHOTO',
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  declared_sha256 text NOT NULL,
  declared_size_bytes bigint NOT NULL,
  actual_sha256 text,
  actual_size_bytes bigint,
  upload_status text NOT NULL DEFAULT 'PENDING',
  scan_status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT pet_case_media_kind_ck CHECK (kind='PUBLIC_PHOTO'),
  CONSTRAINT pet_case_media_status_ck CHECK (upload_status IN ('PENDING','READY','REJECTED')),
  CONSTRAINT pet_case_media_size_ck CHECK (declared_size_bytes BETWEEN 1 AND 15000000)
);
CREATE INDEX IF NOT EXISTS pet_case_media_case_idx ON pet_case_media(case_id, upload_status, created_at DESC);

CREATE TABLE IF NOT EXISTS pet_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('PCL-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  case_id uuid NOT NULL REFERENCES pet_cases(id) ON DELETE CASCADE,
  claimant_subject text NOT NULL REFERENCES auth_identities(subject),
  claimant_role text NOT NULL,
  pet_profile_id uuid REFERENCES pet_profiles(id),
  share_claimant_phone boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING_EVIDENCE',
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_claims_role_ck CHECK (claimant_role IN ('FINDER','OWNER_CLAIMANT')),
  CONSTRAINT pet_claims_status_ck CHECK (status IN ('PENDING_EVIDENCE','EVIDENCE_READY','WITHDRAWN','EXPIRED')),
  CONSTRAINT pet_claims_owner_profile_ck CHECK (claimant_role <> 'OWNER_CLAIMANT' OR pet_profile_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pet_claims_case_idx ON pet_claims(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pet_claims_claimant_idx ON pet_claims(claimant_subject, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pet_claims_active_actor_case_uq
  ON pet_claims(case_id, claimant_subject)
  WHERE status IN ('PENDING_EVIDENCE','EVIDENCE_READY');

CREATE TABLE IF NOT EXISTS pet_claim_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES pet_claims(id) ON DELETE CASCADE,
  challenge_code text NOT NULL,
  challenge_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pet_claim_challenges_claim_idx ON pet_claim_challenges(claim_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pet_claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES pet_claims(id) ON DELETE CASCADE,
  challenge_id uuid REFERENCES pet_claim_challenges(id),
  kind text NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  declared_sha256 text NOT NULL,
  declared_size_bytes bigint NOT NULL,
  actual_sha256 text,
  actual_size_bytes bigint,
  upload_status text NOT NULL DEFAULT 'PENDING',
  scan_status text NOT NULL DEFAULT 'PENDING',
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT pet_claim_evidence_kind_ck CHECK (kind IN ('PROOF_OF_LIFE','OWNERSHIP_HISTORY')),
  CONSTRAINT pet_claim_evidence_status_ck CHECK (upload_status IN ('PENDING','READY','REJECTED')),
  CONSTRAINT pet_claim_evidence_size_ck CHECK (declared_size_bytes BETWEEN 1 AND 50000000),
  CONSTRAINT pet_claim_evidence_challenge_ck CHECK (kind <> 'PROOF_OF_LIFE' OR challenge_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pet_claim_evidence_claim_idx ON pet_claim_evidence(claim_id, kind, upload_status, created_at DESC);

CREATE TABLE IF NOT EXISTS pet_claim_actions (
  id bigserial PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES pet_claims(id) ON DELETE CASCADE,
  actor_subject text NOT NULL REFERENCES auth_identities(subject),
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_claim_actions_action_ck CHECK (action IN (
    'OWNER_AUTHORIZE_CONTACT','OWNER_REJECT','OWNER_BLOCK','OWNER_REPORT_ABUSE',
    'FINDER_ACCEPT_OWNER','FINDER_REJECT_OWNER','FINDER_BLOCK_OWNER','FINDER_REPORT_ABUSE'
  ))
);
CREATE INDEX IF NOT EXISTS pet_claim_actions_claim_idx ON pet_claim_actions(claim_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pet_claim_authorize_once_uq
  ON pet_claim_actions(claim_id, action)
  WHERE action IN ('OWNER_AUTHORIZE_CONTACT','FINDER_ACCEPT_OWNER');

CREATE TABLE IF NOT EXISTS pet_blocks (
  id bigserial PRIMARY KEY,
  blocker_subject text NOT NULL REFERENCES auth_identities(subject),
  blocked_subject text NOT NULL REFERENCES auth_identities(subject),
  context text NOT NULL DEFAULT 'PET_CLAIM',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(blocker_subject, blocked_subject, context)
);

-- V1 public projection intentionally exposes only fields the web catalog is allowed
-- to render. Species/rasgos/location remain internal even though the case stores them.
CREATE OR REPLACE VIEW public_pet_cases AS
SELECT
  c.public_id,
  c.kind,
  c.public_name,
  c.status,
  c.created_at
FROM pet_cases c
WHERE c.status IN ('OPEN','MATCH_REVIEW');
