CREATE TABLE IF NOT EXISTS reunification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('REU-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
  seeker_auth_subject text NOT NULL REFERENCES auth_identities(subject) ON DELETE CASCADE,
  target_lookup_token text NOT NULL,
  lookup_key_version integer NOT NULL,
  seeker_display_name text,
  declared_relationship text,
  message text,
  share_seeker_phone boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  CONSTRAINT reunification_requests_status_chk CHECK (
    -- Solo hechos que el seeker puede conocer por sí mismo. Acciones privadas del target
    -- jamás cambian este status para evitar un side-channel por re-submission.
    status IN ('ACTIVE','WITHDRAWN','EXPIRED','SELF_SUPPRESSED')
  ),
  CONSTRAINT reunification_requests_name_len_chk CHECK (seeker_display_name IS NULL OR char_length(seeker_display_name) <= 80),
  CONSTRAINT reunification_requests_relationship_len_chk CHECK (declared_relationship IS NULL OR char_length(declared_relationship) <= 40),
  CONSTRAINT reunification_requests_message_len_chk CHECK (message IS NULL OR char_length(message) <= 280)
);
CREATE INDEX IF NOT EXISTS reunification_requests_target_idx
  ON reunification_requests(lookup_key_version, target_lookup_token, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS reunification_requests_seeker_idx
  ON reunification_requests(seeker_auth_subject, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reunification_requests_active_pair_uq
  ON reunification_requests(seeker_auth_subject, lookup_key_version, target_lookup_token)
  WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS reunification_target_actions (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES reunification_requests(id) ON DELETE CASCADE,
  target_auth_subject text NOT NULL REFERENCES auth_identities(subject) ON DELETE CASCADE,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reunification_target_actions_action_chk CHECK (
    action IN ('REVEAL_CONTACT','IGNORE','BLOCK','REPORT_ABUSE')
  ),
  UNIQUE(request_id, target_auth_subject, action)
);
CREATE INDEX IF NOT EXISTS reunification_target_actions_target_idx
  ON reunification_target_actions(target_auth_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS reunification_target_actions_abuse_idx
  ON reunification_target_actions(action, created_at DESC)
  WHERE action='REPORT_ABUSE';

CREATE TABLE IF NOT EXISTS reunification_blocks (
  target_auth_subject text NOT NULL REFERENCES auth_identities(subject) ON DELETE CASCADE,
  seeker_auth_subject text NOT NULL REFERENCES auth_identities(subject) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(target_auth_subject, seeker_auth_subject),
  CONSTRAINT reunification_blocks_not_self_chk CHECK (target_auth_subject <> seeker_auth_subject)
);

-- No tabla de "matches" seeker-visible: que exista una coincidencia, login, lectura,
-- bloqueo o contacto es información privada de la persona buscada.
