import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class PetsCatalogService {
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

  private async approvedPhoto(caseId: string) {
    const media = await this.db.query(`SELECT object_key FROM pet_case_media
      WHERE case_id=$1
        AND kind='PUBLIC_PHOTO'
        AND upload_status='READY'
        AND moderation_status='APPROVED'
      ORDER BY moderated_at DESC NULLS LAST,completed_at DESC NULLS LAST
      LIMIT 1`, [caseId]);
    if (!media.rowCount) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket(),
      Key: media.rows[0].object_key,
      ResponseCacheControl: 'private, max-age=300',
    }), { expiresIn: 600 });
  }

  async list(kind?: string) {
    this.assertEnabled();
    if (kind && !['LOST', 'FOUND'].includes(kind)) throw new BadRequestException('Tipo de catálogo inválido');
    const r = await this.db.query(`SELECT id,public_id,kind,public_name
      FROM pet_cases
      WHERE status IN ('OPEN','MATCH_REVIEW') AND ($1::text IS NULL OR kind=$1)
      ORDER BY created_at DESC LIMIT 500`, [kind ?? null]);
    return Promise.all(r.rows.map(async row => ({
      id: row.public_id,
      kind: row.kind,
      name: row.public_name,
      photoUrl: await this.approvedPhoto(row.id),
    })));
  }

  async one(publicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT id,public_id,kind,public_name
      FROM pet_cases WHERE public_id=$1 AND status IN ('OPEN','MATCH_REVIEW')`, [publicId]);
    if (!r.rowCount) throw new NotFoundException('Caso no disponible');
    return {
      id: r.rows[0].public_id,
      kind: r.rows[0].kind,
      name: r.rows[0].public_name,
      photoUrl: await this.approvedPhoto(r.rows[0].id),
    };
  }
}
