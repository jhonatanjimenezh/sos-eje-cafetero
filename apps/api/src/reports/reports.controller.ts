import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { OfficialGuard } from '../auth/official.guard';
import { PG_POOL } from '../database/database.module';
@Controller('reports')
export class ReportsController {
  constructor(@Inject(PG_POOL) private readonly db:Pool) {}

  @Post('persons') async person(@Body() b:any){
    const dup=await this.db.query(`SELECT id,public_id,
      CASE WHEN $3::float IS NULL OR last_seen_location IS NULL THEN NULL ELSE ST_Distance(last_seen_location,ST_SetSRID(ST_MakePoint($4,$3),4326)::geography) END meters,
      similarity(lower(coalesce(name,'')),lower(coalesce($2,''))) name_similarity
      FROM person_reports WHERE report_kind=$1 AND status='OPEN' AND created_at>now()-interval '7 days'
      AND (similarity(lower(coalesce(name,'')),lower(coalesce($2,'')))>0.55 OR ($3::float IS NOT NULL AND last_seen_location IS NOT NULL AND ST_DWithin(last_seen_location,ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,300)))
      ORDER BY name_similarity DESC NULLS LAST LIMIT 1`,[b.reportKind,b.name??'',b.lat??null,b.lng??null]);
    const r=await this.db.query(`INSERT INTO person_reports(report_kind,name,approximate_age,description,photo_url,last_seen_location,reporter_phone,potential_duplicate_of)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $6::float IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7,$6),4326)::geography END,$8,$9)
      RETURNING public_id,status,created_at,potential_duplicate_of`,[b.reportKind,b.name??null,b.approximateAge??null,b.description??null,b.photoUrl??null,b.lat??null,b.lng??null,b.reporterPhone??null,dup.rows[0]?.id??null]);
    return {...r.rows[0],potentialDuplicate:dup.rows[0]??null};
  }

  @Post('animals') async animal(@Body() b:any){
    const dup=await this.db.query(`SELECT id,public_id,
      CASE WHEN $4::float IS NULL OR last_seen_location IS NULL THEN NULL ELSE ST_Distance(last_seen_location,ST_SetSRID(ST_MakePoint($5,$4),4326)::geography) END meters,
      similarity(lower(coalesce(name,'')),lower(coalesce($2,''))) name_similarity
      FROM animal_reports WHERE report_kind=$1 AND animal_type=$3 AND status='OPEN' AND created_at>now()-interval '7 days'
      AND (similarity(lower(coalesce(name,'')),lower(coalesce($2,'')))>0.55 OR ($4::float IS NOT NULL AND last_seen_location IS NOT NULL AND ST_DWithin(last_seen_location,ST_SetSRID(ST_MakePoint($5,$4),4326)::geography,300)))
      ORDER BY name_similarity DESC NULLS LAST LIMIT 1`,[b.reportKind,b.name??'',b.animalType??'OTHER',b.lat??null,b.lng??null]);
    const r=await this.db.query(`INSERT INTO animal_reports(report_kind,animal_type,name,breed,color,description,photo_url,last_seen_location,reporter_phone,potential_duplicate_of)
      VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::float IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9,$8),4326)::geography END,$10,$11)
      RETURNING public_id,status,created_at,potential_duplicate_of`,[b.reportKind,b.animalType??'OTHER',b.name??null,b.breed??null,b.color??null,b.description??null,b.photoUrl??null,b.lat??null,b.lng??null,b.reporterPhone??null,dup.rows[0]?.id??null]);
    return {...r.rows[0],potentialDuplicate:dup.rows[0]??null};
  }

  @UseGuards(OfficialGuard) @Get('persons/command')
  async persons(){ const r=await this.db.query(`SELECT id,public_id,report_kind,name,approximate_age,description,photo_url,reporter_phone,status,potential_duplicate_of,
    ST_Y(last_seen_location::geometry) lat,ST_X(last_seen_location::geometry) lng,created_at FROM person_reports ORDER BY created_at DESC LIMIT 5000`); return r.rows; }

  @UseGuards(OfficialGuard) @Get('animals/command')
  async animals(){ const r=await this.db.query(`SELECT id,public_id,report_kind,animal_type,name,breed,color,description,photo_url,reporter_phone,status,potential_duplicate_of,
    ST_Y(last_seen_location::geometry) lat,ST_X(last_seen_location::geometry) lng,created_at FROM animal_reports ORDER BY created_at DESC LIMIT 5000`); return r.rows; }
}
