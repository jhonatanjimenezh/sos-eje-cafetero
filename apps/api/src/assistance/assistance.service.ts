import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { CreateNeedDto, CreateOfferDto } from './dto';

@Injectable()
export class AssistanceService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  async createNeed(subject: string, dto: CreateNeedDto) {
    const p = await this.db.query('SELECT id,verification_status FROM affected_profiles WHERE auth_subject=$1', [subject]);
    if (!p.rowCount) throw new BadRequestException('Primero complete su registro como damnificado');
    if (!['PENDING_OFFICIAL_VERIFICATION','VERIFIED','NEEDS_INFO'].includes(p.rows[0].verification_status)) throw new BadRequestException('Complete y envíe su registro antes de declarar necesidades');
    try {
      const r = await this.db.query(`INSERT INTO assistance_needs(affected_profile_id,category,description,quantity,unit,priority)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,public_id,category,quantity,unit,priority,status,created_at`,
        [p.rows[0].id,dto.category,dto.description??null,dto.quantity,dto.unit??'unidad',dto.priority??'MEDIUM']);
      return r.rows[0];
    } catch (e: any) {
      if (e?.code === '23505') throw new BadRequestException('Ya existe una necesidad activa de esta categoría; actualícela en lugar de duplicarla');
      throw e;
    }
  }

  async createOffer(subject: string, dto: CreateOfferDto) {
    const i = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [subject]);
    if (!i.rowCount) throw new ForbiddenException();
    const r = await this.db.query(`INSERT INTO assistance_offers(auth_subject,provider_name,phone_e164,category,description,quantity_available,unit,location,radius_meters)
      VALUES($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($9,$8),4326)::geography,$10)
      RETURNING id,public_id,category,quantity_available,unit,radius_meters,status,created_at`,
      [subject,dto.providerName.trim(),i.rows[0].phone_e164,dto.category,dto.description??null,dto.quantityAvailable,dto.unit??'unidad',dto.lat,dto.lng,dto.radiusMeters]);
    return r.rows[0];
  }

  async proposeMatches(needId?: string, official?: any) {
    if (official && !['VERIFIER','COORDINATOR','DISPATCHER','ADMIN'].includes(official.role)) throw new ForbiddenException('Rol insuficiente para generar matches');
    const params: any[] = [];
    let filter = '';
    if (needId) { params.push(needId); filter = 'AND n.id=$1'; }
    const r = await this.db.query(`SELECT n.id need_id,o.id offer_id,
      ST_Distance(p.location,o.location) distance_meters,
      LEAST(100, 55 + CASE WHEN o.quantity_available>=n.quantity THEN 20 ELSE 5 END +
        GREATEST(0,25-(ST_Distance(p.location,o.location)/1000))) score
      FROM assistance_needs n
      JOIN affected_profiles p ON p.id=n.affected_profile_id
      JOIN assistance_offers o ON o.category=n.category AND o.status='ACTIVE'
      WHERE n.status='OPEN' AND p.verification_status='VERIFIED'
        AND ST_DWithin(p.location,o.location,o.radius_meters) ${filter}
      ORDER BY score DESC,distance_meters ASC LIMIT 500`, params);
    for (const m of r.rows) {
      await this.db.query(`INSERT INTO assistance_matches(need_id,offer_id,score,distance_meters)
        VALUES($1,$2,$3,$4) ON CONFLICT(need_id,offer_id) DO UPDATE SET score=excluded.score,distance_meters=excluded.distance_meters`,
        [m.need_id,m.offer_id,m.score,m.distance_meters]);
    }
    return { proposed: r.rowCount };
  }

  async commandMatches() {
    const r = await this.db.query(`SELECT m.id,m.status,m.score,m.distance_meters,n.public_id need_public_id,n.category,n.quantity,n.unit,
      p.public_id affected_public_id,p.full_name,p.verification_status,o.public_id offer_public_id,o.provider_name,o.quantity_available,o.phone_e164 offer_phone,
      ST_Y(p.location::geometry) affected_lat,ST_X(p.location::geometry) affected_lng,
      ST_Y(o.location::geometry) offer_lat,ST_X(o.location::geometry) offer_lng
      FROM assistance_matches m JOIN assistance_needs n ON n.id=m.need_id JOIN affected_profiles p ON p.id=n.affected_profile_id
      JOIN assistance_offers o ON o.id=m.offer_id ORDER BY CASE m.status WHEN 'PROPOSED' THEN 1 WHEN 'APPROVED' THEN 2 ELSE 3 END,m.score DESC LIMIT 1000`);
    return r.rows;
  }

  async approveMatch(id: string, official: any) {
    if (!['COORDINATOR','DISPATCHER','ADMIN'].includes(official.role)) throw new ForbiddenException('Rol insuficiente para aprobar matches');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`UPDATE assistance_matches m
        SET status='APPROVED',approved_by_official_id=$2,approved_at=now()
        FROM assistance_needs n, affected_profiles p
        WHERE m.id=$1
          AND m.status='PROPOSED'
          AND n.id=m.need_id
          AND p.id=n.affected_profile_id
          AND p.verification_status='VERIFIED'
        RETURNING m.need_id,m.offer_id`, [id,official.id]);
      if (!r.rowCount) {
        const exists = await client.query(`SELECT m.id,p.verification_status
          FROM assistance_matches m
          JOIN assistance_needs n ON n.id=m.need_id
          JOIN affected_profiles p ON p.id=n.affected_profile_id
          WHERE m.id=$1`, [id]);
        if (exists.rowCount && exists.rows[0].verification_status !== 'VERIFIED') {
          throw new ForbiddenException('No se puede aprobar ayuda para un expediente cuya identidad no esté VERIFIED');
        }
        throw new NotFoundException('Match no encontrado o ya procesado');
      }
      await client.query(`UPDATE assistance_needs SET status='MATCHED',updated_at=now() WHERE id=$1`, [r.rows[0].need_id]);
      await client.query(`INSERT INTO audit_events(actor_subject,actor_official_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'ASSISTANCE_MATCH_APPROVED','assistance_match',$3,$4::jsonb)`,
        [official.auth_subject??null,official.id,id,JSON.stringify({ identityStatus: 'VERIFIED' })]);
      await client.query('COMMIT');
      return { status:'APPROVED' };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
