-- Public pet discovery must not become a claim/match-progress oracle.
-- V1 exposes only the opaque case id, LOST/FOUND partition and display name.
-- PostgreSQL CREATE OR REPLACE VIEW cannot remove existing columns, so this
-- privacy-tightening migration explicitly recreates the view.
DROP VIEW IF EXISTS public_pet_cases;

CREATE VIEW public_pet_cases AS
SELECT
  c.public_id,
  c.kind,
  c.public_name
FROM pet_cases c
WHERE c.status IN ('OPEN','MATCH_REVIEW');
