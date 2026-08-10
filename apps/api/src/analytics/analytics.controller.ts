import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { OfficialGuard } from '../auth/official.guard';
import { PG_POOL } from '../database/database.module';

@Controller('analytics')
@UseGuards(OfficialGuard)
export class AnalyticsController {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  @Get('heatmap/incidents')
  async incidents() {
    const r=await this.db.query(`SELECT ST_GeoHash(location::geometry,7) geohash,count(*)::int weight,
      avg(ST_Y(location::geometry)) lat,avg(ST_X(location::geometry)) lng,
      count(*) FILTER (WHERE priority='CRITICAL')::int critical
      FROM incidents WHERE status NOT IN ('INVALID','DUPLICATE','RESOLVED') GROUP BY geohash ORDER BY weight DESC LIMIT 2000`);
    return r.rows;
  }

  @Get('heatmap/affected')
  async affected() {
    const r=await this.db.query(`SELECT ST_GeoHash(location::geometry,7) geohash,count(*)::int weight,
      avg(ST_Y(location::geometry)) lat,avg(ST_X(location::geometry)) lng,
      sum(household_size)::int people
      FROM affected_profiles WHERE verification_status='VERIFIED' GROUP BY geohash ORDER BY people DESC LIMIT 2000`);
    return r.rows;
  }
}
