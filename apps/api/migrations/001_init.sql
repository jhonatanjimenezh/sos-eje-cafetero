CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('SOS-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  type text NOT NULL,
  priority text NOT NULL DEFAULT 'MEDIUM',
  status text NOT NULL DEFAULT 'REPORTED',
  source text NOT NULL DEFAULT 'WEB',
  location geography(Point,4326) NOT NULL,
  address text,
  city text NOT NULL DEFAULT 'Manizales',
  neighborhood text,
  description text,
  people_affected integer NOT NULL DEFAULT 0,
  people_trapped integer NOT NULL DEFAULT 0,
  contact_phone text,
  building_damage_level text,
  potential_duplicate_of uuid REFERENCES incidents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_location_gix ON incidents USING gist(location);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS response_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid REFERENCES agencies(id),
  callsign text NOT NULL UNIQUE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE',
  last_location geography(Point,4326),
  crew_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS response_units_location_gix ON response_units USING gist(last_location);

CREATE TABLE IF NOT EXISTS incident_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES response_units(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ASSIGNED',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  UNIQUE(incident_id, unit_id)
);

CREATE TABLE IF NOT EXISTS person_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('PER-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  report_kind text NOT NULL,
  name text,
  approximate_age integer,
  description text,
  photo_url text,
  last_seen_location geography(Point,4326),
  reporter_phone text,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS person_reports_location_gix ON person_reports USING gist(last_seen_location);

CREATE TABLE IF NOT EXISTS animal_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('ANI-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  report_kind text NOT NULL,
  animal_type text NOT NULL DEFAULT 'OTHER',
  name text,
  breed text,
  color text,
  description text,
  photo_url text,
  last_seen_location geography(Point,4326),
  reporter_phone text,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS animal_reports_location_gix ON animal_reports USING gist(last_seen_location);
