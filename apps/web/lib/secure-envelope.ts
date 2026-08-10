import {
  aadString,
  CRYPTO_SUITE,
  receiptSigningString,
  RECEIPT_SIGNATURE_SUITE,
  SECURE_ENVELOPE_VERSION,
  signingString,
  type SecureEnvelopeKind,
  type SecureEnvelopeV1,
  type SyncCryptoConfigV1,
  type SyncReceiptV1,
} from '@sos/secure-envelope';
import {
  getCachedSyncConfig,
  getDeviceKeyRecord,
  saveDeviceKeyRecord,
  saveSyncConfig,
  type DeviceKeyRecord,
} from './offline-db';

const DEFAULT_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const encoder = new TextEncoder();
const MAX_CLIENT_TTL_SECONDS = 72 * 60 * 60;

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function sha256Base64Url(input: ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(input)));
}

async function importRsaOaepPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBuffer(spki),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
}

async function importRsaPssPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBuffer(spki),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function importEmitterPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBuffer(spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

async function createDeviceKeyRecord(): Promise<DeviceKeyRecord> {
  // Preferimos una private CryptoKey no exportable. Algunos motores requieren una
  // generación exportable para poder extraer el SPKI público; en ese caso la private
  // se exporta solo en memoria e inmediatamente se reimporta como no exportable.
  try {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const publicSpki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const keyId = await sha256Base64Url(publicSpki);
    return {
      id: 'device-signing-v1',
      keyId,
      publicKeySpki: bytesToBase64Url(publicSpki),
      privateKey: pair.privateKey,
      createdAt: new Date().toISOString(),
    };
  } catch {
    const exportable = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const [publicSpki, privatePkcs8] = await Promise.all([
      crypto.subtle.exportKey('spki', exportable.publicKey),
      crypto.subtle.exportKey('pkcs8', exportable.privateKey),
    ]);
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privatePkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    new Uint8Array(privatePkcs8).fill(0);
    const keyId = await sha256Base64Url(publicSpki);
    return {
      id: 'device-signing-v1',
      keyId,
      publicKeySpki: bytesToBase64Url(publicSpki),
      privateKey,
      createdAt: new Date().toISOString(),
    };
  }
}

export async function ensureDeviceSigningKey(): Promise<DeviceKeyRecord> {
  const current = await getDeviceKeyRecord();
  if (current?.privateKey instanceof CryptoKey && !current.privateKey.extractable) return current;

  const created = await createDeviceKeyRecord();
  try {
    await saveDeviceKeyRecord(created);
    const persisted = await getDeviceKeyRecord();
    if (!persisted?.privateKey || persisted.privateKey.extractable) {
      throw new Error('El navegador no conservó la clave privada con las propiedades de seguridad requeridas.');
    }
    return persisted;
  } catch (error) {
    throw new Error(
      `Este navegador no permite almacenar de forma segura la clave de firma offline. No se guardará información sensible localmente. ${
        error instanceof Error ? error.message : ''
      }`.trim(),
    );
  }
}

function validateCryptoConfig(config: SyncCryptoConfigV1) {
  if (config.version !== 1 || config.cryptoSuite !== CRYPTO_SUITE) throw new Error('Configuración criptográfica incompatible.');
  if (config.receiptSignatureSuite !== RECEIPT_SIGNATURE_SUITE) throw new Error('Suite de firma de recibos incompatible.');
  if (!config.encryptionKeyId || !config.encryptionPublicKeySpki || !config.receiptSigningPublicKeySpki) {
    throw new Error('Configuración criptográfica incompleta.');
  }
  if (config.maxBatchSize < 1 || config.maxCiphertextBytes < 1024 || config.maxEnvelopeTtlSeconds < 60) {
    throw new Error('Límites criptográficos del servidor inválidos.');
  }
}

export async function getServerCryptoConfig(apiBase = DEFAULT_API): Promise<SyncCryptoConfigV1> {
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const response = await fetch(`${apiBase}/sync/crypto-config`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = (await response.json()) as SyncCryptoConfigV1;
      validateCryptoConfig(config);
      await saveSyncConfig(config);
      return config;
    } catch (error) {
      const cached = await getCachedSyncConfig();
      if (cached && new Date(cached.config.configExpiresAt).getTime() > Date.now()) {
        validateCryptoConfig(cached.config);
        return cached.config;
      }
      throw new Error(
        `No existe una configuración criptográfica válida para trabajar offline. Conecta este dispositivo al servidor al menos una vez. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      );
    }
  }

  const cached = await getCachedSyncConfig();
  if (!cached || new Date(cached.config.configExpiresAt).getTime() <= Date.now()) {
    throw new Error('La configuración criptográfica offline no existe o expiró. No se almacenará PII en plaintext.');
  }
  validateCryptoConfig(cached.config);
  return cached.config;
}

export async function prepareSecureOfflineMode(apiBase = DEFAULT_API): Promise<void> {
  await Promise.all([getServerCryptoConfig(apiBase), ensureDeviceSigningKey()]);
}

export async function createSecureEnvelope<T>(
  kind: SecureEnvelopeKind,
  data: T,
  apiBase = DEFAULT_API,
): Promise<SecureEnvelopeV1> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto no está disponible; no se guardará PII offline.');

  const [config, device] = await Promise.all([getServerCryptoConfig(apiBase), ensureDeviceSigningKey()]);
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  const ttlSeconds = Math.min(MAX_CLIENT_TTL_SECONDS, config.maxEnvelopeTtlSeconds);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const serverPublic = await importRsaOaepPublicKey(config.encryptionPublicKeySpki);

  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverPublic, rawDataKey);
  new Uint8Array(rawDataKey).fill(0);

  const skeleton: SecureEnvelopeV1 = {
    version: SECURE_ENVELOPE_VERSION,
    messageId,
    emitterKeyId: device.keyId,
    emitterPublicKeySpki: device.publicKeySpki,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    kind,
    cryptoSuite: CRYPTO_SUITE,
    serverKeyId: config.encryptionKeyId,
    iv: bytesToBase64Url(iv),
    wrappedKeyForServer: bytesToBase64Url(wrappedKey),
    ciphertext: '',
    ciphertextSha256: '',
    signature: '',
  };

  const payload = encoder.encode(JSON.stringify({ version: 1, kind, data }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aadString(skeleton)), tagLength: 128 },
    dataKey,
    payload,
  );
  if (ciphertext.byteLength > config.maxCiphertextBytes) throw new Error('El reporte excede el tamaño máximo para relay offline.');

  skeleton.ciphertext = bytesToBase64Url(ciphertext);
  skeleton.ciphertextSha256 = await sha256Base64Url(ciphertext);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.privateKey,
    encoder.encode(signingString(skeleton)),
  );
  skeleton.signature = bytesToBase64Url(signature);
  return skeleton;
}

export async function verifyEnvelopePublicIntegrity(envelope: SecureEnvelopeV1): Promise<void> {
  if (envelope.version !== 1 || envelope.cryptoSuite !== CRYPTO_SUITE) throw new Error('UNSUPPORTED_ENVELOPE');
  const now = Date.now();
  if (new Date(envelope.expiresAt).getTime() <= now) throw new Error('ENVELOPE_EXPIRED');
  if (new Date(envelope.createdAt).getTime() > now + 10 * 60 * 1000) throw new Error('ENVELOPE_FROM_FUTURE');

  const ciphertext = base64UrlToBuffer(envelope.ciphertext);
  const digest = await sha256Base64Url(ciphertext);
  if (digest !== envelope.ciphertextSha256) throw new Error('CIPHERTEXT_DIGEST_MISMATCH');

  const publicSpki = base64UrlToBuffer(envelope.emitterPublicKeySpki);
  const emitterKeyId = await sha256Base64Url(publicSpki);
  if (emitterKeyId !== envelope.emitterKeyId) throw new Error('EMITTER_KEY_ID_MISMATCH');

  const publicKey = await importEmitterPublicKey(envelope.emitterPublicKeySpki);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64UrlToBuffer(envelope.signature),
    encoder.encode(signingString(envelope)),
  );
  if (!ok) throw new Error('SIGNATURE_INVALID');
}

export async function verifyServerReceipt(
  receipt: SyncReceiptV1,
  expected?: SecureEnvelopeV1,
  apiBase = DEFAULT_API,
): Promise<void> {
  if (receipt.version !== 1 || receipt.receiptSignatureSuite !== RECEIPT_SIGNATURE_SUITE) {
    throw new Error('RECEIPT_SUITE_INVALID');
  }
  if (
    expected && (
      receipt.emitterKeyId !== expected.emitterKeyId ||
      receipt.messageId !== expected.messageId ||
      receipt.ciphertextSha256 !== expected.ciphertextSha256
    )
  ) {
    throw new Error('RECEIPT_BINDING_MISMATCH');
  }
  const config = await getServerCryptoConfig(apiBase);
  if (receipt.receiptSigningKeyId !== config.receiptSigningKeyId) throw new Error('RECEIPT_KEY_ID_UNKNOWN');
  const publicKey = await importRsaPssPublicKey(config.receiptSigningPublicKeySpki);
  const ok = await crypto.subtle.verify(
    { name: 'RSA-PSS', saltLength: 32 },
    publicKey,
    base64UrlToBuffer(receipt.serverSignature),
    encoder.encode(receiptSigningString(receipt)),
  );
  if (!ok) throw new Error('RECEIPT_SIGNATURE_INVALID');
}
