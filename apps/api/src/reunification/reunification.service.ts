import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { normalizePhone } from '../common/phone';
import { PG_POOL } from '../database/database.module';
import {
  CreateReunificationRequestDto,
  ReunificationTargetAction,
} from './dto';

type LookupKey = { version: number; secret: Buffer };
type LookupRef = { version: number; token: string };

type AuthIdentity = {
  subject: string;
  phone_e164: string;
};

@Injectable()
export class ReunificationService {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private assertEnabled() {
    if (process.env.FEATURE_REUNIFICATION !== 'true') {
      throw new ServiceUnavailableException('Reencuentro seguro está deshabilitado temporalmente');
    }
  }

  private decodeSecret(envName: string): Buffer {
    const raw = process.env[envName];
    if (!raw) throw new ServiceUnavailableException('Matching privado de reencuentro no configurado');
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64url');
    } catch {
      throw new ServiceUnavailableException('Secreto de matching de reencuentro inválido');
    }
    if (key.length < 32) throw new ServiceUnavailableException('Secreto de matching de reencuentro insuficiente');
    return key;
  }

  private lookupKeys(): LookupKey[] {
    const currentVersion = Number(process.env.REUNIFICATION_LOOKUP_KEY_VERSION ?? 1);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new ServiceUnavailableException('Versión de matching de reencuentro inválida');
    }
    const keys: LookupKey[] = [
      { version: currentVersion, secret: this.decodeSecret('REUNIFICATION_LOOKUP_SECRET_B64URL') },
    ];

    const previousSecret = process.env.REUNIFICATION_PREVIOUS_LOOKUP_SECRET_B64URL;
    const previousVersionRaw = process.env.REUNIFICATION_PREVIOUS_LOOKUP_KEY_VERSION;
    if (previousSecret || previousVersionRaw) {
      if (!previousSecret || !previousVersionRaw) {
        throw new ServiceUnavailableException('Rotación de matching de reencuentro incompleta');
      }
      const previousVersion = Number(previousVersionRaw);
      if (!Number.isInteger(previousVersion) || previousVersion < 1 || previousVersion === currentVersion) {
        throw new ServiceUnavailableException('Versión anterior de matching de reencuentro inválida');
      }
      keys.push({ version: previousVersion, secret: this.decodeSecret('REUNIFICATION_PREVIOUS_LOOKUP_SECRET_B64URL') });
    }
    return keys;
  }

  private lookupToken(phoneE164: string, key: LookupKey): string {
    return createHmac('sha256', key.secret).update(phoneE164, 'utf8').digest('base64url');
  }

  private lookupRefs(phoneE164: string): LookupRef[] {
    return this.lookupKeys().map((key) => ({ version: key.version, token: this.lookupToken(phoneE164, key) }));
  }

  private lookupPredicate(alias: string, refs: LookupRef[], startParameter: number) {
    const params: Array<string | number> = [];
    const parts = refs.map((ref, index) => {
      const base = startParameter + index * 2;
      params.push(ref.version, ref.token);
      return `(${alias}.lookup_key_version=$${base} AND ${alias}.target_lookup_token=$${base + 1})`;
    });
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  private async identity(subject: string): Promise<AuthIdentity> {
    const result = await this.db.query<AuthIdentity>(
      'SELECT subject,phone_e164 FROM auth_identities WHERE subject=$1',
      [subject],
    );
    if (!result.rowCount) throw new UnauthorizedException('Identidad ciudadana verificada requerida');
    return result.rows[0];
  }

  private async bumpRate(key: string, max: number, ttlSeconds: number) {
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, ttlSeconds);
    } catch {
      // Reencuentro es sensible a enumeración/acoso. Si la defensa antiabuso no está
      // disponible, este módulo falla cerrado sin afectar el canal SOS principal.
      throw new ServiceUnavailableException('Protección antiabuso de reencuentro temporalmente no disponible');
    }
    if (count > max) {
      throw new HttpException('Demasiadas solicitudes de reencuentro. Intenta más tarde.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async enforceCreateLimits(subject: string, targetToken: string) {
    await this.bumpRate(`reunification:create:15m:${subject}`, 8, 15 * 60);
    await this.bumpRate(`reunification:create:24h:${subject}`, 30, 24 * 60 * 60);

    const key = `reunification:targets:24h:${subject}`;
    try {
      await this.redis.sadd(key, targetToken);
      const ttl = await this.redis.ttl(key);
      if (ttl < 0) await this.redis.expire(key, 24 * 60 * 60);
      const unique = await this.redis.scard(key);
      if (unique > 20) {
        throw new HttpException('Límite de destinatarios alcanzado. Intenta más tarde.', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Protección antiabuso de reencuentro temporalmente no disponible');
    }
  }

  private cleanText(value: string | undefined, max: number): string | null {
    if (!value) return null;
    const cleaned = value.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    if (cleaned.length > max) throw new BadRequestException('Texto demasiado largo');
    if (/(?:https?:\/\/|www\.)/i.test(cleaned)) {
      throw new BadRequestException('Por seguridad, los mensajes de reencuentro no permiten enlaces');
    }
    return cleaned;
  }

  private retentionDays(): number {
    const configured = Number(process.env.REUNIFICATION_REQUEST_TTL_DAYS ?? 14);
    if (!Number.isFinite(configured)) return 14;
    return Math.max(1, Math.min(30, Math.floor(configured)));
  }

  private async audit(subject: string, action: string, entityId: string, metadata: Record<string, unknown> = {}) {
    try {
      await this.db.query(
        `INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
         VALUES($1,$2,'REUNIFICATION_REQUEST',$3,$4::jsonb)`,
        [subject, action, entityId, JSON.stringify(metadata)],
      );
    } catch {
      // La telemetría de auditoría no debe convertir una acción humanitaria válida en
      // un fallo de UX. Los accesos críticos siguen protegidos por autorización/DB.
    }
  }

  private async pruneExpired() {
    try {
      await this.db.query(`DELETE FROM reunification_requests WHERE expires_at < now() - interval '7 days'`);
    } catch {
      // Limpieza oportunista; producción debe además ejecutar el job de retención.
    }
  }

  async createRequest(subject: string, dto: CreateReunificationRequestDto) {
    this.assertEnabled();
    void this.pruneExpired();
    const seeker = await this.identity(subject);
    const targetPhone = normalizePhone(dto.targetPhone);
    const keys = this.lookupKeys();
    const currentKey = keys[0];
    const targetToken = this.lookupToken(targetPhone, currentKey);
    const targetRefs = keys.map((key) => ({ version: key.version, token: this.lookupToken(targetPhone, key) }));
    await this.enforceCreateLimits(subject, targetToken);

    const ownToken = this.lookupToken(seeker.phone_e164, currentKey);
    const selfSuppressed = ownToken === targetToken;
    const seekerDisplayName = this.cleanText(dto.seekerDisplayName, 80);
    const declaredRelationship = this.cleanText(dto.declaredRelationship, 40);
    const message = this.cleanText(dto.message, 280);
    const expiresAt = new Date(Date.now() + this.retentionDays() * 86_400_000);

    let result;
    if (selfSuppressed) {
      result = await this.db.query(
        `INSERT INTO reunification_requests(
          seeker_auth_subject,target_lookup_token,lookup_key_version,seeker_display_name,
          declared_relationship,message,share_seeker_phone,status,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'SELF_SUPPRESSED',$8)
         RETURNING public_id`,
        [subject, targetToken, currentKey.version, seekerDisplayName, declaredRelationship, message, dto.shareSeekerPhone, expiresAt],
      );
    } else {
      // Durante una rotación, una solicitud activa puede estar indexada con la clave
      // anterior. La migramos a la clave actual y conservamos el mismo public_id para
      // impedir duplicados y evitar cambios observables por el seeker.
      const predicate = this.lookupPredicate('r', targetRefs, 2);
      const existing = await this.db.query(
        `SELECT r.id,r.public_id
         FROM reunification_requests r
         WHERE r.seeker_auth_subject=$1
           AND r.status='ACTIVE'
           AND ${predicate.sql}
         ORDER BY r.created_at DESC
         LIMIT 1`,
        [subject, ...predicate.params],
      );

      if (existing.rowCount) {
        result = await this.db.query(
          `UPDATE reunification_requests
           SET target_lookup_token=$2,
               lookup_key_version=$3,
               seeker_display_name=$4,
               declared_relationship=$5,
               message=$6,
               share_seeker_phone=$7,
               expires_at=GREATEST(expires_at,$8)
           WHERE id=$1
           RETURNING public_id`,
          [
            existing.rows[0].id,
            targetToken,
            currentKey.version,
            seekerDisplayName,
            declaredRelationship,
            message,
            dto.shareSeekerPhone,
            expiresAt,
          ],
        );
      } else {
        result = await this.db.query(
          `INSERT INTO reunification_requests(
            seeker_auth_subject,target_lookup_token,lookup_key_version,seeker_display_name,
            declared_relationship,message,share_seeker_phone,status,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8)
           ON CONFLICT(seeker_auth_subject,lookup_key_version,target_lookup_token) WHERE status='ACTIVE'
           DO UPDATE SET
             seeker_display_name=excluded.seeker_display_name,
             declared_relationship=excluded.declared_relationship,
             message=excluded.message,
             share_seeker_phone=excluded.share_seeker_phone,
             expires_at=GREATEST(reunification_requests.expires_at,excluded.expires_at)
           RETURNING public_id`,
          [subject, targetToken, currentKey.version, seekerDisplayName, declaredRelationship, message, dto.shareSeekerPhone, expiresAt],
        );
      }
    }

    const requestId = result.rows[0].public_id as string;
    await this.audit(subject, 'REUNIFICATION_REQUEST_CREATED', requestId, {
      lookupKeyVersion: currentKey.version,
      expiresAt: expiresAt.toISOString(),
    });

    // No devolver estado de existencia, match, entrega, lectura, conexión ni ningún
    // dato derivado de la actividad de la persona buscada.
    return { status: 'REQUEST_ACCEPTED', requestId };
  }

  async inbox(subject: string) {
    this.assertEnabled();
    void this.pruneExpired();
    const target = await this.identity(subject);
    const refs = this.lookupRefs(target.phone_e164);
    const predicate = this.lookupPredicate('r', refs, 2);
    const result = await this.db.query(
      `SELECT r.public_id,r.seeker_display_name,r.declared_relationship,r.message,
              r.share_seeker_phone,r.created_at,r.expires_at
       FROM reunification_requests r
       WHERE r.status='ACTIVE'
         AND r.expires_at>now()
         AND r.seeker_auth_subject<>$1
         AND ${predicate.sql}
         AND NOT EXISTS (
           SELECT 1 FROM reunification_blocks b
           WHERE b.target_auth_subject=$1 AND b.seeker_auth_subject=r.seeker_auth_subject
         )
         AND NOT EXISTS (
           SELECT 1 FROM reunification_target_actions a
           WHERE a.request_id=r.id AND a.target_auth_subject=$1
             AND a.action IN ('IGNORE','BLOCK','REPORT_ABUSE')
         )
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [subject, ...predicate.params],
    );

    return result.rows.map((row: any) => ({
      id: row.public_id,
      seekerDisplayName: row.seeker_display_name ?? undefined,
      declaredRelationship: row.declared_relationship ?? undefined,
      relationshipVerified: false,
      message: row.message ?? undefined,
      contactAvailable: Boolean(row.share_seeker_phone),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  async inboxSummary(subject: string) {
    const items = await this.inbox(subject);
    return { count: items.length };
  }

  private async eligibleRequest(subject: string, publicId: string) {
    const target = await this.identity(subject);
    const refs = this.lookupRefs(target.phone_e164);
    const predicate = this.lookupPredicate('r', refs, 3);
    const result = await this.db.query(
      `SELECT r.*
       FROM reunification_requests r
       WHERE r.public_id=$1
         AND r.status='ACTIVE'
         AND r.expires_at>now()
         AND r.seeker_auth_subject<>$2
         AND ${predicate.sql}
         AND NOT EXISTS (
           SELECT 1 FROM reunification_blocks b
           WHERE b.target_auth_subject=$2 AND b.seeker_auth_subject=r.seeker_auth_subject
         )
       LIMIT 1`,
      [publicId, subject, ...predicate.params],
    );
    if (!result.rowCount) throw new NotFoundException('Mensaje de reencuentro no disponible');
    return result.rows[0];
  }

  async targetAction(subject: string, publicId: string, action: ReunificationTargetAction) {
    this.assertEnabled();
    const request = await this.eligibleRequest(subject, publicId);

    await this.db.query(
      `INSERT INTO reunification_target_actions(request_id,target_auth_subject,action)
       VALUES($1,$2,$3) ON CONFLICT(request_id,target_auth_subject,action) DO NOTHING`,
      [request.id, subject, action],
    );

    if (action === ReunificationTargetAction.REVEAL_CONTACT) {
      await this.audit(subject, 'REUNIFICATION_CONTACT_REVEALED', publicId);
      if (!request.share_seeker_phone) return { status: 'CONTACT_NOT_SHARED' };
      const seeker = await this.db.query<{ phone_e164: string }>(
        'SELECT phone_e164 FROM auth_identities WHERE subject=$1',
        [request.seeker_auth_subject],
      );
      if (!seeker.rowCount) return { status: 'CONTACT_NOT_AVAILABLE' };
      return {
        status: 'CONTACT_AVAILABLE',
        contactPhone: seeker.rows[0].phone_e164,
        warning: 'Si llamas o escribes desde tu número personal, la otra persona podría verlo. Tú decides si quieres hacerlo.',
      };
    }

    if (action === ReunificationTargetAction.IGNORE) {
      await this.audit(subject, 'REUNIFICATION_REQUEST_IGNORED', publicId);
      return { status: 'HIDDEN' };
    }

    await this.db.query(
      `INSERT INTO reunification_blocks(target_auth_subject,seeker_auth_subject)
       VALUES($1,$2) ON CONFLICT(target_auth_subject,seeker_auth_subject) DO NOTHING`,
      [subject, request.seeker_auth_subject],
    );

    // BLOCK y REPORT_ABUSE viven únicamente en el estado privado del target. Nunca
    // mutan reunification_requests.status: hacerlo permitiría al seeker inferir la
    // acción al re-enviar el mismo teléfono y observar cambios de lifecycle/public_id.
    if (action === ReunificationTargetAction.BLOCK) {
      await this.audit(subject, 'REUNIFICATION_SEEKER_BLOCKED', publicId);
      return { status: 'BLOCKED' };
    }

    await this.audit(subject, 'REUNIFICATION_ABUSE_REPORTED', publicId);
    return { status: 'REPORTED' };
  }

  async withdraw(subject: string, publicId: string) {
    const result = await this.db.query(
      `UPDATE reunification_requests
       SET status='WITHDRAWN',withdrawn_at=now()
       WHERE public_id=$1 AND seeker_auth_subject=$2 AND status='ACTIVE'
       RETURNING public_id`,
      [publicId, subject],
    );
    if (result.rowCount) await this.audit(subject, 'REUNIFICATION_REQUEST_WITHDRAWN', publicId);

    // Respuesta deliberadamente genérica: no revela si la persona objetivo hizo match,
    // leyó, bloqueó, reportó o contactó.
    return { status: 'WITHDRAW_REQUESTED' };
  }
}
