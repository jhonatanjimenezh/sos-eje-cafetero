ALTER TABLE pet_case_media
  ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS moderated_by_official_id uuid REFERENCES official_profiles(id),
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_reason text;

ALTER TABLE pet_case_media DROP CONSTRAINT IF EXISTS pet_case_media_moderation_status_ck;
ALTER TABLE pet_case_media
  ADD CONSTRAINT pet_case_media_moderation_status_ck
  CHECK (moderation_status IN ('PENDING','APPROVED','REJECTED'));

ALTER TABLE pet_case_media DROP CONSTRAINT IF EXISTS pet_case_media_moderation_actor_ck;
ALTER TABLE pet_case_media
  ADD CONSTRAINT pet_case_media_moderation_actor_ck
  CHECK (
    (moderation_status='PENDING' AND moderated_by_official_id IS NULL AND moderated_at IS NULL)
    OR
    (moderation_status IN ('APPROVED','REJECTED') AND moderated_by_official_id IS NOT NULL AND moderated_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS pet_case_media_moderation_queue_idx
  ON pet_case_media(moderation_status, upload_status, created_at)
  WHERE kind='PUBLIC_PHOTO';
