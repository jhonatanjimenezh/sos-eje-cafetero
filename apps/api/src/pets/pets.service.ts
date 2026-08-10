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
  UnauthorizedException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import {
  CompletePetMediaDto,
  CreatePetCaseDto,
  CreatePetClaimDto,
  CreatePetProfileDto,
  PetCaseKind,
  PetClaimEvidenceKind,
  PetClaimRole,
  PetFinderAction,
  PetOwnerAction,
  PresignPetCasePhotoDto,
  PresignPetClaimEvidenceDto,
} from './dto';

const PUBLIC_PHOTO_LIMIT = 15_000_000;
const PRIVATE_EVIDENCE_LIMIT = 50_000_000;

@Injectable()
export class PetsService {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
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

  private kmsKey() {
    const key = process.env.PET_EVIDENCE_KMS_KEY_ID || process.env.EVIDENCE_KMS_KEY_ID;
    if (process.env.NODE_ENV === 'production' && !key) {
      throw new ServiceUnavailableException('KMS para evidencia de mascotas no configurado');
    }
    return key || null;
  }

  private uploadEncryption() {
    const kms = this.kmsKey();
    return kms
      ? {
          command: { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: kms },
          headers: {
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': kms,
          },
        }
      : {
          command: { ServerSideEncryption: 'AES256' as const },
          headers: { 'x-amz-server-side-encryption': 'AES256' },
        };
  }

  private decodeSecret(name: string): Buffer {
    const raw = process.env[name];
    if (!raw) throw new ServiceUnavailableException(`Secreto requerido no configurado: ${name}`);
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64url');
    } catch {
      throw new ServiceUnavailableException(`Secreto inválido: ${name}`);
    }
    if (key.length !== 32) throw new ServiceUnavailableException(`${name} debe contener exactamente 32 bytes`);
    return key;
  }

  private keyedHash(domain: string, value: string) {
    const key = this.decodeSecret('PET_IDENTITY_HASH_SECRET_B64URL');
    return createHmac('sha256', key)
      .update(`${domain}:v1:${value.normalize('NFKC').trim().toUpperCase()}`, 'utf8')
      .digest('base64url');
  }

  private encryptPrivateProfile(subject: string, value: Record<string, unknown>) {
    const key = this.decodeSecret('PET_PROFILE_ENCRYPTION_SECRET_B64URL');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`sos-pet-profile:v1:${subject}`, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  private cleanText(value: string | undefined | null, max: number, publicField = false): string | null {
    if (!value) return null;
    const cleaned = value
      .normalize('NFKC')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    if (cleaned.length > max) throw new BadRequestException('Texto demasiado largo');
    if (publicField && this.containsContact(cleaned)) {
      throw new BadRequestException('Los campos públicos no permiten teléfonos, correos, enlaces ni usuarios externos');
    }
    return cleaned;
  }

  private containsContact(value: string) {
    return /(?:https?:\/\/|www\.|wa\.me|t\.me|telegram|whatsapp|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\+?\d[\d\s().-]{7,}\d))/i.test(value);
  }

  private async identity(subject: string) {
    const r = await this.db.query('SELECT subject,phone_e164 FROM auth_identities WHERE subject=$1', [subject]);
    if (!r.rowCount) throw new UnauthorizedException('Identidad ciudadana OTP verificada requerida');
    return r.rows[0] as { subject: string; phone_e164: string };
  }

  private async bumpRate(key: string, max: number, ttlSeconds: number) {
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, ttlSeconds);
    } catch {
      throw new ServiceUnavailableException('Protección antiabuso de mascotas temporalmente no disponible');
    }
    if (count > max) {
      throw new HttpException('Demasiadas operaciones. Intenta más tarde.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async claimRate(subject: string, caseId: string) {
    await this.bumpRate(`pets:claims:15m:${subject}`, 8, 15 * 60);
    await this.bumpRate(`pets:claims:24h:${subject}`, 24, 24 * 60 * 60);
    await this.bumpRate(`pets:claims:case:1h:${subject}:${caseId}`, 4, 60 * 60);
  }

  private async auditBestEffort(subject: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
    try {
      await this.db.query(
        `INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [subject, action, entityType, entityId, JSON.stringify(metadata)],
      );
    } catch {
      // Creación humanitaria no se bloquea por telemetría auxiliar.
    }
  }

  private async auditCritical(subject: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
    try {
      await this.db.query(
        `INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [subject, action, entityType, entityId, JSON.stringify(metadata)],
      );
    } catch {
      // Acceder o liberar evidencia/contactos privados sin auditoría no es aceptable.
      throw new ServiceUnavailableException('Auditoría de seguridad temporalmente no disponible');
    }
  }

  private malwareMode() {
    return (process.env.EVIDENCE_MALWARE_SCAN_MODE ?? 'DISABLED').toUpperCase();
  }

  private async securityScanStatus(bucket: string, key: string) {
    if (!['GUARDDUTY', 'TAGGED_S3'].includes(this.malwareMode())) return 'NOT_CONFIGURED';
    try {
      const tags = await this.s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return tags.TagSet?.find(tag => tag.Key === 'GuardDutyMalwareScanStatus')?.Value ?? 'PENDING';
    } catch {
      return 'PENDING';
    }
  }

  private scanReady(status: string) {
    if (status === 'THREATS_FOUND') return false;
    if (this.malwareMode() === 'DISABLED') {
      if (process.env.REQUIRE_MALWARE_SCAN === 'true') {
        throw new ServiceUnavailableException('La política exige antimalware pero no hay scanner configurado');
      }
      return true;
    }
    return status === 'NO_THREATS_FOUND';
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

  private compatibleType(expected: string, detected: string) {
    if (expected === detected) return true;
    return expected === 'video/quicktime' && detected === 'video/mp4';
  }

  private extension(contentType: string) {
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/webp') return 'webp';
    if (contentType === 'video/mp4') return 'mp4';
    if (contentType === 'video/quicktime') return 'mov';
    if (contentType === 'video/webm') return 'webm';
    return 'jpg';
  }

  private retentionDays() {
    const value = Number(process.env.PET_EVIDENCE_RETENTION_DAYS ?? 30);
    if (!Number.isFinite(value)) return 30;
    return Math.max(7, Math.min(90, Math.floor(value)));
  }

  private async presignedPut(key: string, contentType: string, sha256: string) {
    const bucket = this.bucket();
    const checksum = Buffer.from(sha256.toLowerCase(), 'hex').toString('base64');
    const encryption = this.uploadEncryption();
    const uploadUrl = await getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ChecksumSHA256: checksum,
      ...encryption.command,
    }), { expiresIn: 600 });
    return {
      uploadUrl,
      expiresIn: 600,
      uploadHeaders: {
        'Content-Type': contentType,
        'x-amz-checksum-sha256': checksum,
        ...encryption.headers,
      },
    };
  }

  private async validateUploadedObject(input: {
    key: string;
    contentType: string;
    declaredSha256: string;
    declaredSize: number;
    dto: CompletePetMediaDto;
    reject: (reason: string) => Promise<never>;
  }) {
    const bucket = this.bucket();
    if (input.dto.sha256.toLowerCase() !== input.declaredSha256.toLowerCase() || input.dto.sizeBytes !== Number(input.declaredSize)) {
      return input.reject('El archivo no coincide con la declaración previa a la carga');
    }
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key, ChecksumMode: 'ENABLED' }));
    if (!head.ContentLength || Number(head.ContentLength) !== input.dto.sizeBytes) return input.reject('El tamaño real del archivo no coincide');
    if (head.ContentType !== input.contentType) return input.reject('El MIME almacenado no coincide con el declarado');
    const checksum = Buffer.from(input.dto.sha256.toLowerCase(), 'hex').toString('base64');
    if (head.ChecksumSHA256 && head.ChecksumSHA256 !== checksum) return input.reject('El checksum S3 no coincide');
    const sample = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: input.key, Range: 'bytes=0-31' }));
    const bytes = await sample.Body?.transformToByteArray();
    const detected = bytes ? this.detectContentType(bytes) : null;
    if (!detected || !this.compatibleType(input.contentType, detected)) return input.reject('El binario no corresponde al tipo permitido');
    const scanStatus = await this.securityScanStatus(bucket, input.key);
    if (scanStatus === 'THREATS_FOUND') return input.reject('La evidencia fue bloqueada por seguridad');
    return { detected, scanStatus, ready: this.scanReady(scanStatus) };
  }

  async createProfile(subject: string, dto: CreatePetProfileDto) {
    this.assertEnabled();
    await this.identity(subject);
    await this.bumpRate(`pets:profiles:24h:${subject}`, 12, 24 * 60 * 60);

    const petName = this.cleanText(dto.petName, 80) as string;
    const breed = this.cleanText(dto.breed, 80);
    const color = this.cleanText(dto.color, 80);
    const privateMarks = this.cleanText(dto.privateDistinguishingMarks, 800);
    const ownerFullName = this.cleanText(dto.ownerFullName, 120) as string;

    if (Boolean(dto.ownerDocumentType) !== Boolean(dto.ownerDocumentNumber)) {
      throw new BadRequestException('Tipo y número de documento deben enviarse juntos o no enviarse');
    }

    const documentNormalized = dto.ownerDocumentNumber?.normalize('NFKC').replace(/[^A-Z0-9]/gi, '').toUpperCase() ?? null;
    const microchipNormalized = dto.microchip?.normalize('NFKC').replace(/[^A-Z0-9]/gi, '').toUpperCase() ?? null;
    const encrypted = this.encryptPrivateProfile(subject, {
      ownerFullName,
      ownerDocumentType: dto.ownerDocumentType ?? null,
      privateDistinguishingMarks: privateMarks,
      schemaVersion: 1,
    });

    try {
      const r = await this.db.query(`INSERT INTO pet_profiles(
        owner_auth_subject,pet_name,animal_type,sex,approximate_age_months,breed,color,sterilized,
        microchip_hash,microchip_last4,owner_document_hash,owner_document_last4,
        private_payload_ciphertext,private_payload_iv,private_payload_tag,consent_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING id,public_id,pet_name,animal_type,sex,approximate_age_months,breed,color,sterilized,
          microchip_last4,owner_document_last4,status,created_at`, [
        subject,
        petName,
        dto.animalType,
        dto.sex ?? 'UNKNOWN',
        dto.approximateAgeMonths ?? null,
        breed,
        color,
        dto.sterilized ?? null,
        microchipNormalized ? this.keyedHash('MICROCHIP', microchipNormalized) : null,
        microchipNormalized ? microchipNormalized.slice(-4).padStart(4, '*') : null,
        documentNormalized ? this.keyedHash(`DOCUMENT:${dto.ownerDocumentType}`, documentNormalized) : null,
        documentNormalized ? documentNormalized.slice(-4).padStart(4, '*') : null,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        dto.consentVersion,
      ]);
      await this.auditBestEffort(subject, 'PET_PROFILE_CREATED', 'PET_PROFILE', r.rows[0].id, { consentVersion: dto.consentVersion });
      return r.rows[0];
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('Ya existe un registro activo con estos identificadores privados');
      throw error;
    }
  }

  async myProfiles(subject: string) {
    this.assertEnabled();
    await this.identity(subject);
    const r = await this.db.query(`SELECT public_id,pet_name,animal_type,sex,approximate_age_months,breed,color,sterilized,
      microchip_last4,owner_document_last4,status,created_at,updated_at
      FROM pet_profiles WHERE owner_auth_subject=$1 AND status='ACTIVE' ORDER BY created_at DESC`, [subject]);
    return r.rows;
  }

  async createCase(subject: string, dto: CreatePetCaseDto) {
    this.assertEnabled();
    await this.identity(subject);
    await this.bumpRate(`pets:cases:24h:${subject}`, 20, 24 * 60 * 60);

    let profile: any = null;
    if (dto.kind === PetCaseKind.LOST) {
      if (!dto.petProfilePublicId) throw new BadRequestException('Un caso PERDIDO debe vincularse a una mascota registrada');
      const p = await this.db.query(`SELECT * FROM pet_profiles
        WHERE public_id=$1 AND owner_auth_subject=$2 AND status='ACTIVE'`, [dto.petProfilePublicId, subject]);
      if (!p.rowCount) throw new ForbiddenException('Mascota registrada no disponible para esta sesión');
      profile = p.rows[0];
      if (profile.animal_type !== dto.animalType) throw new BadRequestException('El tipo de animal no coincide con el perfil privado');
    } else if (dto.petProfilePublicId) {
      throw new BadRequestException('Un caso ENCONTRADO no identifica propietario por adelantado');
    }

    const publicName = dto.kind === PetCaseKind.FOUND
      ? 'Sin identificar'
      : (profile.pet_name as string);
    const publicDescription = this.cleanText(dto.publicDescription, 240, true);
    const breed = this.cleanText(dto.kind === PetCaseKind.LOST ? profile.breed : dto.breed, 80, true);
    const color = this.cleanText(dto.kind === PetCaseKind.LOST ? profile.color : dto.color, 80, true);
    const city = this.cleanText(dto.city ?? 'Manizales', 80, true) ?? 'Manizales';
    const areaHint = this.cleanText(dto.areaHint, 120, true);
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : null;
    if (occurredAt && !Number.isFinite(occurredAt.getTime())) throw new BadRequestException('Fecha del caso inválida');
    if ((dto.lat == null) !== (dto.lng == null)) throw new BadRequestException('Latitud y longitud deben enviarse juntas');

    try {
      const r = await this.db.query(`INSERT INTO pet_cases(
        pet_profile_id,created_by_subject,kind,animal_type,public_name,public_description,breed,color,city,area_hint,
        exact_location,occurred_at,share_creator_phone)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          CASE WHEN $11::float IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($12,$11),4326)::geography END,
          $13,$14)
        RETURNING id,public_id,kind,public_name,status,created_at`, [
        profile?.id ?? null,
        subject,
        dto.kind,
        dto.animalType,
        publicName,
        publicDescription,
        breed,
        color,
        city,
        areaHint,
        dto.lat ?? null,
        dto.lng ?? null,
        occurredAt,
        dto.shareCreatorPhone ?? false,
      ]);
      await this.auditBestEffort(subject, 'PET_CASE_CREATED', 'PET_CASE', r.rows[0].id, { kind: dto.kind });
      return {
        ...r.rows[0],
        publicNotice: 'El catálogo público solo mostrará foto, nombre/apodo y estado. No publicaremos teléfonos, identidad ni ubicación exacta.',
      };
    } catch (error: any) {
      if (error?.code === '23505' && dto.kind === PetCaseKind.LOST) {
        throw new ConflictException('Esta mascota ya tiene un caso perdido activo');
      }
      throw error;
    }
  }

  private async publicPhoto(caseId: string) {
    const media = await this.db.query(`SELECT object_key FROM pet_case_media
      WHERE case_id=$1 AND upload_status='READY' ORDER BY completed_at DESC NULLS LAST LIMIT 1`, [caseId]);
    if (!media.rowCount) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(), Key: media.rows[0].object_key }), { expiresIn: 600 });
  }

  async publicCases(kind?: string) {
    this.assertEnabled();
    if (kind && !['LOST', 'FOUND'].includes(kind)) throw new BadRequestException('Tipo de catálogo inválido');
    const r = await this.db.query(`SELECT id,public_id,kind,public_name,status,created_at
      FROM pet_cases
      WHERE status IN ('OPEN','MATCH_REVIEW') AND ($1::text IS NULL OR kind=$1)
      ORDER BY created_at DESC LIMIT 500`, [kind ?? null]);
    return Promise.all(r.rows.map(async row => ({
      id: row.public_id,
      kind: row.kind,
      name: row.public_name,
      status: row.status,
      photoUrl: await this.publicPhoto(row.id),
    })));
  }

  async publicCase(publicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT id,public_id,kind,public_name,status,created_at
      FROM pet_cases WHERE public_id=$1 AND status IN ('OPEN','MATCH_REVIEW')`, [publicId]);
    if (!r.rowCount) throw new NotFoundException('Caso no disponible');
    return {
      id: r.rows[0].public_id,
      kind: r.rows[0].kind,
      name: r.rows[0].public_name,
      status: r.rows[0].status,
      photoUrl: await this.publicPhoto(r.rows[0].id),
    };
  }

  async presignCasePhoto(subject: string, publicId: string, dto: PresignPetCasePhotoDto) {
    this.assertEnabled();
    await this.identity(subject);
    if (dto.sizeBytes > PUBLIC_PHOTO_LIMIT) throw new BadRequestException('Foto demasiado grande');
    const c = await this.db.query('SELECT id,created_by_subject FROM pet_cases WHERE public_id=$1', [publicId]);
    if (!c.rowCount || c.rows[0].created_by_subject !== subject) throw new ForbiddenException('Caso no disponible para esta sesión');
    await this.bumpRate(`pets:case-photo:1h:${subject}`, 20, 60 * 60);
    const key = `private/pets/cases/${c.rows[0].id}/public-photo/${randomUUID()}.${this.extension(dto.contentType)}`;
    const asset = await this.db.query(`INSERT INTO pet_case_media(
      case_id,object_key,content_type,declared_sha256,declared_size_bytes)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [c.rows[0].id, key, dto.contentType, dto.sha256.toLowerCase(), dto.sizeBytes]);
    const signed = await this.presignedPut(key, dto.contentType, dto.sha256);
    await this.auditBestEffort(subject, 'PET_PUBLIC_PHOTO_UPLOAD_ISSUED', 'PET_CASE_MEDIA', asset.rows[0].id, { sizeBytes: dto.sizeBytes });
    return { assetId: asset.rows[0].id, ...signed };
  }

  async completeCasePhoto(subject: string, assetId: string, dto: CompletePetMediaDto) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT m.*,c.created_by_subject FROM pet_case_media m
      JOIN pet_cases c ON c.id=m.case_id WHERE m.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].created_by_subject !== subject) throw new ForbiddenException();
    const asset = r.rows[0];
    const reject = async (reason: string): Promise<never> => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: asset.object_key })).catch(() => undefined);
      await this.db.query(`UPDATE pet_case_media SET upload_status='REJECTED',scan_status='REJECTED' WHERE id=$1`, [assetId]);
      await this.auditBestEffort(subject, 'PET_PUBLIC_PHOTO_REJECTED', 'PET_CASE_MEDIA', assetId, { reason });
      throw new BadRequestException(reason);
    };
    const result = await this.validateUploadedObject({
      key: asset.object_key,
      contentType: asset.content_type,
      declaredSha256: asset.declared_sha256,
      declaredSize: Number(asset.declared_size_bytes),
      dto,
      reject,
    });
    await this.db.query(`UPDATE pet_case_media SET actual_sha256=$2,actual_size_bytes=$3,scan_status=$4,
      upload_status=$5,completed_at=CASE WHEN $5='READY' THEN now() ELSE completed_at END WHERE id=$1`, [
      assetId, dto.sha256.toLowerCase(), dto.sizeBytes, result.scanStatus, result.ready ? 'READY' : 'PENDING',
    ]);
    return { assetId, status: result.ready ? 'READY' : 'SCAN_PENDING', malwareScanStatus: result.scanStatus };
  }

  async createClaim(subject: string, casePublicId: string, dto: CreatePetClaimDto) {
    this.assertEnabled();
    await this.identity(subject);
    const c = await this.db.query(`SELECT c.*,p.owner_auth_subject
      FROM pet_cases c LEFT JOIN pet_profiles p ON p.id=c.pet_profile_id
      WHERE c.public_id=$1 AND c.status IN ('OPEN','MATCH_REVIEW')`, [casePublicId]);
    if (!c.rowCount) throw new NotFoundException('Caso no disponible');
    const petCase = c.rows[0];
    if (petCase.created_by_subject === subject) throw new BadRequestException('No puedes crear una reclamación sobre tu propio caso');
    await this.claimRate(subject, petCase.id);

    let petProfileId: string | null = null;
    if (petCase.kind === 'LOST') {
      if (dto.role !== PetClaimRole.FINDER) throw new BadRequestException('Un caso perdido solo admite aviso de persona que encontró la mascota');
      if (dto.petProfilePublicId) throw new BadRequestException('No debes registrar una mascota ajena para informar que la encontraste');
    } else {
      if (dto.role !== PetClaimRole.OWNER_CLAIMANT) throw new BadRequestException('Un caso encontrado requiere un supuesto propietario');
      if (!dto.petProfilePublicId) throw new BadRequestException('Debes seleccionar tu perfil privado de mascota');
      const p = await this.db.query(`SELECT id,animal_type FROM pet_profiles
        WHERE public_id=$1 AND owner_auth_subject=$2 AND status='ACTIVE'`, [dto.petProfilePublicId, subject]);
      if (!p.rowCount) throw new ForbiddenException('Perfil de mascota no disponible');
      if (p.rows[0].animal_type !== petCase.animal_type) throw new BadRequestException('El tipo de animal no coincide');
      petProfileId = p.rows[0].id;
    }

    const existing = await this.db.query(`SELECT id,public_id FROM pet_claims
      WHERE case_id=$1 AND claimant_subject=$2 AND status IN ('PENDING_EVIDENCE','EVIDENCE_READY')
      ORDER BY created_at DESC LIMIT 1`, [petCase.id, subject]);
    let result;
    if (existing.rowCount) {
      result = await this.db.query(`UPDATE pet_claims SET share_claimant_phone=$2,pet_profile_id=COALESCE($3,pet_profile_id),
        expires_at=GREATEST(expires_at,now()+interval '7 days'),updated_at=now() WHERE id=$1 RETURNING id,public_id,status`, [
        existing.rows[0].id, dto.shareClaimantPhone ?? false, petProfileId,
      ]);
    } else {
      result = await this.db.query(`INSERT INTO pet_claims(
        case_id,claimant_subject,claimant_role,pet_profile_id,share_claimant_phone)
        VALUES($1,$2,$3,$4,$5) RETURNING id,public_id,status`, [
        petCase.id, subject, dto.role, petProfileId, dto.shareClaimantPhone ?? false,
      ]);
    }
    await this.auditBestEffort(subject, 'PET_CLAIM_CREATED', 'PET_CLAIM', result.rows[0].id, { role: dto.role });
    return {
      claimId: result.rows[0].public_id,
      status: 'CLAIM_ACCEPTED',
      next: dto.role === PetClaimRole.FINDER ? 'CREATE_PROOF_OF_LIFE_CHALLENGE' : 'UPLOAD_OWNERSHIP_HISTORY',
      notice: 'Ningún teléfono, ubicación o decisión privada de la contraparte se comparte en este paso.',
    };
  }

  async createProofChallenge(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const claim = await this.db.query(`SELECT cl.*,c.kind FROM pet_claims cl JOIN pet_cases c ON c.id=cl.case_id
      WHERE cl.public_id=$1 AND cl.claimant_subject=$2 AND cl.status IN ('PENDING_EVIDENCE','EVIDENCE_READY')`, [claimPublicId, subject]);
    if (!claim.rowCount || claim.rows[0].claimant_role !== 'FINDER' || claim.rows[0].kind !== 'LOST') {
      throw new ForbiddenException('Challenge no disponible');
    }
    await this.bumpRate(`pets:challenge:1h:${subject}`, 12, 60 * 60);
    const code = `PET-${randomBytes(3).toString('hex').toUpperCase()}`;
    const text = `Graba un solo video continuo mostrando claramente a la mascota y, en el mismo plano, una pantalla o papel con el código ${code}. Mueve la cámara lentamente alrededor del animal sin forzarlo a realizar acciones ni causarle estrés.`;
    const r = await this.db.query(`INSERT INTO pet_claim_challenges(claim_id,challenge_code,challenge_text,expires_at)
      VALUES($1,$2,$3,now()+interval '10 minutes') RETURNING id,challenge_code,challenge_text,expires_at`, [claim.rows[0].id, code, text]);
    await this.auditBestEffort(subject, 'PET_PROOF_CHALLENGE_CREATED', 'PET_CLAIM', claim.rows[0].id);
    return {
      challengeId: r.rows[0].id,
      challengeCode: r.rows[0].challenge_code,
      instructions: r.rows[0].challenge_text,
      expiresAt: r.rows[0].expires_at,
      warning: 'Esta es una prueba de vida fuerte, no una garantía matemática de autenticidad. La decisión final es humana.',
    };
  }

  async presignClaimEvidence(subject: string, claimPublicId: string, dto: PresignPetClaimEvidenceDto) {
    this.assertEnabled();
    await this.identity(subject);
    if (dto.sizeBytes > PRIVATE_EVIDENCE_LIMIT) throw new BadRequestException('Evidencia demasiado grande');
    const claim = await this.db.query(`SELECT cl.*,c.kind case_kind FROM pet_claims cl JOIN pet_cases c ON c.id=cl.case_id
      WHERE cl.public_id=$1 AND cl.claimant_subject=$2 AND cl.status IN ('PENDING_EVIDENCE','EVIDENCE_READY')`, [claimPublicId, subject]);
    if (!claim.rowCount) throw new ForbiddenException('Claim no disponible');
    const row = claim.rows[0];

    let challengeId: string | null = null;
    if (dto.kind === PetClaimEvidenceKind.PROOF_OF_LIFE) {
      if (row.claimant_role !== 'FINDER' || row.case_kind !== 'LOST') throw new BadRequestException('Prueba de vida no corresponde a este flujo');
      if (!dto.contentType.startsWith('video/')) throw new BadRequestException('La prueba de vida debe ser video');
      if (!dto.challengeId) throw new BadRequestException('Challenge vigente requerido');
      const challenge = await this.db.query(`SELECT id FROM pet_claim_challenges
        WHERE id=$1 AND claim_id=$2 AND completed_at IS NULL AND expires_at>now()`, [dto.challengeId, row.id]);
      if (!challenge.rowCount) throw new BadRequestException('Challenge expirado o inválido');
      challengeId = challenge.rows[0].id;
    } else {
      if (row.claimant_role !== 'OWNER_CLAIMANT' || row.case_kind !== 'FOUND') throw new BadRequestException('Evidencia histórica no corresponde a este flujo');
    }

    await this.bumpRate(`pets:evidence:1h:${subject}`, 20, 60 * 60);
    const key = `private/pets/claims/${row.id}/${dto.kind.toLowerCase()}/${randomUUID()}.${this.extension(dto.contentType)}`;
    const asset = await this.db.query(`INSERT INTO pet_claim_evidence(
      claim_id,challenge_id,kind,object_key,content_type,declared_sha256,declared_size_bytes,retention_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text || ' days')::interval) RETURNING id`, [
      row.id, challengeId, dto.kind, key, dto.contentType, dto.sha256.toLowerCase(), dto.sizeBytes, String(this.retentionDays()),
    ]);
    const signed = await this.presignedPut(key, dto.contentType, dto.sha256);
    await this.auditBestEffort(subject, 'PET_PRIVATE_EVIDENCE_UPLOAD_ISSUED', 'PET_CLAIM_EVIDENCE', asset.rows[0].id, { kind: dto.kind, sizeBytes: dto.sizeBytes });
    return { assetId: asset.rows[0].id, ...signed };
  }

  async completeClaimEvidence(subject: string, assetId: string, dto: CompletePetMediaDto) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT e.*,cl.claimant_subject,cl.id claim_internal_id FROM pet_claim_evidence e
      JOIN pet_claims cl ON cl.id=e.claim_id WHERE e.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].claimant_subject !== subject) throw new ForbiddenException();
    const asset = r.rows[0];
    const reject = async (reason: string): Promise<never> => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: asset.object_key })).catch(() => undefined);
      await this.db.query(`UPDATE pet_claim_evidence SET upload_status='REJECTED',scan_status='REJECTED' WHERE id=$1`, [assetId]);
      await this.auditBestEffort(subject, 'PET_PRIVATE_EVIDENCE_REJECTED', 'PET_CLAIM_EVIDENCE', assetId, { reason });
      throw new BadRequestException(reason);
    };
    const result = await this.validateUploadedObject({
      key: asset.object_key,
      contentType: asset.content_type,
      declaredSha256: asset.declared_sha256,
      declaredSize: Number(asset.declared_size_bytes),
      dto,
      reject,
    });
    const status = result.ready ? 'READY' : 'PENDING';
    await this.db.query(`UPDATE pet_claim_evidence SET actual_sha256=$2,actual_size_bytes=$3,scan_status=$4,
      upload_status=$5,completed_at=CASE WHEN $5='READY' THEN now() ELSE completed_at END WHERE id=$1`, [
      assetId, dto.sha256.toLowerCase(), dto.sizeBytes, result.scanStatus, status,
    ]);
    if (result.ready) {
      await this.db.query(`UPDATE pet_claims SET status='EVIDENCE_READY',updated_at=now() WHERE id=$1`, [asset.claim_internal_id]);
      if (asset.challenge_id) await this.db.query(`UPDATE pet_claim_challenges SET completed_at=now() WHERE id=$1`, [asset.challenge_id]);
    }
    await this.auditBestEffort(subject, 'PET_PRIVATE_EVIDENCE_VALIDATED', 'PET_CLAIM_EVIDENCE', assetId, { kind: asset.kind, malwareScanStatus: result.scanStatus });
    return { assetId, status: result.ready ? 'READY' : 'SCAN_PENDING', malwareScanStatus: result.scanStatus };
  }

  async ownerInbox(subject: string) {
    this.assertEnabled();
    await this.identity(subject);
    const r = await this.db.query(`SELECT cl.public_id claim_id,c.public_id case_id,p.pet_name,cl.created_at,
      EXISTS(SELECT 1 FROM pet_claim_evidence e WHERE e.claim_id=cl.id AND e.kind='PROOF_OF_LIFE' AND e.upload_status='READY') evidence_ready
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
      JOIN pet_profiles p ON p.id=c.pet_profile_id AND p.owner_auth_subject=$1
      WHERE cl.claimant_role='FINDER' AND cl.status='EVIDENCE_READY'
        AND NOT EXISTS(SELECT 1 FROM pet_blocks b WHERE b.blocker_subject=$1 AND b.blocked_subject=cl.claimant_subject AND b.context='PET_CLAIM')
      ORDER BY cl.created_at DESC LIMIT 200`, [subject]);
    return r.rows.map(row => ({
      claimId: row.claim_id,
      caseId: row.case_id,
      petName: row.pet_name,
      proofOfLifeReady: row.evidence_ready,
      createdAt: row.created_at,
      notice: 'La identidad y el teléfono de quien afirma tener la mascota permanecen privados en este paso.',
    }));
  }

  async ownerInboxSummary(subject: string) {
    const inbox = await this.ownerInbox(subject);
    return { pending: inbox.length, message: inbox.length ? 'Hay nuevas pruebas privadas relacionadas con tus mascotas.' : null };
  }

  async ownerEvidence(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT e.id,e.object_key,e.content_type,e.scan_status,cl.id claim_id
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
      JOIN pet_profiles p ON p.id=c.pet_profile_id AND p.owner_auth_subject=$1
      JOIN pet_claim_evidence e ON e.claim_id=cl.id AND e.kind='PROOF_OF_LIFE' AND e.upload_status='READY'
      WHERE cl.public_id=$2
      ORDER BY e.completed_at DESC LIMIT 1`, [subject, claimPublicId]);
    if (!r.rowCount) throw new NotFoundException('Prueba privada no disponible');
    if (!this.scanReady(r.rows[0].scan_status)) throw new ServiceUnavailableException('La evidencia aún no está habilitada para revisión');
    await this.auditCritical(subject, 'PET_OWNER_VIEWED_PROOF_OF_LIFE', 'PET_CLAIM', r.rows[0].claim_id);
    const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(), Key: r.rows[0].object_key }), { expiresIn: 120 });
    return {
      url,
      contentType: r.rows[0].content_type,
      expiresIn: 120,
      warning: 'Revisa que el animal y el challenge correspondan. Un video reduce fraude, pero no demuestra identidad por sí solo.',
    };
  }

  private ownerActionName(action: PetOwnerAction) {
    return {
      [PetOwnerAction.AUTHORIZE_CONTACT]: 'OWNER_AUTHORIZE_CONTACT',
      [PetOwnerAction.REJECT]: 'OWNER_REJECT',
      [PetOwnerAction.BLOCK]: 'OWNER_BLOCK',
      [PetOwnerAction.REPORT_ABUSE]: 'OWNER_REPORT_ABUSE',
    }[action];
  }

  async ownerAction(subject: string, claimPublicId: string, action: PetOwnerAction) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,cl.claimant_subject,cl.status
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
      JOIN pet_profiles p ON p.id=c.pet_profile_id AND p.owner_auth_subject=$1
      WHERE cl.public_id=$2`, [subject, claimPublicId]);
    if (!r.rowCount) throw new NotFoundException('Solicitud privada no disponible');
    if (action === PetOwnerAction.AUTHORIZE_CONTACT && r.rows[0].status !== 'EVIDENCE_READY') {
      throw new BadRequestException('Debes revisar una prueba de vida validada antes de autorizar contacto');
    }
    const dbAction = this.ownerActionName(action);
    await this.db.query(`INSERT INTO pet_claim_actions(claim_id,actor_subject,action) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING`, [r.rows[0].id, subject, dbAction]);
    if (action === PetOwnerAction.BLOCK || action === PetOwnerAction.REPORT_ABUSE) {
      await this.db.query(`INSERT INTO pet_blocks(blocker_subject,blocked_subject,context)
        VALUES($1,$2,'PET_CLAIM') ON CONFLICT DO NOTHING`, [subject, r.rows[0].claimant_subject]);
    }
    await this.auditCritical(subject, `PET_${dbAction}`, 'PET_CLAIM', r.rows[0].id);
    return action === PetOwnerAction.AUTHORIZE_CONTACT
      ? { status: 'CONTACT_AUTHORIZED', warning: 'Solo autorizaste compartir tu teléfono OTP verificado con esta reclamación. No se comparte tu domicilio ni ubicación.' }
      : { status: 'ACTION_RECORDED', notice: 'Esta decisión privada no genera recibo de rechazo, bloqueo o abuso para la contraparte.' };
  }

  async finderContact(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,p.owner_auth_subject
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
      JOIN pet_profiles p ON p.id=c.pet_profile_id
      WHERE cl.public_id=$1 AND cl.claimant_subject=$2 AND cl.claimant_role='FINDER'`, [claimPublicId, subject]);
    if (!r.rowCount) throw new NotFoundException('Claim no disponible');
    const authorized = await this.db.query(`SELECT 1 FROM pet_claim_actions
      WHERE claim_id=$1 AND action='OWNER_AUTHORIZE_CONTACT' LIMIT 1`, [r.rows[0].id]);
    if (!authorized.rowCount) return { status: 'NOT_AVAILABLE' };
    const owner = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [r.rows[0].owner_auth_subject]);
    if (!owner.rowCount) return { status: 'NOT_AVAILABLE' };
    await this.auditCritical(subject, 'PET_FINDER_RETRIEVED_AUTHORIZED_OWNER_CONTACT', 'PET_CLAIM', r.rows[0].id);
    return {
      status: 'CONTACT_AVAILABLE',
      phone: owner.rows[0].phone_e164,
      warning: 'La persona propietaria autorizó compartir este teléfono. Coordinen la entrega en un punto seguro; no solicites dinero ni domicilio.',
    };
  }

  async finderInbox(subject: string) {
    this.assertEnabled();
    await this.identity(subject);
    const r = await this.db.query(`SELECT cl.public_id claim_id,c.public_id case_id,p.pet_name,cl.created_at,
      EXISTS(SELECT 1 FROM pet_claim_evidence e WHERE e.claim_id=cl.id AND e.kind='OWNERSHIP_HISTORY' AND e.upload_status='READY') evidence_ready
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND' AND c.created_by_subject=$1
      JOIN pet_profiles p ON p.id=cl.pet_profile_id
      WHERE cl.claimant_role='OWNER_CLAIMANT' AND cl.status='EVIDENCE_READY'
        AND NOT EXISTS(SELECT 1 FROM pet_blocks b WHERE b.blocker_subject=$1 AND b.blocked_subject=cl.claimant_subject AND b.context='PET_CLAIM')
      ORDER BY cl.created_at DESC LIMIT 200`, [subject]);
    return r.rows.map(row => ({
      claimId: row.claim_id,
      caseId: row.case_id,
      claimedPetName: row.pet_name,
      ownershipEvidenceReady: row.evidence_ready,
      createdAt: row.created_at,
      notice: 'El teléfono y la identidad personal del supuesto propietario siguen privados hasta aceptación y consentimiento.',
    }));
  }

  async finderInboxSummary(subject: string) {
    const inbox = await this.finderInbox(subject);
    return { pending: inbox.length, message: inbox.length ? 'Hay nuevas reclamaciones privadas sobre animales encontrados.' : null };
  }

  async finderEvidence(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT e.id,e.object_key,e.content_type,e.scan_status,cl.id claim_id
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND' AND c.created_by_subject=$1
      JOIN pet_claim_evidence e ON e.claim_id=cl.id AND e.kind='OWNERSHIP_HISTORY' AND e.upload_status='READY'
      WHERE cl.public_id=$2 ORDER BY e.completed_at DESC LIMIT 1`, [subject, claimPublicId]);
    if (!r.rowCount) throw new NotFoundException('Evidencia privada no disponible');
    if (!this.scanReady(r.rows[0].scan_status)) throw new ServiceUnavailableException('La evidencia aún no está habilitada para revisión');
    await this.auditCritical(subject, 'PET_FINDER_VIEWED_OWNERSHIP_EVIDENCE', 'PET_CLAIM', r.rows[0].claim_id);
    const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(), Key: r.rows[0].object_key }), { expiresIn: 120 });
    return {
      url,
      contentType: r.rows[0].content_type,
      expiresIn: 120,
      warning: 'Las fotos o videos históricos ayudan a evaluar propiedad, pero no debes usar esta evidencia para localizar ni contactar a la persona fuera del flujo autorizado.',
    };
  }

  private finderActionName(action: PetFinderAction) {
    return {
      [PetFinderAction.ACCEPT_OWNER]: 'FINDER_ACCEPT_OWNER',
      [PetFinderAction.REJECT_OWNER]: 'FINDER_REJECT_OWNER',
      [PetFinderAction.BLOCK_OWNER]: 'FINDER_BLOCK_OWNER',
      [PetFinderAction.REPORT_ABUSE]: 'FINDER_REPORT_ABUSE',
    }[action];
  }

  async finderAction(subject: string, claimPublicId: string, action: PetFinderAction) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,cl.claimant_subject,cl.status
      FROM pet_claims cl JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND' AND c.created_by_subject=$1
      WHERE cl.public_id=$2`, [subject, claimPublicId]);
    if (!r.rowCount) throw new NotFoundException('Reclamación privada no disponible');
    if (action === PetFinderAction.ACCEPT_OWNER && r.rows[0].status !== 'EVIDENCE_READY') {
      throw new BadRequestException('Debes revisar evidencia histórica validada antes de aceptar');
    }
    const dbAction = this.finderActionName(action);
    await this.db.query(`INSERT INTO pet_claim_actions(claim_id,actor_subject,action) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING`, [r.rows[0].id, subject, dbAction]);
    if (action === PetFinderAction.BLOCK_OWNER || action === PetFinderAction.REPORT_ABUSE) {
      await this.db.query(`INSERT INTO pet_blocks(blocker_subject,blocked_subject,context)
        VALUES($1,$2,'PET_CLAIM') ON CONFLICT DO NOTHING`, [subject, r.rows[0].claimant_subject]);
    }
    await this.auditCritical(subject, `PET_${dbAction}`, 'PET_CLAIM', r.rows[0].id);
    return action === PetFinderAction.ACCEPT_OWNER
      ? { status: 'OWNER_CLAIM_ACCEPTED', notice: 'La aceptación habilita únicamente los contactos que cada parte haya consentido compartir.' }
      : { status: 'ACTION_RECORDED', notice: 'La decisión privada no produce un recibo de rechazo/bloqueo/abuso visible para la contraparte.' };
  }

  async foundClaimFinderContact(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,c.created_by_subject,c.share_creator_phone
      FROM pet_claims cl JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND'
      WHERE cl.public_id=$1 AND cl.claimant_subject=$2 AND cl.claimant_role='OWNER_CLAIMANT'`, [claimPublicId, subject]);
    if (!r.rowCount) throw new NotFoundException('Claim no disponible');
    const accepted = await this.db.query(`SELECT 1 FROM pet_claim_actions WHERE claim_id=$1 AND action='FINDER_ACCEPT_OWNER' LIMIT 1`, [r.rows[0].id]);
    if (!accepted.rowCount || !r.rows[0].share_creator_phone) return { status: 'NOT_AVAILABLE' };
    const finder = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [r.rows[0].created_by_subject]);
    if (!finder.rowCount) return { status: 'NOT_AVAILABLE' };
    await this.auditCritical(subject, 'PET_OWNER_CLAIMANT_RETRIEVED_FINDER_CONTACT', 'PET_CLAIM', r.rows[0].id);
    return {
      status: 'CONTACT_AVAILABLE',
      phone: finder.rows[0].phone_e164,
      warning: 'La persona que encontró el animal consintió compartir este teléfono después de aceptar tu evidencia. Coordinen en un punto seguro.',
    };
  }

  async foundClaimOwnerContact(subject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,cl.claimant_subject,cl.share_claimant_phone
      FROM pet_claims cl JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND' AND c.created_by_subject=$2
      WHERE cl.public_id=$1 AND cl.claimant_role='OWNER_CLAIMANT'`, [claimPublicId, subject]);
    if (!r.rowCount) throw new NotFoundException('Claim no disponible');
    const accepted = await this.db.query(`SELECT 1 FROM pet_claim_actions WHERE claim_id=$1 AND action='FINDER_ACCEPT_OWNER' LIMIT 1`, [r.rows[0].id]);
    if (!accepted.rowCount || !r.rows[0].share_claimant_phone) return { status: 'NOT_AVAILABLE' };
    const owner = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [r.rows[0].claimant_subject]);
    if (!owner.rowCount) return { status: 'NOT_AVAILABLE' };
    await this.auditCritical(subject, 'PET_FINDER_RETRIEVED_ACCEPTED_OWNER_CONTACT', 'PET_CLAIM', r.rows[0].id);
    return {
      status: 'CONTACT_AVAILABLE',
      phone: owner.rows[0].phone_e164,
      warning: 'El supuesto propietario consintió compartir este teléfono y tú aceptaste su evidencia. Verifica nuevamente antes de entregar la mascota.',
    };
  }
}
