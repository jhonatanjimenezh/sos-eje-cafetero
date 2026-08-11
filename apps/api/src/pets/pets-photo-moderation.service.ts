import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class PetsPhotoModerationService {
  private readonly s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private assertEnabled() {
    if (process.env.FEATURE_PET_SAFETY !== 'true') {
      throw new ServiceUnavailableException('Mascotas seguras está deshabilitado temporalmente');
    }
  }

  private bucket() {
    const bucket = process.env.PET_MEDIA_BUCKET || process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('Bucket privado de mascotas no configurado');
    return bucket;
  }

  async queue() {
    this.assertEnabled();
    const r = await this.db.query(`SELECT m.id asset_id,c.public_id case_id,c.kind,c.public_name,m.content_type,m.created_at
      FROM pet_case_media m
      JOIN pet_cases c ON c.id=m.case_id
      WHERE m.kind='PUBLIC_PHOTO'
        AND m.upload_status='READY'
        AND m.moderation_status='PENDING'
      ORDER BY m.created_at ASC
      LIMIT 200`);
    return r.rows;
  }

  async view(actorSubject: string, officialId: string, assetId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT m.id,m.object_key,m.content_type,m.moderation_status,m.upload_status,c.public_id case_id
      FROM pet_case_media m JOIN pet_cases c ON c.id=m.case_id
      WHERE m.id=$1 AND m.kind='PUBLIC_PHOTO'`, [assetId]);
    if (!r.rowCount) throw new NotFoundException('Foto de catálogo no disponible');
    const row = r.rows[0];
    if (row.upload_status !== 'READY') throw new BadRequestException('La fotografía todavía no superó validación técnica');
    if (row.moderation_status === 'REJECTED') throw new NotFoundException('Foto de catálogo no disponible');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const official = await client.query(`SELECT 1 FROM official_profiles WHERE id=$1 AND auth_subject=$2 AND status='ACTIVE'`, [officialId, actorSubject]);
      if (!official.rowCount) throw new ForbiddenException('Cuenta oficial no autorizada');
      await client.query(`INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
        VALUES($1,'PET_CATALOG_MODERATOR_VIEWED_PHOTO','PET_CASE_MEDIA',$2,$3::jsonb)`, [
        actorSubject, row.id, JSON.stringify({ casePublicId: row.case_id }),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }

    const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(), Key: row.object_key }), { expiresIn: 120 });
    return {
      assetId: row.id,
      caseId: row.case_id,
      contentType: row.content_type,
      url,
      expiresIn: 120,
      checklist: [
        'Debe ser una fotografía del animal, no un afiche/captura con datos personales.',
        'Rechazar si se ve teléfono, dirección, QR, documento, placa de vehículo u otro dato identificable innecesario.',
        'Rechazar si la imagen pone en riesgo a una persona o revela un domicilio/ubicación precisa.',
      ],
    };
  }

  async decide(
    actorSubject: string,
    officialId: string,
    assetId: string,
    decision: 'APPROVE' | 'REJECT',
    reason?: string,
  ) {
    this.assertEnabled();
    const trimmedReason = reason?.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    if (decision === 'REJECT' && !trimmedReason) throw new BadRequestException('Motivo requerido para rechazo');

    const client = await this.db.connect();
    let objectKey: string | null = null;
    let alreadyDecided: string | null = null;
    try {
      await client.query('BEGIN');
      const official = await client.query(`SELECT 1 FROM official_profiles WHERE id=$1 AND auth_subject=$2 AND status='ACTIVE'`, [officialId, actorSubject]);
      if (!official.rowCount) throw new ForbiddenException('Cuenta oficial no autorizada');

      const locked = await client.query(`SELECT id,object_key,upload_status,moderation_status
        FROM pet_case_media WHERE id=$1 AND kind='PUBLIC_PHOTO' FOR UPDATE`, [assetId]);
      if (!locked.rowCount) throw new NotFoundException('Foto no disponible');
      const row = locked.rows[0];
      if (row.upload_status !== 'READY') throw new BadRequestException('La fotografía no está técnicamente lista');
      if (row.moderation_status !== 'PENDING') {
        alreadyDecided = row.moderation_status;
        await client.query('COMMIT');
      } else {
        const nextStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        await client.query(`UPDATE pet_case_media SET moderation_status=$2,moderated_by_official_id=$3,
          moderated_at=now(),moderation_reason=$4 WHERE id=$1`, [assetId, nextStatus, officialId, trimmedReason]);
        await client.query(`INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
          VALUES($1,$2,'PET_CASE_MEDIA',$3,$4::jsonb)`, [
          actorSubject,
          decision === 'APPROVE' ? 'PET_CATALOG_PHOTO_APPROVED' : 'PET_CATALOG_PHOTO_REJECTED_BY_MODERATOR',
          assetId,
          JSON.stringify({ reasonProvided: Boolean(trimmedReason) }),
        ]);
        objectKey = row.object_key;
        await client.query('COMMIT');
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }

    if (alreadyDecided) return { status: alreadyDecided };
    if (decision === 'REJECT' && objectKey) {
      // La DB deja de servir la imagen antes de intentar borrarla. Si S3 falla, el objeto
      // permanece privado e inaccesible desde el catálogo y puede eliminarse por lifecycle.
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey })).catch(() => undefined);
    }
    return { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  }
}
