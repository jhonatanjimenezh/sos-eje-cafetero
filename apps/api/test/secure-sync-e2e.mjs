import pg from 'pg';
import {
  aadString,
  CRYPTO_SUITE,
  receiptSigningString,
  signingString,
} from '../../../packages/secure-envelope/index.js';

const { Client } = pg;
const API = process.env.SYNC_E2E_API ?? 'http://127.0.0.1:3101/api/v1';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');
const encoder = new TextEncoder();

function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function fromB64url(value) { return Buffer.from(value, 'base64url'); }
async function sha(value) { return b64url(await crypto.subtle.digest('SHA-256', value)); }

async function config() {
  const response = await fetch(`${API}/sync/crypto-config`);
  if (!response.ok) throw new Error(`crypto-config HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function makeEmitter() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { pair, spki, keyId: await sha(spki) };
}

async function makeEnvelope(cfg, emitter, suffix) {
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 3600_000);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const serverPublic = await crypto.subtle.importKey(
    'spki', fromB64url(cfg.encryptionPublicKeySpki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
  );
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverPublic, raw);
  raw.fill(0);

  const envelope = {
    version: 1,
    messageId,
    emitterKeyId: emitter.keyId,
    emitterPublicKeySpki: b64url(emitter.spki),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    kind: 'INCIDENT',
    cryptoSuite: CRYPTO_SUITE,
    serverKeyId: cfg.encryptionKeyId,
    iv: b64url(iv),
    wrappedKeyForServer: b64url(wrapped),
    ciphertext: '',
    ciphertextSha256: '',
    signature: '',
  };
  const payload = {
    version: 1,
    kind: 'INCIDENT',
    data: {
      type: 'WATER_NEED',
      priority: 'MEDIUM',
      lat: 5.067 + Math.random() / 10000,
      lng: -75.517 - Math.random() / 10000,
      address: `Synthetic address ${suffix}`,
      description: `Secure relay synthetic ${suffix}`,
      peopleAffected: 1,
      peopleTrapped: 0,
      contactPhone: '+570000000000',
    },
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aadString(envelope)), tagLength: 128 },
    dataKey,
    encoder.encode(JSON.stringify(payload)),
  );
  envelope.ciphertext = b64url(ciphertext);
  envelope.ciphertextSha256 = await sha(ciphertext);
  envelope.signature = b64url(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, emitter.pair.privateKey, encoder.encode(signingString(envelope)),
  ));
  return envelope;
}

async function post(envelopes) {
  const response = await fetch(`${API}/sync/envelopes/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelopes }),
  });
  if (!response.ok) throw new Error(`batch HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function verifyReceipt(cfg, receipt, envelope) {
  if (receipt.messageId !== envelope.messageId || receipt.ciphertextSha256 !== envelope.ciphertextSha256) {
    throw new Error('receipt is not bound to envelope');
  }
  const key = await crypto.subtle.importKey(
    'spki', fromB64url(cfg.receiptSigningPublicKeySpki), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'RSA-PSS', saltLength: 32 }, key, fromB64url(receipt.serverSignature), encoder.encode(receiptSigningString(receipt)),
  );
  if (!ok) throw new Error('server receipt signature invalid');
}

function mutateBase64url(value) {
  const bytes = fromB64url(value);
  if (!bytes.length) throw new Error('cannot mutate empty base64url value');
  const index = Math.floor(bytes.length / 2);
  bytes[index] ^= 0x01;
  return b64url(bytes);
}

const cfg = await config();
if (cfg.cryptoSuite !== CRYPTO_SUITE) throw new Error(`suite mismatch: ${cfg.cryptoSuite}`);
const emitter = await makeEmitter();
const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

try {
  const valid = await makeEnvelope(cfg, emitter, `valid-${Date.now()}`);
  const accepted = await post([valid]);
  const acceptedReceipt = accepted.receipts[0];
  if (acceptedReceipt.status !== 'ACCEPTED') throw new Error(`expected ACCEPTED, got ${acceptedReceipt.status}`);
  await verifyReceipt(cfg, acceptedReceipt, valid);

  for (let i = 0; i < 9; i += 1) {
    const replay = await post([valid]);
    if (replay.receipts[0].status !== 'ALREADY_PROCESSED') throw new Error(`replay ${i} was not idempotent`);
    await verifyReceipt(cfg, replay.receipts[0], valid);
  }
  const count = await db.query(`SELECT count(*)::int count FROM incidents
    WHERE source='SECURE_RELAY' AND source_idempotency_key=$1`, [`secure:${valid.messageId}`]);
  if (count.rows[0].count !== 1) throw new Error(`10 deliveries created ${count.rows[0].count} incidents`);

  const digestTamperBase = await makeEnvelope(cfg, emitter, 'digest-tamper');
  const digestTampered = { ...digestTamperBase, ciphertext: mutateBase64url(digestTamperBase.ciphertext) };
  const digestResult = await post([digestTampered]);
  if (digestResult.receipts[0].status !== 'REJECTED' || digestResult.receipts[0].reasonCode !== 'CIPHERTEXT_DIGEST_MISMATCH') {
    throw new Error(`ciphertext tampering not rejected correctly: ${JSON.stringify(digestResult.receipts[0])}`);
  }
  await verifyReceipt(cfg, digestResult.receipts[0], digestTampered);

  const signatureBase = await makeEnvelope(cfg, emitter, 'signature-tamper');
  const signatureTampered = { ...signatureBase, signature: mutateBase64url(signatureBase.signature) };
  const signatureResult = await post([signatureTampered]);
  if (signatureResult.receipts[0].status !== 'REJECTED' || signatureResult.receipts[0].reasonCode !== 'SIGNATURE_INVALID') {
    throw new Error(`signature tampering not rejected correctly: ${JSON.stringify(signatureResult.receipts[0])}`);
  }

  const mixedValid = await makeEnvelope(cfg, emitter, 'mixed-valid');
  const headerBase = await makeEnvelope(cfg, emitter, 'header-tamper');
  const headerTampered = { ...headerBase, expiresAt: new Date(Date.parse(headerBase.expiresAt) - 30_000).toISOString() };
  const mixed = await post([mixedValid, headerTampered]);
  const mixedAccepted = mixed.receipts.find((r) => r.messageId === mixedValid.messageId);
  const mixedRejected = mixed.receipts.find((r) => r.messageId === headerTampered.messageId);
  if (mixedAccepted?.status !== 'ACCEPTED') throw new Error('valid envelope in mixed batch was not accepted');
  if (mixedRejected?.status !== 'REJECTED' || mixedRejected.reasonCode !== 'SIGNATURE_INVALID') {
    throw new Error(`tampered envelope in mixed batch not isolated: ${JSON.stringify(mixedRejected)}`);
  }
  await verifyReceipt(cfg, mixedAccepted, mixedValid);
  await verifyReceipt(cfg, mixedRejected, headerTampered);

  for (const rejected of [digestTampered, signatureTampered, headerTampered]) {
    const r = await db.query(`SELECT count(*)::int count FROM incidents
      WHERE source='SECURE_RELAY' AND source_idempotency_key=$1`, [`secure:${rejected.messageId}`]);
    if (r.rows[0].count !== 0) throw new Error(`rejected envelope ${rejected.messageId} created a domain entity`);
  }

  console.log('secure sync E2E passed: encryption, signatures, replay, tampering, mixed batch, signed receipts');
} finally {
  await db.end();
}
