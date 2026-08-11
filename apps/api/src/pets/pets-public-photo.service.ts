import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
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
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { CompletePetMediaDto, PresignPetCasePhotoDto } from './dto';

@Injectable()
export class PetsPublicPhotoService {
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
      throw new ServiceUnavailableException('KMS para fotografías de mascotas no configurado');
    }
    return key || null;
  }

  private encryption() {
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

  private async audit(subject: string, action: string, entityId: string, metadata: Record<string, unknown> = {}) {
    try {
      await this.db.query(`INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'PET_CASE_MEDIA',$3,$4::jsonb)`, [subject, action, entityId, JSON.stringify(metadata)]);
    } catch {
      // La foto pública no contiene identidad/contacto. Fallo de telemetría no bloquea creación.
    }
  }

  private malwareMode() {
    return (process.env.EVIDENCE_MALWARE_SCAN_MODE ?? 'DISABLED').toUpperCase();
  }

  private async scanStatus(bucket: string, key: string) {
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

  private detectType(bytes: Uint8Array): string | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) return 'image/png';
    const ascii = (start: number, end: number) => Buffer.from(bytes.slice(start, end)).toString('ascii');
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  private stripJpegMetadata(bytes: Uint8Array) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const parts: Buffer[] = [Buffer.from(bytes.slice(0, 2))];
    let offset = 2;
    while (offset < bytes.length) {
      if (offset + 1 >= bytes.length || bytes[offset] !== 0xff) {
        parts.push(Buffer.from(bytes.slice(offset)));
        break;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) {
        parts.push(Buffer.from(bytes.slice(offset)));
        break;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        parts.push(Buffer.from(bytes.slice(offset, offset + 2)));
        offset += 2;
        continue;
      }
      if (offset + 4 > bytes.length) return null;
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const end = offset + 2 + length;
      if (length < 2 || end > bytes.length) return null;
      // APP1=EXIF/XMP, APP13=IPTC, COM=comentarios. Se eliminan antes de publicar.
      if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) {
        parts.push(Buffer.from(bytes.slice(offset, end)));
      }
      offset = end;
    }
    return Buffer.concat(parts);
  }

  private stripPngMetadata(bytes: Uint8Array) {
    if (bytes.length < 8) return null;
    const parts: Buffer[] = [Buffer.from(bytes.slice(0, 8))];
    let offset = 8;
    let sawEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = Buffer.from(bytes.slice(offset, offset + 4)).readUInt32BE(0);
      const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString('ascii');
      const end = offset + 12 + length;
      if (end > bytes.length) return null;
      if (!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type)) {
        parts.push(Buffer.from(bytes.slice(offset, end)));
      }
      offset = end;
      if (type === 'IEND') {
        sawEnd = true;
        break;
      }
    }
    return sawEnd ? Buffer.concat(parts) : null;
  }

  private hasWebpSensitiveMetadata(bytes: Uint8Array) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = Buffer.from(bytes.slice(offset, offset + 4)).toString('ascii');
      const size = Buffer.from(bytes.slice(offset + 4, offset + 8)).readUInt32LE(0);
      if (type === 'EXIF' || type === 'XMP ') return true;
      offset += 8 + size + (size % 2);
    }
    return false;
  }

  private sanitizeMetadata(contentType: string, bytes: Uint8Array): Buffer | null {
    if (contentType === 'image/jpeg') return this.stripJpegMetadata(bytes);
    if (contentType === 'image/png') return this.stripPngMetadata(bytes);
    if (contentType === 'image/webp') {
      return this.hasWebpSensitiveMetadata(bytes) ? null : Buffer.from(bytes);
    }
    return null;
  }

  private extension(contentType: string) {
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/webp') return 'webp';
    return 'jpg';
  }

  async presign(subject: string, publicId: string, dto: PresignPetCasePhotoDto) {
    this.assertEnabled();
    const c = await this.db.query('SELECT id,created_by_subject FROM pet_cases WHERE public_id=$1', [publicId]);
    if (!c.rowCount || c.rows[0].created_by_subject !== subject) throw new ForbiddenException();

    const key = `private/pets/cases/${c.rows[0].id}/catalog/${randomUUID()}.${this.extension(dto.contentType)}`;
    const asset = await this.db.query(`INSERT INTO pet_case_media(
      case_id,object_key,content_type,declared_sha256,declared_size_bytes)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [
      c.rows[0].id, key, dto.contentType, dto.sha256.toLowerCase(), dto.sizeBytes,
    ]);
    const checksum = Buffer.from(dto.sha256.toLowerCase(), 'hex').toString('base64');
    const encryption = this.encryption();
    const uploadUrl = await getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ContentType: dto.contentType,
      ChecksumSHA256: checksum,
      ...encryption.command,
    }), { expiresIn: 600 });
    await this.audit(subject, 'PET_CATALOG_PHOTO_UPLOAD_ISSUED', asset.rows[0].id, { sizeBytes: dto.sizeBytes });
    return {
      assetId: asset.rows[0].id,
      uploadUrl,
      expiresIn: 600,
      uploadHeaders: {
        'Content-Type': dto.contentType,
        'x-amz-checksum-sha256': checksum,
        ...encryption.headers,
      },
    };
  }

  async complete(subject: string, assetId: string, dto: CompletePetMediaDto) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT m.*,c.created_by_subject FROM pet_case_media m
      JOIN pet_cases c ON c.id=m.case_id WHERE m.id=$1`, [assetId]);
    if (!r.rowCount || r.rows[0].created_by_subject !== subject) throw new ForbiddenException();
    const asset = r.rows[0];
    const bucket = this.bucket();

    const reject = async (reason: string): Promise<never> => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key })).catch(() => undefined);
      await this.db.query(`UPDATE pet_case_media SET upload_status='REJECTED',scan_status='REJECTED' WHERE id=$1`, [assetId]);
      await this.audit(subject, 'PET_CATALOG_PHOTO_REJECTED', assetId, { reason });
      throw new BadRequestException(reason);
    };

    if (dto.sha256.toLowerCase() !== String(asset.declared_sha256).toLowerCase() || dto.sizeBytes !== Number(asset.declared_size_bytes)) {
      return reject('La fotografía no coincide con la declaración previa');
    }
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.object_key, ChecksumMode: 'ENABLED' }));
    if (!head.ContentLength || Number(head.ContentLength) !== dto.sizeBytes) return reject('El tamaño real no coincide');
    if (head.ContentType !== asset.content_type) return reject('El MIME almacenado no coincide');
    const expectedChecksum = Buffer.from(dto.sha256.toLowerCase(), 'hex').toString('base64');
    if (head.ChecksumSHA256 && head.ChecksumSHA256 !== expectedChecksum) return reject('El checksum almacenado no coincide');
    if (process.env.NODE_ENV === 'production' && head.ServerSideEncryption !== 'aws:kms') {
      return reject('La fotografía no fue almacenada con KMS');
    }

    const object = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: asset.object_key }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes || !bytes.length) return reject('La fotografía está vacía');
    const detected = this.detectType(bytes);
    if (!detected || detected !== asset.content_type) return reject('El binario no corresponde al tipo de imagen permitido');

    const sanitized = this.sanitizeMetadata(detected, bytes);
    if (!sanitized) {
      return reject('El formato contiene metadatos que no podemos eliminar con seguridad. Vuelve a cargar una copia JPEG o PNG sanitizada.');
    }
    let storedSha256 = dto.sha256.toLowerCase();
    let storedSize = dto.sizeBytes;
    const original = Buffer.from(bytes);
    if (!sanitized.equals(original)) {
      storedSha256 = createHash('sha256').update(sanitized).digest('hex');
      storedSize = sanitized.length;
      const checksum = Buffer.from(storedSha256, 'hex').toString('base64');
      const encryption = this.encryption();
      await this.s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: asset.object_key,
        Body: sanitized,
        ContentType: detected,
        ChecksumSHA256: checksum,
        ...encryption.command,
      }));
      await this.audit(subject, 'PET_CATALOG_PHOTO_METADATA_STRIPPED', assetId, {
        originalSizeBytes: dto.sizeBytes,
        sanitizedSizeBytes: storedSize,
      });
    }

    // El scan se consulta DESPUÉS de cualquier reescritura sanitizada para que una
    // copia modificada por el servidor nunca herede el resultado de malware del objeto anterior.
    const scanStatus = await this.scanStatus(bucket, asset.object_key);
    if (scanStatus === 'THREATS_FOUND') return reject('La fotografía fue bloqueada por seguridad');
    const ready = this.scanReady(scanStatus);
    await this.db.query(`UPDATE pet_case_media SET actual_sha256=$2,actual_size_bytes=$3,scan_status=$4,
      upload_status=$5,completed_at=CASE WHEN $5='READY' THEN now() ELSE completed_at END WHERE id=$1`, [
      assetId, storedSha256, storedSize, scanStatus, ready ? 'READY' : 'PENDING',
    ]);
    await this.audit(subject, 'PET_CATALOG_PHOTO_VALIDATED', assetId, {
      detectedContentType: detected,
      malwareScanStatus: scanStatus,
      metadataStripped: storedSha256 !== dto.sha256.toLowerCase(),
    });
    return { assetId, status: ready ? 'READY' : 'SCAN_PENDING', malwareScanStatus: scanStatus };
  }
}
