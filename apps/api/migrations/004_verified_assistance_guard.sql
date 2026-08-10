CREATE OR REPLACE FUNCTION enforce_verified_identity_for_assistance_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  beneficiary_status text;
BEGIN
  IF NEW.status = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'APPROVED') THEN
    SELECT p.verification_status
      INTO beneficiary_status
      FROM assistance_needs n
      JOIN affected_profiles p ON p.id = n.affected_profile_id
     WHERE n.id = NEW.need_id;

    IF beneficiary_status IS DISTINCT FROM 'VERIFIED' THEN
      RAISE EXCEPTION 'assistance match cannot be approved unless beneficiary identity is VERIFIED'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistance_matches_verified_identity_guard ON assistance_matches;
CREATE TRIGGER assistance_matches_verified_identity_guard
BEFORE INSERT OR UPDATE OF status ON assistance_matches
FOR EACH ROW
EXECUTE FUNCTION enforce_verified_identity_for_assistance_match();
