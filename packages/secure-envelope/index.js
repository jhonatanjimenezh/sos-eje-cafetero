'use strict';

const SECURE_ENVELOPE_VERSION = 1;
const CRYPTO_SUITE = 'SEV1-RSA-OAEP-256+A256GCM+ECDSA-P256-SHA256';
const RECEIPT_SIGNATURE_SUITE = 'RSA-PSS-SHA256';
const SUPPORTED_KINDS = Object.freeze(['INCIDENT', 'PERSON', 'ANIMAL', 'RESOURCE', 'AFFECTED_PROFILE']);

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not allow non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

function immutableHeaders(envelope) {
  return {
    version: envelope.version,
    messageId: envelope.messageId,
    emitterKeyId: envelope.emitterKeyId,
    emitterPublicKeySpki: envelope.emitterPublicKeySpki,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    kind: envelope.kind,
    cryptoSuite: envelope.cryptoSuite,
    serverKeyId: envelope.serverKeyId,
    iv: envelope.iv,
    wrappedKeyForServer: envelope.wrappedKeyForServer,
  };
}

function aadString(envelope) {
  return canonicalize(immutableHeaders(envelope));
}

function signingString(envelope) {
  return canonicalize({
    headers: immutableHeaders(envelope),
    ciphertextSha256: envelope.ciphertextSha256,
  });
}

function receiptSigningString(receipt) {
  const { serverSignature: _serverSignature, ...unsigned } = receipt;
  return canonicalize(unsigned);
}

module.exports = {
  SECURE_ENVELOPE_VERSION,
  CRYPTO_SUITE,
  RECEIPT_SIGNATURE_SUITE,
  SUPPORTED_KINDS,
  canonicalize,
  immutableHeaders,
  aadString,
  signingString,
  receiptSigningString,
};
