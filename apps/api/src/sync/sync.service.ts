import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  verify as nodeVerify,
} from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import {
  aadString,
  CRYPTO_SUITE,
  receiptSigningString,
  RECEIPT_SIGNATURE_SUITE,
  signingString,
  type SecureEnvelopeV1,
  type SyncReceiptV1,
} from '@sos/secure-envelope';
import { PG_POOL } from '../database/database.module';
import { CreateIncidentDto } from '../incidents/dto';
import { IncidentsService } from '../incidents/incidents.service';
import { SecureEnvelopeBatchDto, SecureEnvelopeDto } from './dto';
import { SyncCryptoService, SyncCryptoUnavailableError } from './sync.crypto';

class EnvelopeRejected extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function digestB64url(value: Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly incidents: IncidentsService,
    private readonly crypto: SyncCryptoService,
  ) {}

  private enabled() {
    return process.env.FEATURE_SECURE_ENVELOPE === 'true';
  }

  private assertEnabled() {
    if (!this.enabled()) throw new ServiceUnavailableException('SecureEnvelope está deshabilitado por feature flag');
  }

  async cryptoConfig() {
    this.assertEnabled();
    try { return await this.crypto.cryptoConfig(); }
    catch (error) {
      if (error instanceof SyncCryptoUnavailableError) throw new ServiceUnavailableException('Material criptográfico de sincronización no disponible');
      throw error;
    }
  }

  private validateMetadata(envelope: SecureEnvelopeV1, config: Awaited<ReturnType<SyncCryptoService['cryptoConfig']>>) {
    const encodedEnvelope = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (encodedEnvelope > 20 * 1024) throw new EnvelopeRejected('ENVELOPE_TOO_LARGE');
    if (envelope.version !== 1 || envelope.cryptoSuite !== CRYPTO_SUITE) throw new EnvelopeRejected('UNSUPPORTED_CRYPTO_SUITE');
    if (envelope.serverKeyId !== config.encryptionKeyId) throw new EnvelopeRejected('SERVER_KEY_ID_UNKNOWN');
    if (envelope.kind !== 'INCIDENT') throw new EnvelopeRejected('KIND_NOT_ENABLED');

    const createdAt = Date.parse(envelope.createdAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    const now = Date.now();
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new EnvelopeRejected('TIMESTAMP_INVALID');
    if (createdAt > now + 10 * 60_000) throw new EnvelopeRejected('CREATED_AT_IN_FUTURE');
    if (expiresAt <= now) throw new EnvelopeRejected('ENVELOPE_EXPIRED');
    if (expiresAt <= createdAt || expiresAt - createdAt > config.maxEnvelopeTtlSeconds * 1000) throw new EnvelopeRejected('TTL_INVALID');

    const ciphertext = fromB64url(envelope.ciphertext);
    if (!ciphertext.length || ciphertext.length > config.maxCiphertextBytes) throw new EnvelopeRejected('CIPHERTEXT_TOO_LARGE');
    const iv = fromB64url(envelope.iv);
    if (iv.length !== 12) throw new EnvelopeRejected('IV_INVALID');
    return { ciphertext, iv };
  }

  private verifyEmitterSignature(envelope: SecureEnvelopeV1, ciphertext: Buffer) {
    if (digestB64url(ciphertext) !== envelope.ciphertextSha256) throw new EnvelopeRejected('CIPHERTEXT_DIGEST_MISMATCH');

    let publicKey;
    const publicSpki = fromB64url(envelope.emitterPublicKeySpki);
    if (digestB64url(publicSpki) !== envelope.emitterKeyId) throw new EnvelopeRejected('EMITTER_KEY_ID_MISMATCH');
    try { publicKey = createPublicKey({ key: publicSpki, format: 'der', type: 'spki' }); }
    catch { throw new EnvelopeRejected('EMITTER_PUBLIC_KEY_INVALID'); }
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new EnvelopeRejected('EMITTER_KEY_ALGORITHM_INVALID');
    }

    const signature = fromB64url(envelope.signature);
    if (signature.length !== 64) throw new EnvelopeRejected('SIGNATURE_FORMAT_INVALID');
    const valid = nodeVerify(
      'sha256',
      Buffer.from(signingString(envelope), 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    if (!valid) throw new EnvelopeRejected('SIGNATURE_INVALID');
  }

  private async assertEmitterActiveAndRegister(envelope: SecureEnvelopeV1) {
    const key = await this.db.query('SELECT revoked_at FROM secure_device_keys WHERE emitter_key_id=$1', [envelope.emitterKeyId]);
    if (key.rows[0]?.revoked_at) throw new EnvelopeRejected('EMITTER_KEY_REVOKED');
    await this.db.query(`INSERT INTO secure_device_keys(emitter_key_id,public_key_spki_sha256)
      VALUES($1,$2) ON CONFLICT(emitter_key_id) DO UPDATE SET last_seen_at=now()`, [envelope.emitterKeyId, envelope.emitterKeyId]);
  }

  private async decryptPayload(envelope: SecureEnvelopeV1, ciphertext: Buffer, iv: Buffer) {
    let dataKey: Uint8Array;
    try { dataKey = await this.crypto.unwrapDataKey(fromB64url(envelope.wrappedKeyForServer)); }
    catch (error: any) {
      if (error instanceof SyncCryptoUnavailableError) throw error;
      if (['InvalidCiphertextException', 'IncorrectKeyException'].includes(error?.name)) throw new EnvelopeRejected('WRAPPED_KEY_INVALID');
      throw new EnvelopeRejected('WRAPPED_KEY_INVALID');
    }
    if (dataKey.length !== 32) throw new EnvelopeRejected('DATA_KEY_INVALID');
    if (ciphertext.length < 17) throw new EnvelopeRejected('CIPHERTEXT_INVALID');

    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(dataKey), iv);
      decipher.setAAD(Buffer.from(aadString(envelope), 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      throw new EnvelopeRejected('AUTHENTICATION_FAILED');
    } finally {
      dataKey.fill(0);
    }
  }

  private async incidentFromPlaintext(envelope: SecureEnvelopeV1, plaintext: Buffer): Promise<CreateIncidentDto> {
    let payload: any;
    try { payload = JSON.parse(plaintext.toString('utf8')); }
    catch { throw new EnvelopeRejected('PAYLOAD_JSON_INVALID'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new EnvelopeRejected('PAYLOAD_INVALID');
    const keys = Object.keys(payload).sort().join(',');
    if (keys !== 'data,kind,version' || payload.version !== 1 || payload.kind !== envelope.kind || typeof payload.data !== 'object') {
      throw new EnvelopeRejected('PAYLOAD_SCHEMA_INVALID');
    }

    const dto = plainToInstance(CreateIncidentDto, payload.data);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (errors.length) throw new EnvelopeRejected('INCIDENT_SCHEMA_INVALID');
    return dto;
  }

  private async signedReceipt(
    input: Omit<SyncReceiptV1, 'receiptSigningKeyId' | 'receiptSignatureSuite' | 'serverSignature' | 'emitterAuthenticated'> & {
      emitterAuthenticated?: boolean;
    },
  ): Promise<SyncReceiptV1> {
    const config = await this.crypto.cryptoConfig();
    const receipt: SyncReceiptV1 = {
      ...input,
      emitterAuthenticated: input.emitterAuthenticated ?? true,
      receiptSigningKeyId: config.receiptSigningKeyId,
      receiptSignatureSuite: RECEIPT_SIGNATURE_SUITE,
      serverSignature: '',
    };
    receipt.serverSignature = await this.crypto.signReceipt(Buffer.from(receiptSigningString(receipt), 'utf8'));
    return receipt;
  }

  private async saveReceipt(client: PoolClient | Pool, receipt: SyncReceiptV1) {
    await client.query(`INSERT INTO secure_sync_receipts(
      emitter_key_id,message_id,ciphertext_sha256,status,public_entity_id,reason_code,receipt_signing_key_id,server_signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
      receipt.emitterKeyId,
      receipt.messageId,
      receipt.ciphertextSha256,
      receipt.status,
      receipt.publicEntityId ?? null,
      receipt.reasonCode ?? null,
      receipt.receiptSigningKeyId,
      receipt.serverSignature,
    ]);
  }

  private async replayReceipt(row: any): Promise<SyncReceiptV1> {
    return this.signedReceipt({
      version: 1,
      emitterKeyId: row.emitter_key_id,
      messageId: row.message_id,
      ciphertextSha256: row.ciphertext_sha256,
      status: row.processing_status === 'ACCEPTED' ? 'ALREADY_PROCESSED' : 'REJECTED',
      receivedAt: new Date().toISOString(),
      publicEntityId: row.public_entity_id ?? undefined,
      reasonCode: row.rejection_code ?? undefined,
    });
  }

  private async persistAuthenticatedRejection(envelope: SecureEnvelopeV1, code: string): Promise<SyncReceiptV1> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const namespace = `${envelope.emitterKeyId}:${envelope.messageId}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [namespace]);
      const existing = await client.query(
        'SELECT * FROM secure_sync_messages WHERE emitter_key_id=$1 AND message_id=$2',
        [envelope.emitterKeyId, envelope.messageId],
      );

      if (existing.rowCount) {
        const row = existing.rows[0];
        let receipt: SyncReceiptV1;
        if (row.ciphertext_sha256 !== envelope.ciphertextSha256) {
          receipt = await this.signedReceipt({
            version: 1,
            emitterKeyId: envelope.emitterKeyId,
            messageId: envelope.messageId,
            ciphertextSha256: envelope.ciphertextSha256,
            status: 'REJECTED',
            receivedAt: new Date().toISOString(),
            reasonCode: 'MESSAGE_ID_DIGEST_CONFLICT',
          });
        } else {
          receipt = await this.replayReceipt(row);
        }
        await this.saveReceipt(client, receipt);
        await client.query('COMMIT');
        return receipt;
      }

      await client.query(`INSERT INTO secure_sync_messages(
        emitter_key_id,message_id,ciphertext_sha256,server_key_id,kind,processing_status,rejection_code,created_at,expires_at,processed_at)
        VALUES($1,$2,$3,$4,$5,'REJECTED',$6,$7,$8,now())`, [
        envelope.emitterKeyId,
        envelope.messageId,
        envelope.ciphertextSha256,
        envelope.serverKeyId,
        envelope.kind,
        code,
        envelope.createdAt,
        envelope.expiresAt,
      ]);
      const receipt = await this.signedReceipt({
        version: 1,
        emitterKeyId: envelope.emitterKeyId,
        messageId: envelope.messageId,
        ciphertextSha256: envelope.ciphertextSha256,
        status: 'REJECTED',
        receivedAt: new Date().toISOString(),
        reasonCode: code,
      });
      await this.saveReceipt(client, receipt);
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  private async ephemeralRejectedReceipt(envelope: SecureEnvelopeV1, code: string): Promise<SyncReceiptV1> {
    // No reserva messageId: antes de verificar la firma, un relay no puede ocupar el
    // namespace de un emisor legítimo enviando primero una copia alterada. El flag
    // firmado evita que un relay use este diagnóstico para provocar purga local.
    return this.signedReceipt({
      version: 1,
      emitterKeyId: envelope.emitterKeyId,
      messageId: envelope.messageId,
      ciphertextSha256: envelope.ciphertextSha256,
      status: 'REJECTED',
      emitterAuthenticated: false,
      receivedAt: new Date().toISOString(),
      reasonCode: code,
    });
  }

  private async recordMetric(receipt: SyncReceiptV1, latencyMs: number) {
    try {
      const accepted = receipt.status === 'ACCEPTED' ? 1 : 0;
      const replayed = receipt.status === 'ALREADY_PROCESSED' ? 1 : 0;
      const rejected = receipt.status === 'REJECTED' ? 1 : 0;
      await this.db.query(`INSERT INTO secure_sync_metrics(minute_bucket,batches,accepted,replayed,rejected,total_latency_ms)
        VALUES(date_trunc('minute',now()),0,$1,$2,$3,$4)
        ON CONFLICT(minute_bucket) DO UPDATE SET
          accepted=secure_sync_metrics.accepted+excluded.accepted,
          replayed=secure_sync_metrics.replayed+excluded.replayed,
          rejected=secure_sync_metrics.rejected+excluded.rejected,
          total_latency_ms=secure_sync_metrics.total_latency_ms+excluded.total_latency_ms`,
      [accepted,replayed,rejected,latencyMs]);
    } catch {
      // Telemetría jamás bloquea un reporte de emergencia.
    }
  }

  private async processOne(dto: SecureEnvelopeDto): Promise<SyncReceiptV1> {
    const started = Date.now();
    const envelope = dto as SecureEnvelopeV1;
    let emitterAuthenticated = false;
    try {
      const config = await this.crypto.cryptoConfig();
      const { ciphertext, iv } = this.validateMetadata(envelope, config);
      this.verifyEmitterSignature(envelope, ciphertext);
      emitterAuthenticated = true;
      await this.assertEmitterActiveAndRegister(envelope);

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const namespace = `${envelope.emitterKeyId}:${envelope.messageId}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [namespace]);
        const existing = await client.query(
          'SELECT * FROM secure_sync_messages WHERE emitter_key_id=$1 AND message_id=$2',
          [envelope.emitterKeyId, envelope.messageId],
        );
        if (existing.rowCount) {
          const row = existing.rows[0];
          if (row.ciphertext_sha256 !== envelope.ciphertextSha256) {
            const receipt = await this.signedReceipt({
              version: 1,
              emitterKeyId: envelope.emitterKeyId,
              messageId: envelope.messageId,
              ciphertextSha256: envelope.ciphertextSha256,
              status: 'REJECTED',
              receivedAt: new Date().toISOString(),
              reasonCode: 'MESSAGE_ID_DIGEST_CONFLICT',
            });
            await this.saveReceipt(client, receipt);
            await client.query('COMMIT');
            await this.recordMetric(receipt, Date.now() - started);
            return receipt;
          }
          const receipt = await this.replayReceipt(row);
          await this.saveReceipt(client, receipt);
          await client.query('COMMIT');
          await this.recordMetric(receipt, Date.now() - started);
          return receipt;
        }

        await client.query(`INSERT INTO secure_sync_messages(
          emitter_key_id,message_id,ciphertext_sha256,server_key_id,kind,processing_status,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,'PROCESSING',$6,$7)`, [
          envelope.emitterKeyId,
          envelope.messageId,
          envelope.ciphertextSha256,
          envelope.serverKeyId,
          envelope.kind,
          envelope.createdAt,
          envelope.expiresAt,
        ]);

        const plaintext = await this.decryptPayload(envelope, ciphertext, iv);
        let incident: CreateIncidentDto;
        try {
          incident = await this.incidentFromPlaintext(envelope, plaintext);
        } finally {
          plaintext.fill(0);
        }

        // Idempotencia de dominio también incluye emitterKeyId: un peer que observe el
        // UUID no puede ocupar el namespace con otra clave y bloquear al emisor original.
        const domainIdempotency = `secure:${envelope.emitterKeyId}:${envelope.messageId}`;
        const entity = await this.incidents.create(incident, 'SECURE_RELAY', domainIdempotency);
        const receipt = await this.signedReceipt({
          version: 1,
          emitterKeyId: envelope.emitterKeyId,
          messageId: envelope.messageId,
          ciphertextSha256: envelope.ciphertextSha256,
          status: 'ACCEPTED',
          receivedAt: new Date().toISOString(),
          publicEntityId: entity.public_id,
        });
        await client.query(`UPDATE secure_sync_messages SET processing_status='ACCEPTED',public_entity_id=$3,
          processed_at=now() WHERE emitter_key_id=$1 AND message_id=$2`, [
          envelope.emitterKeyId,
          envelope.messageId,
          entity.public_id,
        ]);
        await this.saveReceipt(client, receipt);
        await client.query('COMMIT');
        await this.recordMetric(receipt, Date.now() - started);
        return receipt;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof SyncCryptoUnavailableError) throw error;
      if (error instanceof EnvelopeRejected) {
        const receipt = emitterAuthenticated
          ? await this.persistAuthenticatedRejection(envelope, error.code)
          : await this.ephemeralRejectedReceipt(envelope, error.code);
        await this.recordMetric(receipt, Date.now() - started);
        return receipt;
      }
      throw error;
    }
  }

  async processBatch(dto: SecureEnvelopeBatchDto) {
    this.assertEnabled();
    const maxBatch = Number(process.env.SYNC_MAX_BATCH_SIZE ?? 4);
    if (dto.envelopes.length > maxBatch) throw new HttpException('Lote demasiado grande', HttpStatus.PAYLOAD_TOO_LARGE);
    const started = Date.now();
    try {
      const receipts: SyncReceiptV1[] = [];
      for (const envelope of dto.envelopes) receipts.push(await this.processOne(envelope));
      try {
        await this.db.query(`INSERT INTO secure_sync_metrics(minute_bucket,batches,total_latency_ms)
          VALUES(date_trunc('minute',now()),1,$1)
          ON CONFLICT(minute_bucket) DO UPDATE SET batches=secure_sync_metrics.batches+1`, [Date.now()-started]);
      } catch {}
      return { receipts };
    } catch (error) {
      if (error instanceof SyncCryptoUnavailableError) throw new ServiceUnavailableException('Proveedor criptográfico temporalmente no disponible');
      throw error;
    }
  }
}
