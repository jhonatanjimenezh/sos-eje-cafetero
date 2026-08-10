import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { Pool } from 'pg';
import { normalizePhone } from '../common/phone';
import { PG_POOL } from '../database/database.module';

const ROLES = new Set(['COORDINATOR','DISPATCHER','FIELD_OPERATOR','VERIFIER','VIEWER','ADMIN']);

@Injectable()
export class OfficialsService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  async importCsv(buffer: Buffer, importedBy: string) {
    let rows: any[];
    try {
      rows = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      throw new BadRequestException('CSV inválido');
    }
    if (!rows.length) throw new BadRequestException('El CSV no contiene funcionarios');
    if (rows.length > 5000) throw new BadRequestException('Máximo 5000 funcionarios por archivo');

    const client = await this.db.connect();
    const result = { inserted: 0, updated: 0, errors: [] as Array<{ row: number; error: string }> };
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          const fullName = String(r.full_name ?? r.nombre ?? '').trim();
          const agencyName = String(r.agency ?? r.entidad ?? '').trim();
          const phone = normalizePhone(String(r.phone ?? r.telefono ?? ''));
          const role = String(r.role ?? r.rol ?? 'FIELD_OPERATOR').trim().toUpperCase();
          if (!fullName || !agencyName) throw new Error('nombre y entidad son obligatorios');
          if (!ROLES.has(role)) throw new Error(`rol inválido: ${role}`);

          await client.query(`INSERT INTO agencies(name,kind) VALUES($1,'PUBLIC') ON CONFLICT DO NOTHING`, [agencyName]);
          const agency = await client.query('SELECT id FROM agencies WHERE lower(name)=lower($1) LIMIT 1', [agencyName]);
          const existing = await client.query('SELECT id FROM official_profiles WHERE phone_e164=$1', [phone]);
          await client.query(`INSERT INTO official_profiles(full_name,phone_e164,agency_id,role,status,imported_by)
            VALUES($1,$2,$3,$4,'ACTIVE',$5)
            ON CONFLICT(phone_e164) DO UPDATE SET full_name=excluded.full_name,agency_id=excluded.agency_id,
              role=excluded.role,status='ACTIVE',imported_by=excluded.imported_by,updated_at=now()`,
            [fullName, phone, agency.rows[0].id, role, importedBy]);
          existing.rowCount ? result.updated++ : result.inserted++;
        } catch (e: any) {
          result.errors.push({ row: i + 2, error: e.message ?? String(e) });
        }
      }
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }

  async list() {
    const r = await this.db.query(`SELECT o.id,o.full_name,o.phone_e164,o.role,o.status,a.name agency,o.updated_at
      FROM official_profiles o JOIN agencies a ON a.id=o.agency_id ORDER BY a.name,o.full_name`);
    return r.rows;
  }
}
