import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PG_POOL } from '../database/database.module';
import {
  CompleteEvidenceDto,
  EvidenceAccessDto,
  IdentityReviewRequestDto,
  LivenessConsentDto,
  PresignEvidenceDto,
  ResolveIdentityReviewDto,
  UpsertAffectedProfileDto,
  VerifyAffectedDto,
} from './dto';
import { RekognitionLivenessProvider } from './rekognition-liveness.provider';

const EVIDENCE_LIMITS: Record<string, number> = {
  ID_FRONT: 10_000_000,
  ID_BACK: 10_000_000,
  DAMAGE_PHOTO: 15_000_000,
  LIVENESS_VIDEO: 25_000_000,
};

@Injectable()
export class AffectedService {
  private readonly s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });

  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly rekognition: RekognitionLivenessProvider,
  ) {}

  private flag(name: string, defaultValue = false) {
    const value = process.env[name];
    return value == null ? defaultValue : value.toLowerCase() === 'true';
  }

  private livenessProvider() {
    return (process.env.LIVENESS_PROVIDER ?? 'MANUAL').toUpperCase();
  }

  private malwareMode() {
    return (process.env.EVIDENCE_MALWARE_SCAN_MODE ?? 'DISABLED').toUpperCase();
  }

  private documentHash(type: string, number: string) {
    const secret = process.env.IDENTITY_HASH_SECRET;
    if (!secret) throw new ServiceUnavailableException('IDENTITY_HASH_SECRET no configurado');
    const normalized = `${type}:${String(number).toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
    return createHmac('sha256', secret).update(normalized).digest('hex');
  }

  private async audit(client: Pool | PoolClient, input: {
    actorSubject?: string | null;
    officialId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    await client.query(`INSERT INTO audit_events(actor_subject,actor_official_id,action,entity_type,entity_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      input.actorSubject ?? null,
      input.officialId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]);
  }

  private assertVerifier(official: any) {
    if (!['VERIFIER', 'COORDINATOR', 'ADMIN'].includes(official.role)) {
      throw new ForbiddenException('Rol insuficiente para revisar identidad o evidencia sensible');
    }
  }

  private async assertOwner(profileId: string, subject: string) {
    const r = await this.db.query('SELECT * FROM affected_profiles WHERE id=$1 AND auth_subject=$2', [profileId, subject]);
    if (!r.rowCount) throw new ForbiddenException('Perfil no disponible para esta sesión');
    return r.rows[0];
  }

  private evidenceMax(kind: string) {
    return EVIDENCE_LIMITS[kind] ?? 0;
  }

  private detectContentType(bytes: Uint8Array): string | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) return 'image/png';
    const ascii = (start: number, end: number) => Buffer.from(bytes.slice(start, end)).toString('ascii');
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (bytes.length >= 8 && ascii(4, 8) === 'ftyp') return 'video/mp4';
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
    return null;
  }

  private contentTypeCompatible(expected: string, detected: string) {
    if (expected === detected) return true;
    return expected === 'video/quicktime' && detected === 'video/mp4';
  }

  private async securityScanStatus(bucket: string, key: string) {
    if (!['GUARDDUTY', 'TAGGED_S3'].includes(this.malwareMode())) return 'NOT_CONFIGURED';
    const tags = await this.s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
    return tags.TagSet?.find(tag => tag.Key === 'GuardDutyMalwareScanStatus')?.Value ?? 'PENDING';
  }

  async upsert(subject: string, dto: UpsertAffectedProfileDto) {
    const identity = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [subject]);
    if (!identity.rowCount) throw new ForbiddenException('Identidad OTP no registrada');

    const existing = await this.db.query('SELECT id,verification_status FROM affected_profiles WHERE auth_subject=$1', [subject]);
    if (existing.rowCount && ['VERIFIED', 'PENDING_OFFICIAL_VERIFICATION', 'REJECTED'].includes(existing.rows[0].verification_status)) {
      throw new ForbiddenException('Este expediente no admite cambios directos en su estado actual; use corrección o apelación');
    }

    const hash = this.documentHash(dto.documentType, dto.documentNumber);
    const normalizedDoc = dto.documentNumber.replace(/\D/g, '') || dto.documentNumber.replace(/\s/g, '');
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
        [subject, dto.fullName.trim(), dto.documentType, hash, last4, dto.address.trim(), dto.lat, dto.lng, dto.city ?? 'Manizales', dto.neighborhood ?? null, dto.householdSize, dto.notes ?? null, dto.consentVersion]);
      await this.audit(this.db, {
        actorSubject: subject,
        action: existing.rowCount ? 'AFFECTED_PROFILE_CORRECTED' : 'AFFECTED_PROFILE_CREATED',
        entityType: 'affected_profile',
        entityId: r.rows[0].id,
        metadata: { consentVersion: dto.consentVersion },
      });
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
      verification_status,liveness_provider,liveness_status,liveness_provider_status,verified_at,created_at,updated_at
      FROM affected_profiles WHERE auth_subject=$1`, [subject]);
    if (!r.rowCount) return null;
    const review = await this.db.query(`SELECT id,kind,status,created_at FROM identity_review_requests
      WHERE affected_profile_id=$1 AND status='OPEN' ORDER BY created_at DESC LIMIT 1`, [r.rows[0].id]);
    return { ...r.rows[0], open_review_request: review.rows[0] ?? null };
  }

  async createLivenessChallenge(profileId: string, subject: string) {
    if (!this.flag('FEATURE_LIVENESS')) throw new ServiceUnavailableException('Liveness está deshabilitado por feature flag');
    if (this.livenessProvider() !== 'MANUAL') throw new BadRequestException('El despliegue usa un proveedor de liveness especializado');
    await this.assertOwner(profileId, subject);
    const code = randomInt(100, 999);
    const direction = ['izquierda', 'derecha'][randomInt(0, 2)];
    const text = `Mire al frente, gire lentamente el rostro hacia la ${direction}, vuelva al centro y diga en voz alta el código ${code}.`;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`INSERT INTO verification_challenges(affected_profile_id,challenge_text,expires_at)
        VALUES($1,$2,now()+interval '10 minutes') RETURNING id,challenge_text,expires_at`, [profileId, text]);
      await client.query(`UPDATE affected_profiles SET liveness_provider='MANUAL',liveness_challenge_id=$2,liveness_status='CHALLENGE_ISSUED',updated_at=now() WHERE id=$1`, [profileId, r.rows[0].id]);
      await this.audit(client, { actorSubject: subject, action: 'MANUAL_LIVENESS_CHALLENGE_CREATED', entityType: 'affected_profile', entityId: profileId });
      await client.query('COMMIT');
      return r.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async createProviderLivenessSession(profileId: string, subject: string, dto: LivenessConsentDto) {
    if (!this.flag('FEATURE_LIVENESS')) throw new ServiceUnavailableException('Liveness está deshabilitado por feature flag');
    if (this.livenessProvider() !== 'REKOGNITION') throw new BadRequestException('Proveedor de liveness especializado no configurado');
    await this.assertOwner(profileId, subject);

    const maxAttempts = Number(process.env.LIVENESS_MAX_ATTEMPTS_PER_24H ?? 3);
    const attempts = await this.db.query(`SELECT count(*)::int count FROM liveness_sessions
      WHERE affected_profile_id=$1 AND created_at > now()-interval '24 hours'`, [profileId]);
    if (attempts.rows[0].count >= maxAttempts) {
      throw new HttpException('Se alcanzó el máximo de intentos de liveness; requiere revisión oficial', HttpStatus.TOO_MANY_REQUESTS);
    }

    const requestToken = randomUUID();
    const created = await this.rekognition.createSession({ profileId, requestToken });
    const attemptNumber = attempts.rows[0].count + 1;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO liveness_sessions(
        affected_profile_id,provider,provider_session_id,status,attempt_number,consent_version,expires_at)
        VALUES($1,$2,$3,'CREATED',$4,$5,$6)`, [profileId, created.provider, created.sessionId, attemptNumber, dto.consentVersion, created.expiresAt]);
      await client.query(`UPDATE affected_profiles SET liveness_provider=$2,liveness_provider_session_id=$3,
        liveness_provider_status='CREATED',liveness_status='SESSION_CREATED',liveness_attempts=liveness_attempts+1,
        liveness_last_attempt_at=now(),liveness_consent_at=now(),liveness_consent_version=$4,updated_at=now() WHERE id=$1`,
        [profileId, created.provider, created.sessionId, dto.consentVersion]);
      await this.audit(client, {
        actorSubject: subject,
        action: 'LIVENESS_SESSION_CREATED',
        entityType: 'affected_profile',
        entityId: profileId,
        metadata: { provider: created.provider, attemptNumber, consentVersion: dto.consentVersion },
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return created;
  }

  async completeProviderLivenessSession(profileId: string, subject: string) {
    const profile = await this.assertOwner(profileId, subject);
    if (profile.liveness_provider !== 'REKOGNITION' || !profile.liveness_provider_session_id) {
      throw new BadRequestException('No existe una sesión Rekognition activa para este perfil');
    }
    const session = await this.db.query(`SELECT * FROM liveness_sessions
      WHERE affected_profile_id=$1 AND provider_session_id=$2 ORDER BY created_at DESC LIMIT 1`, [profileId, profile.liveness_provider_session_id]);
    if (!session.rowCount) throw new NotFoundException('Sesión de liveness no encontrada');
    if (new Date(session.rows[0].expires_at).getTime() < Date.now()) throw new BadRequestException('La sesión de liveness expiró; genere un nuevo intento');

    const result = await this.rekognition.getResults(profile.liveness_provider_session_id);
    const status = result.status === 'SUCCEEDED' ? 'PROVIDER_RESULT_AVAILABLE' : 'PROVIDER_FAILED';
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE liveness_sessions SET status=$2,confidence=$3,provider_metadata=$4::jsonb,
        completed_at=CASE WHEN $2='SUCCEEDED' THEN now() ELSE completed_at END WHERE id=$1`, [
        session.rows[0].id,
        result.status,
        result.confidence,
        JSON.stringify({ referenceImage: result.referenceImage, auditImages: result.auditImages }),
      ]);
      await client.query(`UPDATE affected_profiles SET liveness_provider_status=$2,liveness_status=$3,
        liveness_confidence=$4,liveness_completed_at=CASE WHEN $2='SUCCEEDED' THEN now() ELSE liveness_completed_at END,
        updated_at=now() WHERE id=$1`, [profileId, result.status, status, result.confidence]);
      await this.audit(client, {
        actorSubject: subject,
        action: 'LIVENESS_PROVIDER_RESULT_RECEIVED',
        entityType: 'affected_profile',
        entityId: profileId,
        metadata: { provider: result.provider, providerStatus: result.status, confidenceRecorded: result.confidence != null },
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return {
      status: result.status,
      livenessStatus: status,
      message: 'La señal de liveness fue registrada. La decisión final sigue siendo responsabilidad de un funcionario autorizado.',
    };
  }

  async presignEvidence(profileId: string, subject: string, dto: PresignEvidenceDto) {
    await this.assertOwner(profileId, subject);
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/webm', 'video/mp4', 'video/quicktime']);
    if (!allowed.has(dto.contentType)) throw new BadRequestException('Formato de evidencia no permitido');
    const max = this.evidenceMax(dto.kind);
    if (!max || dto.sizeBytes > max) throw new BadRequestException(`La evidencia ${dto.kind} excede el tamaño permitido`);

    const ext = dto.contentType.includes('png') ? 'png'
      : dto.contentType.includes('webp') ? 'webp'
        : dto.contentType.includes('mp4') ? 'mp4'
          : dto.contentType.includes('quicktime') ? 'mov'
            : dto.contentType.includes('webm') ? 'webm' : 'jpg';
    const key = `private/affected/${profileId}/${dto.kind}/${randomUUID()}.${ext}`;
    const retentionDays = Number(process.env.EVIDENCE_RETENTION_DAYS ?? 90);
    const checksumBase64 = Buffer.from(dto.sha256.toLowerCase(), 'hex').toString('base64');
    const asset = await this.db.query(`INSERT INTO evidence_assets(
      affected_profile_id,kind,object_key,content_type,declared_sha256,declared_size_bytes,retention_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+($7::text || ' days')::interval) RETURNING id,kind,object_key`,
      [profileId, dto.kind, key, dto.contentType, dto.sha256.toLowerCase(), dto.sizeBytes, String(retentionDays)]);
    const uploadUrl = await getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: dto.contentType,
      ChecksumSHA256: checksumBase64,
    }), { expiresIn: 600 });
    await this.audit(this.db, {
      actorSubject: subject,
      action: 'EVIDENCE_UPLOAD_URL_ISSUED',
      entityType: 'evidence_asset',
      entityId: asset.rows[0].id,
      metadata: { kind: dto.kind, sizeBytes: dto.sizeBytes },
    });
    return {
      assetId: asset.rows[0].id,
      uploadUrl,
      expiresIn: 600,
      uploadHeaders: {
        'Content-Type': dto.contentType,
        'x-amz-checksum-sha256': checksumBase64,
      },
    };
  }

  async completeEvidence(assetId: string, subject: string, dto: CompleteEvidenceDto) {
    const r = await this.db.query(`SELECT e.*,p.auth_subject,p.liveness_challenge_id FROM evidence_assets e
      JOIN affected_profiles p ON p.id=e.affected_profile_id WHERE e.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].auth_subject !== subject) throw new ForbiddenException();
    const asset = r.rows[0];
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');

    const reject = async (reason: string): Promise<never> => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key }));
      await this.db.query(`UPDATE evidence_assets SET upload_status='REJECTED',rejected_reason=$2 WHERE id=$1`, [assetId, reason]);
      await this.audit(this.db, { actorSubject: subject, action: 'EVIDENCE_REJECTED', entityType: 'evidence_asset', entityId: assetId, metadata: { reason } });
      throw new BadRequestException(reason);
    };

    if (dto.sha256.toLowerCase() !== asset.declared_sha256 || dto.sizeBytes !== Number(asset.declared_size_bytes)) {
      return reject('La evidencia no coincide con la declaración firmada antes de la carga');
    }

    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.object_key, ChecksumMode: 'ENABLED' }));
    if (!head.ContentLength || Number(head.ContentLength) !== dto.sizeBytes) return reject('El tamaño real del archivo no coincide');
    if (head.ContentType !== asset.content_type) return reject('El MIME almacenado no coincide con el declarado');
    const expectedChecksum = Buffer.from(dto.sha256.toLowerCase(), 'hex').toString('base64');
    if (head.ChecksumSHA256 && head.ChecksumSHA256 !== expectedChecksum) return reject('El checksum S3 no coincide con el archivo declarado');

    const sample = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: asset.object_key, Range: 'bytes=0-31' }));
    const bytes = await sample.Body?.transformToByteArray();
    const detected = bytes ? this.detectContentType(bytes) : null;
    if (!detected || !this.contentTypeCompatible(asset.content_type, detected)) return reject('El contenido binario no corresponde al tipo de archivo permitido');

    const scanStatus = await this.securityScanStatus(bucket, asset.object_key);
    await this.db.query(`UPDATE evidence_assets SET sha256=$2,size_bytes=$3,upload_status='COMPLETED',content_validated_at=now(),
      malware_scan_status=$4,malware_scanned_at=CASE WHEN $4 NOT IN ('PENDING','NOT_CONFIGURED') THEN now() ELSE malware_scanned_at END,
      completed_at=now() WHERE id=$1`, [assetId, dto.sha256.toLowerCase(), dto.sizeBytes, scanStatus]);
    if (asset.kind === 'LIVENESS_VIDEO') {
      await this.db.query(`UPDATE affected_profiles SET liveness_status='CAPTURED',updated_at=now() WHERE id=$1`, [asset.affected_profile_id]);
      if (asset.liveness_challenge_id) await this.db.query('UPDATE verification_challenges SET completed_at=now() WHERE id=$1', [asset.liveness_challenge_id]);
    }
    await this.audit(this.db, {
      actorSubject: subject,
      action: 'EVIDENCE_CONTENT_VALIDATED',
      entityType: 'evidence_asset',
      entityId: assetId,
      metadata: { detectedContentType: detected, malwareScanStatus: scanStatus },
    });
    return { completed: true, assetId, malwareScanStatus: scanStatus };
  }

  async refreshEvidenceSecurity(assetId: string, subject: string) {
    const r = await this.db.query(`SELECT e.*,p.auth_subject FROM evidence_assets e
      JOIN affected_profiles p ON p.id=e.affected_profile_id WHERE e.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].auth_subject !== subject) throw new ForbiddenException();
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');
    const status = await this.securityScanStatus(bucket, r.rows[0].object_key);
    await this.db.query(`UPDATE evidence_assets SET malware_scan_status=$2,
      malware_scanned_at=CASE WHEN $2 NOT IN ('PENDING','NOT_CONFIGURED') THEN now() ELSE malware_scanned_at END WHERE id=$1`, [assetId, status]);
    if (status === 'THREATS_FOUND') {
      await this.audit(this.db, { actorSubject: subject, action: 'MALWARE_DETECTED', entityType: 'evidence_asset', entityId: assetId });
    }
    return { assetId, malwareScanStatus: status };
  }

  async submit(profileId: string, subject: string) {
    const profile = await this.assertOwner(profileId, subject);
    if (profile.verification_status === 'VERIFIED') return { status: 'VERIFIED' };
    if (!['DRAFT', 'NEEDS_INFO'].includes(profile.verification_status)) throw new BadRequestException('El expediente no está listo para un nuevo envío');

    const scanMode = this.malwareMode();
    const r = await this.db.query(`SELECT kind,upload_status,content_validated_at,malware_scan_status FROM evidence_assets
      WHERE affected_profile_id=$1 ORDER BY completed_at DESC NULLS LAST`, [profileId]);
    const secureKinds = new Set<string>();
    for (const row of r.rows) {
      if (row.upload_status !== 'COMPLETED' || !row.content_validated_at) continue;
      if (scanMode !== 'DISABLED' && row.malware_scan_status !== 'NO_THREATS_FOUND') continue;
      if (row.malware_scan_status === 'THREATS_FOUND') continue;
      secureKinds.add(row.kind);
    }
    for (const required of ['ID_FRONT', 'ID_BACK']) {
      if (!secureKinds.has(required)) throw new BadRequestException(`Falta evidencia validada y segura: ${required}`);
    }

    if (this.flag('FEATURE_LIVENESS')) {
      if (this.livenessProvider() === 'REKOGNITION') {
        const live = await this.db.query(`SELECT status FROM liveness_sessions
          WHERE affected_profile_id=$1 ORDER BY created_at DESC LIMIT 1`, [profileId]);
        if (!live.rowCount || live.rows[0].status !== 'SUCCEEDED') throw new BadRequestException('Falta completar la prueba de presencia especializada');
      } else if (!secureKinds.has('LIVENESS_VIDEO')) {
        throw new BadRequestException('Falta evidencia validada de prueba de presencia');
      }
    }

    if (this.flag('REQUIRE_MALWARE_SCAN') && scanMode === 'DISABLED') {
      throw new ServiceUnavailableException('La política exige antimalware pero no hay scanner configurado');
    }

    await this.db.query(`UPDATE affected_profiles SET verification_status='PENDING_OFFICIAL_VERIFICATION',updated_at=now() WHERE id=$1`, [profileId]);
    await this.audit(this.db, { actorSubject: subject, action: 'IDENTITY_CASE_SUBMITTED', entityType: 'affected_profile', entityId: profileId });
    return { status: 'PENDING_OFFICIAL_VERIFICATION', publicId: profile.public_id };
  }

  async createReviewRequest(profileId: string, subject: string, dto: IdentityReviewRequestDto) {
    const profile = await this.assertOwner(profileId, subject);
    if (dto.kind === 'NEEDS_INFO_RESPONSE' && profile.verification_status !== 'NEEDS_INFO') {
      throw new BadRequestException('Solo puede responder información cuando el expediente está en NEEDS_INFO');
    }
    if (dto.kind === 'APPEAL' && profile.verification_status !== 'REJECTED') {
      throw new BadRequestException('Solo puede apelar un expediente rechazado');
    }
    try {
      const r = await this.db.query(`INSERT INTO identity_review_requests(affected_profile_id,requested_by_subject,kind,message)
        VALUES($1,$2,$3,$4) RETURNING id,kind,status,created_at`, [profileId, subject, dto.kind, dto.message.trim()]);
      if (dto.kind === 'NEEDS_INFO_RESPONSE') {
        await this.db.query(`UPDATE affected_profiles SET verification_status='DRAFT',updated_at=now() WHERE id=$1`, [profileId]);
      }
      await this.audit(this.db, { actorSubject: subject, action: 'IDENTITY_REVIEW_REQUEST_CREATED', entityType: 'affected_profile', entityId: profileId, metadata: { kind: dto.kind } });
      return r.rows[0];
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException('Ya existe una solicitud abierta de este tipo');
      throw e;
    }
  }

  async resolveReviewRequest(requestId: string, official: any, dto: ResolveIdentityReviewDto) {
    this.assertVerifier(official);
    const request = await this.db.query('SELECT * FROM identity_review_requests WHERE id=$1 AND status=$2', [requestId, 'OPEN']);
    if (!request.rowCount) throw new NotFoundException('Solicitud abierta no encontrada');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE identity_review_requests SET status=$2,resolution_notes=$3,resolved_by_official_id=$4,resolved_at=now()
        WHERE id=$1`, [requestId, dto.decision, dto.notes.trim(), official.id]);
      if (request.rows[0].kind === 'APPEAL' && dto.decision === 'RESOLVED') {
        await client.query(`UPDATE affected_profiles SET verification_status='NEEDS_INFO',updated_at=now() WHERE id=$1`, [request.rows[0].affected_profile_id]);
      }
      await this.audit(client, {
        actorSubject: official.auth_subject,
        officialId: official.id,
        action: 'IDENTITY_REVIEW_REQUEST_RESOLVED',
        entityType: 'identity_review_request',
        entityId: requestId,
        metadata: { decision: dto.decision, kind: request.rows[0].kind },
      });
      await client.query('COMMIT');
      return { status: dto.decision };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async identityCase(profileId: string, official: any, reason: string) {
    this.assertVerifier(official);
    if (!reason || reason.trim().length < 10) throw new BadRequestException('Debe registrar un motivo de acceso');
    const profile = await this.db.query(`SELECT p.id,p.public_id,p.full_name,p.document_type,p.document_last4,p.address,p.city,p.neighborhood,
      p.household_size,p.verification_status,p.liveness_provider,p.liveness_status,p.liveness_provider_status,p.liveness_confidence,
      p.liveness_attempts,p.verified_at,p.created_at,p.updated_at,i.phone_e164,
      ST_Y(p.location::geometry) lat,ST_X(p.location::geometry) lng
      FROM affected_profiles p JOIN auth_identities i ON i.subject=p.auth_subject WHERE p.id=$1`, [profileId]);
    if (!profile.rowCount) throw new NotFoundException();
    const sessions = await this.db.query(`SELECT id,provider,status,confidence,attempt_number,created_at,completed_at
      FROM liveness_sessions WHERE affected_profile_id=$1 ORDER BY created_at DESC LIMIT 10`, [profileId]);
    const reviews = await this.db.query(`SELECT id,kind,status,message,resolution_notes,created_at,resolved_at
      FROM identity_review_requests WHERE affected_profile_id=$1 ORDER BY created_at DESC LIMIT 20`, [profileId]);
    await this.audit(this.db, {
      actorSubject: official.auth_subject,
      officialId: official.id,
      action: 'IDENTITY_CASE_VIEWED',
      entityType: 'affected_profile',
      entityId: profileId,
      metadata: { reason: reason.trim() },
    });
    return { profile: profile.rows[0], livenessSessions: sessions.rows, reviewRequests: reviews.rows };
  }

  async officialEvidence(profileId: string, official: any, dto: EvidenceAccessDto) {
    this.assertVerifier(official);
    const profile = await this.db.query('SELECT id FROM affected_profiles WHERE id=$1', [profileId]);
    if (!profile.rowCount) throw new NotFoundException();
    const assets = await this.db.query(`SELECT id,kind,content_type,size_bytes,upload_status,malware_scan_status,content_validated_at,
      retention_expires_at,created_at,completed_at FROM evidence_assets WHERE affected_profile_id=$1 ORDER BY created_at`, [profileId]);
    await this.audit(this.db, {
      actorSubject: official.auth_subject,
      officialId: official.id,
      action: 'SENSITIVE_EVIDENCE_METADATA_VIEWED',
      entityType: 'affected_profile',
      entityId: profileId,
      metadata: { reason: dto.reason.trim(), assetCount: assets.rowCount },
    });
    return assets.rows;
  }

  async officialEvidenceDownload(assetId: string, official: any, dto: EvidenceAccessDto) {
    this.assertVerifier(official);
    const asset = await this.db.query(`SELECT e.* FROM evidence_assets e WHERE e.id=$1`, [assetId]);
    if (!asset.rowCount) throw new NotFoundException();
    if (asset.rows[0].upload_status !== 'COMPLETED' || !asset.rows[0].content_validated_at) throw new ForbiddenException('Evidencia no validada');
    if (asset.rows[0].malware_scan_status === 'THREATS_FOUND') throw new ForbiddenException('Evidencia en cuarentena por malware');
    if (this.malwareMode() !== 'DISABLED' && asset.rows[0].malware_scan_status !== 'NO_THREATS_FOUND') {
      throw new ForbiddenException('El análisis antimalware todavía no autoriza esta evidencia');
    }
    const bucket = process.env.PRIVATE_EVIDENCE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('PRIVATE_EVIDENCE_BUCKET no configurado');
    const downloadUrl = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucket, Key: asset.rows[0].object_key }), { expiresIn: 120 });
    await this.audit(this.db, {
      actorSubject: official.auth_subject,
      officialId: official.id,
      action: 'SENSITIVE_EVIDENCE_DOWNLOAD_URL_ISSUED',
      entityType: 'evidence_asset',
      entityId: assetId,
      metadata: { reason: dto.reason.trim(), expiresIn: 120 },
    });
    return { assetId, downloadUrl, expiresIn: 120 };
  }

  async verify(profileId: string, official: any, dto: VerifyAffectedDto) {
    this.assertVerifier(official);
    const profile = await this.db.query('SELECT id,verification_status FROM affected_profiles WHERE id=$1', [profileId]);
    if (!profile.rowCount) throw new NotFoundException();
    if (profile.rows[0].verification_status !== 'PENDING_OFFICIAL_VERIFICATION') {
      throw new BadRequestException('La decisión solo puede aplicarse a un expediente pendiente de revisión oficial');
    }
    if (dto.decision !== 'APPROVED' && (!dto.notes || dto.notes.trim().length < 5)) {
      throw new BadRequestException('REJECTED y NEEDS_INFO requieren una explicación para el ciudadano y la auditoría');
    }
    const status = dto.decision === 'APPROVED' ? 'VERIFIED' : dto.decision === 'REJECTED' ? 'REJECTED' : 'NEEDS_INFO';
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO beneficiary_verifications(affected_profile_id,official_id,decision,method,notes)
        VALUES($1,$2,$3,$4,$5)`, [profileId, official.id, dto.decision, dto.method ?? 'FIELD_OR_DESK_REVIEW', dto.notes ?? null]);
      await client.query(`UPDATE affected_profiles SET verification_status=$2,verified_at=CASE WHEN $2='VERIFIED' THEN now() ELSE verified_at END,updated_at=now() WHERE id=$1`, [profileId, status]);
      await this.audit(client, {
        actorSubject: official.auth_subject,
        officialId: official.id,
        action: 'BENEFICIARY_VERIFICATION',
        entityType: 'affected_profile',
        entityId: profileId,
        metadata: { decision: dto.decision, method: dto.method ?? 'FIELD_OR_DESK_REVIEW' },
      });
      await client.query('COMMIT');
      return { status };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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
