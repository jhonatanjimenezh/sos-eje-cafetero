import { Injectable } from '@nestjs/common';
import { DecryptCommand, GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  sign as nodeSign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CRYPTO_SUITE,
  RECEIPT_SIGNATURE_SUITE,
  type SyncCryptoConfigV1,
} from '@sos/secure-envelope';

export class SyncCryptoUnavailableError extends Error {}

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

function spkiFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

@Injectable()
export class SyncCryptoService {
  private readonly kms = new KMSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  private cachedConfig?: SyncCryptoConfigV1;

  private mode() {
    return (process.env.SYNC_KEY_MODE ?? 'LOCAL_PEM').toUpperCase();
  }

  private readPrivateKey(pathVar: string, inlineVar: string) {
    const inline = process.env[inlineVar];
    if (inline) return createPrivateKey(inline.replace(/\\n/g, '\n'));
    const path = process.env[pathVar];
    if (!path) throw new SyncCryptoUnavailableError(`${pathVar} no configurado`);
    try { return createPrivateKey(readFileSync(path, 'utf8')); }
    catch { throw new SyncCryptoUnavailableError(`No fue posible leer ${pathVar}`); }
  }

  private async kmsPublicKey(keyId: string): Promise<Uint8Array> {
    try {
      const result = await this.kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (!result.PublicKey) throw new Error('KMS public key missing');
      return result.PublicKey;
    } catch (error) {
      throw new SyncCryptoUnavailableError(`KMS GetPublicKey no disponible: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  async cryptoConfig(): Promise<SyncCryptoConfigV1> {
    if (this.cachedConfig && new Date(this.cachedConfig.configExpiresAt).getTime() > Date.now() + 60_000) return this.cachedConfig;

    let encryptionSpki: Uint8Array;
    let receiptSpki: Uint8Array;
    if (this.mode() === 'AWS_KMS') {
      const encryptionKey = process.env.SYNC_ENCRYPTION_KMS_KEY_ID;
      const receiptKey = process.env.SYNC_RECEIPT_SIGNING_KMS_KEY_ID;
      if (!encryptionKey || !receiptKey) throw new SyncCryptoUnavailableError('KMS keys de SecureEnvelope no configuradas');
      [encryptionSpki, receiptSpki] = await Promise.all([
        this.kmsPublicKey(encryptionKey),
        this.kmsPublicKey(receiptKey),
      ]);
    } else if (this.mode() === 'LOCAL_PEM') {
      const encryptionPrivate = this.readPrivateKey('SYNC_ENCRYPTION_PRIVATE_KEY_PATH', 'SYNC_ENCRYPTION_PRIVATE_KEY_PEM');
      const receiptPrivate = this.readPrivateKey('SYNC_RECEIPT_SIGNING_PRIVATE_KEY_PATH', 'SYNC_RECEIPT_SIGNING_PRIVATE_KEY_PEM');
      encryptionSpki = new Uint8Array(createPublicKey(encryptionPrivate).export({ type: 'spki', format: 'der' }));
      receiptSpki = new Uint8Array(createPublicKey(receiptPrivate).export({ type: 'spki', format: 'der' }));
    } else {
      throw new SyncCryptoUnavailableError(`SYNC_KEY_MODE no soportado: ${this.mode()}`);
    }

    const cacheDays = Number(process.env.SYNC_CONFIG_CACHE_DAYS ?? 90);
    this.cachedConfig = {
      version: 1,
      cryptoSuite: CRYPTO_SUITE,
      // IDs derivados del material público real: si una key cambia/regenera, cambia
      // automáticamente su ID y un cliente con la key anterior no la confunde con la nueva.
      encryptionKeyId: spkiFingerprint(encryptionSpki),
      encryptionPublicKeySpki: b64url(encryptionSpki),
      receiptSigningKeyId: spkiFingerprint(receiptSpki),
      receiptSignatureSuite: RECEIPT_SIGNATURE_SUITE,
      receiptSigningPublicKeySpki: b64url(receiptSpki),
      maxEnvelopeTtlSeconds: Number(process.env.SYNC_MAX_ENVELOPE_TTL_SECONDS ?? 259200),
      maxCiphertextBytes: Number(process.env.SYNC_MAX_CIPHERTEXT_BYTES ?? 12288),
      maxBatchSize: Number(process.env.SYNC_MAX_BATCH_SIZE ?? 4),
      configExpiresAt: new Date(Date.now() + cacheDays * 86400_000).toISOString(),
    };
    return this.cachedConfig;
  }

  async unwrapDataKey(wrapped: Uint8Array): Promise<Uint8Array> {
    if (this.mode() === 'AWS_KMS') {
      const keyId = process.env.SYNC_ENCRYPTION_KMS_KEY_ID;
      if (!keyId) throw new SyncCryptoUnavailableError('SYNC_ENCRYPTION_KMS_KEY_ID no configurado');
      try {
        const result = await this.kms.send(new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: wrapped,
          EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
        }));
        if (!result.Plaintext) throw new Error('KMS plaintext missing');
        return result.Plaintext;
      } catch (error: any) {
        if (['InvalidCiphertextException', 'IncorrectKeyException'].includes(error?.name)) throw error;
        throw new SyncCryptoUnavailableError(`KMS Decrypt no disponible: ${error?.name ?? 'unknown'}`);
      }
    }

    const privateKey = this.readPrivateKey('SYNC_ENCRYPTION_PRIVATE_KEY_PATH', 'SYNC_ENCRYPTION_PRIVATE_KEY_PEM');
    return new Uint8Array(privateDecrypt({
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, Buffer.from(wrapped)));
  }

  async signReceipt(payload: Uint8Array): Promise<string> {
    if (this.mode() === 'AWS_KMS') {
      const keyId = process.env.SYNC_RECEIPT_SIGNING_KMS_KEY_ID;
      if (!keyId) throw new SyncCryptoUnavailableError('SYNC_RECEIPT_SIGNING_KMS_KEY_ID no configurado');
      try {
        const result = await this.kms.send(new SignCommand({
          KeyId: keyId,
          Message: payload,
          MessageType: 'RAW',
          SigningAlgorithm: 'RSASSA_PSS_SHA_256',
        }));
        if (!result.Signature) throw new Error('KMS signature missing');
        return b64url(result.Signature);
      } catch (error: any) {
        throw new SyncCryptoUnavailableError(`KMS Sign no disponible: ${error?.name ?? 'unknown'}`);
      }
    }

    const privateKey = this.readPrivateKey('SYNC_RECEIPT_SIGNING_PRIVATE_KEY_PATH', 'SYNC_RECEIPT_SIGNING_PRIVATE_KEY_PEM');
    const signature = nodeSign('sha256', Buffer.from(payload), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    return signature.toString('base64url');
  }
}
