export type SecureEnvelopeKind = 'INCIDENT' | 'PERSON' | 'ANIMAL' | 'RESOURCE' | 'AFFECTED_PROFILE';

export interface SecureEnvelopeV1 {
  version: 1;
  messageId: string;
  emitterKeyId: string;
  emitterPublicKeySpki: string;
  createdAt: string;
  expiresAt: string;
  kind: SecureEnvelopeKind;
  cryptoSuite: string;
  serverKeyId: string;
  iv: string;
  wrappedKeyForServer: string;
  ciphertext: string;
  ciphertextSha256: string;
  signature: string;
}

export interface SecurePayloadV1<T = unknown> {
  version: 1;
  kind: SecureEnvelopeKind;
  data: T;
}

export type SyncReceiptStatus = 'ACCEPTED' | 'ALREADY_PROCESSED' | 'REJECTED';

export interface SyncReceiptV1 {
  version: 1;
  emitterKeyId: string;
  messageId: string;
  ciphertextSha256: string;
  status: SyncReceiptStatus;
  receivedAt: string;
  publicEntityId?: string;
  reasonCode?: string;
  receiptSigningKeyId: string;
  receiptSignatureSuite: string;
  serverSignature: string;
}

export interface SyncCryptoConfigV1 {
  version: 1;
  cryptoSuite: string;
  encryptionKeyId: string;
  encryptionPublicKeySpki: string;
  receiptSigningKeyId: string;
  receiptSignatureSuite: string;
  receiptSigningPublicKeySpki: string;
  maxEnvelopeTtlSeconds: number;
  maxCiphertextBytes: number;
  maxBatchSize: number;
  configExpiresAt: string;
}

export const SECURE_ENVELOPE_VERSION: 1;
export const CRYPTO_SUITE: string;
export const RECEIPT_SIGNATURE_SUITE: string;
export const SUPPORTED_KINDS: readonly SecureEnvelopeKind[];
export function canonicalize(value: unknown): string;
export function immutableHeaders(envelope: SecureEnvelopeV1): Record<string, unknown>;
export function aadString(envelope: SecureEnvelopeV1): string;
export function signingString(envelope: SecureEnvelopeV1): string;
export function receiptSigningString(receipt: SyncReceiptV1): string;
