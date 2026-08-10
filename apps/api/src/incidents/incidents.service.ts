import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { CreateIncidentDto } from './dto';

@Injectable()
export class IncidentsService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  async create(dto: CreateIncidentDto, source='WEB', idempotencyKey?: string | null, officialId?: string | null) {
    if (idempotencyKey) {
      const existing = await this.db.query(`SELECT id,public_id,type,priority,status,created_at,potential_duplicate_of
        FROM incidents WHERE source=$1 AND source_idempotency_key=$2 LIMIT 1`, [source,idempotencyKey]);
      if (existing.rowCount) return { ...existing.rows[0], idempotentReplay: true };
    }

    const duplicate = await this.db.query(`
      SELECT id, public_id, ST_Distance(location, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS meters,
        similarity(lower(coalesce(description,'')),lower($4)) description_similarity
      FROM incidents
      WHERE type=$3 AND status NOT IN ('RESOLVED','INVALID','DUPLICATE')
        AND created_at > now() - interval '45 minutes'
        AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 180)
      ORDER BY (ST_Distance(location, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) -
        (similarity(lower(coalesce(description,'')),lower($4))*50)) ASC LIMIT 1`,
      [dto.lat, dto.lng, dto.type, dto.description ?? '']);

    try {
      const result = await this.db.query(`
        INSERT INTO incidents(type,priority,source,source_idempotency_key,reported_by_official_id,location,address,city,neighborhood,
          description,people_affected,people_trapped,contact_phone,building_damage_level,potential_duplicate_of)
        VALUES($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($7,$6),4326)::geography,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING id,public_id,type,priority,status,created_at,potential_duplicate_of`, [
          dto.type, dto.priority ?? 'MEDIUM', source, idempotencyKey ?? null, officialId ?? null,
          dto.lat, dto.lng, dto.address ?? null, dto.city ?? 'Manizales', dto.neighborhood ?? null, dto.description ?? null,
          dto.peopleAffected ?? 0, dto.peopleTrapped ?? 0, dto.contactPhone ?? null, dto.buildingDamageLevel ?? null, duplicate.rows[0]?.id ?? null,
        ]);
      return { ...result.rows[0], potentialDuplicate: duplicate.rows[0] ?? null };
    } catch (e: any) {
      if (e?.code === '23505' && idempotencyKey) {
        const replay = await this.db.query('SELECT id,public_id,type,priority,status,created_at,potential_duplicate_of FROM incidents WHERE source=$1 AND source_idempotency_key=$2',[source,idempotencyKey]);
        return { ...replay.rows[0], idempotentReplay: true };
      }
      throw e;
    }
  }

  async publicMap() {
    const r = await this.db.query(`SELECT public_id,type,priority,status,city,neighborhood,
      round(ST_Y(location::geometry)::numeric,3)::float AS lat,
      round(ST_X(location::geometry)::numeric,3)::float AS lng,
      created_at FROM incidents WHERE status NOT IN ('INVALID','DUPLICATE') ORDER BY created_at DESC LIMIT 2000`);
    return r.rows;
  }

  async operational() {
    const r = await this.db.query(`SELECT i.id,i.public_id,i.type,i.priority,i.status,i.source,i.address,i.city,i.neighborhood,i.description,
      i.people_affected,i.people_trapped,i.contact_phone,i.building_damage_level,i.potential_duplicate_of,
      ST_Y(i.location::geometry) AS lat,ST_X(i.location::geometry) AS lng,i.created_at,i.updated_at,
      o.full_name reported_by,o.id reported_by_official_id,a.name reported_by_agency
      FROM incidents i LEFT JOIN official_profiles o ON o.id=i.reported_by_official_id LEFT JOIN agencies a ON a.id=o.agency_id
      ORDER BY CASE i.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, i.created_at DESC LIMIT 5000`);
    return r.rows;
  }

  async updateStatus(id: string, status: string) {
    const r = await this.db.query('UPDATE incidents SET status=$2, updated_at=now() WHERE id=$1 RETURNING *',[id,status]);
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }
}
