import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { OfficialGuard } from '../auth/official.guard';
import { PG_POOL } from '../database/database.module';
@Controller('units')
@UseGuards(OfficialGuard)
export class UnitsController {
  constructor(@Inject(PG_POOL) private readonly db:Pool) {}
  @Post() async create(@Body() b:any){ const r=await this.db.query('INSERT INTO response_units(callsign,kind,status,crew_count) VALUES($1,$2,$3,$4) RETURNING *',[b.callsign,b.kind,b.status??'AVAILABLE',b.crewCount??0]); return r.rows[0]; }
  @Patch(':id/location') async location(@Param('id') id:string,@Body() b:any){ const r=await this.db.query('UPDATE response_units SET last_location=ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,status=COALESCE($4,status),updated_at=now() WHERE id=$1 RETURNING *',[id,b.lat,b.lng,b.status??null]); return r.rows[0]; }
  @Get() async list(){ const r=await this.db.query(`SELECT id,callsign,kind,status,crew_count,ST_Y(last_location::geometry) lat,ST_X(last_location::geometry) lng,updated_at FROM response_units ORDER BY callsign`); return r.rows; }
  @Post(':unitId/assign/:incidentId') async assign(@Param('unitId') unitId:string,@Param('incidentId') incidentId:string){
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const a=await client.query(`INSERT INTO incident_assignments(incident_id,unit_id) VALUES($1,$2) ON CONFLICT(incident_id,unit_id) DO UPDATE SET status='ASSIGNED',cleared_at=NULL RETURNING *`,[incidentId,unitId]);
      await client.query("UPDATE response_units SET status='DISPATCHED',updated_at=now() WHERE id=$1",[unitId]);
      await client.query("UPDATE incidents SET status='ASSIGNED',updated_at=now() WHERE id=$1",[incidentId]);
      await client.query('COMMIT');
      return a.rows[0];
    } catch(e){ await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
}
