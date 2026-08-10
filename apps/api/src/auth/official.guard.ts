import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class OfficialGuard implements CanActivate {
  constructor(private readonly jwt: JwtAuthGuard, @Inject(PG_POOL) private readonly db: Pool) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.jwt.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    const r = await this.db.query(`SELECT o.id,o.auth_subject,o.full_name,o.phone_e164,o.role,o.status,a.name agency
      FROM official_profiles o JOIN agencies a ON a.id=o.agency_id
      WHERE o.auth_subject=$1 AND o.status='ACTIVE'`, [req.auth.sub]);
    if (!r.rowCount) throw new ForbiddenException('Cuenta no autorizada como funcionario');
    req.official = r.rows[0];
    return true;
  }
}
