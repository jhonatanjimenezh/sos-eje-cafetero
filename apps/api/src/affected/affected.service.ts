import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PG_POOL } from '../database/database.module';
import { CompleteEvidenceDto, PresignEvidenceDto, UpsertAffectedProfileDto, VerifyAffectedDto } from './dto';

@Injectable()
export class AffectedService {
  private readonly s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private documentHash(type: string, number: string) {
    const secret = process.env.IDENTITY_HASH_SECRET;
    if (!secret) throw new ServiceUnavailableException('IDENTITY_HASH_SECRET no configurado');
    const normalized = `${type}:${String(number).toUpperCase().replace(/[^A-Z0-9]/g,'')}`;
    return createHmac('sha256', secret).update(normalized).digest('hex');
  }

  private async assertOwner(profileId: string, subject: string) {
    const r = await this.db.query('SELECT * FROM affected_profiles WHERE id=$1 AND auth_subject=$2', [profileId, subject]);
    if (!r.rowCount) throw new ForbiddenException('Perfil no disponible para esta sesión');
    return r.rows[0];
  }

  async upsert(subject: string, dto: UpsertAffectedProfileDto) {
    const identity = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [subject]);
    if (!identity.rowCount) throw new ForbiddenException('Identidad OTP no registrada');
    const hash = this.documentHash(dto.documentType, dto.documentNumber);
    const normalizedDoc = dto.documentNumber.replace(/\D/g,'') || dto.documentNumber.replace(/\s/g,'');
    const last4 = normalizedDoc.slice(-4).padStart(4, '*');
    try {
      const r = await this.db.query(`INSERT INTO affected_profiles(
        auth_subject,full_name,document_type,document_number_hash,document_last4,address,location,city,neighborhood,
        household_size,notes,consent_sensitive_data_at,consent_version)
        VALUES($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9,$10,$11,$12,now(),$13)
        ON CONFLICT(auth_subject) DO UPDATE SET full_name=excluded.full_name,document_type=excluded.document_type,
          document_number_hash=excluded.document_number_hash,document_last4=excluded.document_last4,address=excluded.address,
          location=excluded.location,city=excluded.city,neighborhood=excluded.neighborhood,household_size=excluded.household_size,
          notes=excluded.notes,consent_sensitive_data_at=now(),consent_version=excluded.consent_version,updated_at=now()
        RETURNING id,public_id,full_name,document_type,document_last4,address,city,neighborhood,household_size,verification_status,created_at`,
        [subject,dto.fullName.trim(),dto.documentType,hash,last4,dto.address.trim(),dto.lat,dto.lng,dto.city??'Manizales',dto.neighborhood??null,dto.householdSize,dto.notes??null,dto.consentVersion]);
      return r.rows[0];
    } catch (e: any) {
      if (e?.code === '23505' && String(e?.constraint).includes('document_number_hash')) {
        throw new ConflictException('Este documento ya tiene un registro de damnificado. Solicite revisión si cree que es un error.');
      }
      throw e;
    }
  }

  async me(subject: string) {
    const r = await this.db.query(`SELECT id,public_id,full_name,document_type,document_last4,address,city,neighborhood,household_size,
      verification_status,liveness_status,verified_at,created_at,updated_at FROM affected_profiles WHERE auth_subject=$1`, [subject]);
    return r.rows[0] ?? null;
  }

  async createLivenessChallenge(profileId: string, subject: string) {
    await this.assertOwner(profileId, subject);
    const code = randomInt(100, 999);
    const direction = ['izquierda','derecha'][randomInt(0,2)];
    const text = `Mire al frente, gire lentamente el rostro hacia la ${direction}, vuelva al centro y diga en voz alta el código ${code}.`;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`INSERT INTO verification_challenges(affected_profile_id,challenge_text,expires_at)
        VALUES($1,$2,now()+interval '10 minutes') RETURNING id,challenge_text,expires_at`, [profileId,text]);
      await client.query(`UPDATE affected_profiles SET liveness_challenge_id=$2,liveness_status='CHALLENGE_ISSUED',updated_at=now() WHERE id=$1`, [profileId,r.rows[0].id]);
      await client.query('COMMIT');
      return r.rows[0];
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async presignEvidence(profileId: string, subject: string, dto: PresignEvidenceDto) {
    await this.assertOwner(profileId, subject);
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');
    const allowed = new Set(['image/jpeg','image/png','image/webp','video/webm','video/mp4','video/quicktime']);
    if (!allowed.has(dto.contentType)) throw new BadRequestException('Formato de evidencia no permitido');
    const ext = dto.contentType.includes('png')?'png':dto.contentType.includes('webp')?'webp':dto.contentType.includes('mp4')?'mp4':dto.contentType.includes('quicktime')?'mov':dto.contentType.includes('webm')?'webm':'jpg';
    const key = `private/affected/${profileId}/${dto.kind}/${randomUUID()}.${ext}`;
    const asset = await this.db.query(`INSERT INTO evidence_assets(affected_profile_id,kind,object_key,content_type)
      VALUES($1,$2,$3,$4) RETURNING id,kind,object_key`, [profileId,dto.kind,key,dto.contentType]);
    const uploadUrl = await getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: bucket, Key: key, ContentType: dto.contentType,
    }), { expiresIn: 600 });
    return { assetId: asset.rows[0].id, uploadUrl, expiresIn: 600 };
  }

  async completeEvidence(assetId: string, subject: string, dto: CompleteEvidenceDto) {
    const r = await this.db.query(`SELECT e.*,p.auth_subject,p.liveness_challenge_id FROM evidence_assets e
      JOIN affected_profiles p ON p.id=e.affected_profile_id WHERE e.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].auth_subject !== subject) throw new ForbiddenException();
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: r.rows[0].object_key }));
    if (!head.ContentLength || Number(head.ContentLength) !== dto.sizeBytes) throw new BadRequestException('El archivo cargado no coincide con el tamaño informado');
    await this.db.query(`UPDATE evidence_assets SET sha256=$2,size_bytes=$3,upload_status='COMPLETED',completed_at=now() WHERE id=$1`, [assetId,dto.sha256.toLowerCase(),dto.sizeBytes]);
    if (r.rows[0].kind === 'LIVENESS_VIDEO') {
      await this.db.query(`UPDATE affected_profiles SET liveness_status='CAPTURED',updated_at=now() WHERE id=$1`, [r.rows[0].affected_profile_id]);
      if (r.rows[0].liveness_challenge_id) await this.db.query('UPDATE verification_challenges SET completed_at=now() WHERE id=$1', [r.rows[0].liveness_challenge_id]);
    }
    return { completed: true, assetId };
  }

  async submit(profileId: string, subject: string) {
    const profile = await this.assertOwner(profileId, subject);
    if (profile.verification_status === 'VERIFIED') return { status: 'VERIFIED' };
    const r = await this.db.query(`SELECT kind,count(*)::int count FROM evidence_assets
      WHERE affected_profile_id=$1 AND upload_status='COMPLETED' GROUP BY kind`, [profileId]);
    const kinds = new Set(r.rows.map(x => x.kind));
    for (const required of ['ID_FRONT','ID_BACK','LIVENESS_VIDEO']) if (!kinds.has(required)) throw new BadRequestException(`Falta evidencia requerida: ${required}`);
    await this.db.query(`UPDATE affected_profiles SET verification_status='PENDING_OFFICIAL_VERIFICATION',updated_at=now() WHERE id=$1`, [profileId]);
    return { status: 'PENDING_OFFICIAL_VERIFICATION', publicId: profile.public_id };
  }

  async verify(profileId: string, official: any, dto: VerifyAffectedDto) {
    if (!['VERIFIER','COORDINATOR','ADMIN'].includes(official.role)) throw new ForbiddenException('Rol insuficiente para verificar damnificados');
    const profile = await this.db.query('SELECT id FROM affected_profiles WHERE id=$1', [profileId]);
    if (!profile.rowCount) throw new NotFoundException();
    const status = dto.decision === 'APPROVED' ? 'VERIFIED' : dto.decision === 'REJECTED' ? 'REJECTED' : 'NEEDS_INFO';
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO beneficiary_verifications(affected_profile_id,official_id,decision,method,notes)
        VALUES($1,$2,$3,$4,$5)`, [profileId,official.id,dto.decision,dto.method??'FIELD_OR_DESK_REVIEW',dto.notes??null]);
      await client.query(`UPDATE affected_profiles SET verification_status=$2,verified_at=CASE WHEN $2='VERIFIED' THEN now() ELSE verified_at END,updated_at=now() WHERE id=$1`, [profileId,status]);
      await client.query(`INSERT INTO audit_events(actor_subject,actor_official_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'BENEFICIARY_VERIFICATION','affected_profile',$3,$4::jsonb)`, [official.auth_subject??null,official.id,profileId,JSON.stringify({decision:dto.decision})]);
      await client.query('COMMIT');
      return { status };
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async commandList() {
    const r = await this.db.query(`SELECT p.id,p.public_id,p.full_name,p.document_type,p.document_last4,p.address,p.city,p.neighborhood,
      p.household_size,p.verification_status,p.liveness_status,p.verified_at,
      ST_Y(p.location::geometry) lat,ST_X(p.location::geometry) lng,i.phone_e164,
      (SELECT count(*)::int FROM assistance_needs n WHERE n.affected_profile_id=p.id AND n.status IN ('OPEN','MATCHED','IN_PROGRESS')) open_needs
      FROM affected_profiles p JOIN auth_identities i ON i.subject=p.auth_subject ORDER BY p.created_at DESC LIMIT 5000`);
    return r.rows;
  }
}
