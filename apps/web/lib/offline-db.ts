import type { SecureEnvelopeV1, SyncCryptoConfigV1, SyncReceiptV1 } from '@sos/secure-envelope';

export type IncidentPayload = {
  type: string;
  priority?: string;
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  neighborhood?: string;
  description?: string;
  peopleAffected?: number;
  peopleTrapped?: number;
  contactPhone?: string;
  buildingDamageLevel?: string;
};

export type PendingEnvelope = {
  messageId: string;
  ciphertextSha256: string;
  createdAt: string;
  expiresAt: string;
  status: 'PENDING' | 'FAILED';
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  envelope: SecureEnvelopeV1;
};

export type RelayEnvelope = {
  relayKey: string;
  emitterKeyId: string;
  messageId: string;
  ciphertextSha256: string;
  createdAt: string;
  expiresAt: string;
  receivedAt: string;
  envelope: SecureEnvelopeV1;
};

export type SeenMessage = {
  relayKey: string;
  emitterKeyId: string;
  messageId: string;
  ciphertextSha256: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type StoredReceipt = SyncReceiptV1 & { relayKey: string };

export type DeviceKeyRecord = {
  id: 'device-signing-v1';
  keyId: string;
  publicKeySpki: string;
  privateKey: CryptoKey;
  createdAt: string;
};

export type CachedSyncConfig = {
  id: 'sync-crypto-config-v1';
  config: SyncCryptoConfigV1;
  cachedAt: string;
};

const DB_NAME = 'sos-eje-cafetero';
const DB_VERSION = 3;
const OUTBOX = 'outbox';
const RELAY_QUEUE = 'relay_queue';
const SEEN_MESSAGES = 'seen_messages';
const RECEIPTS = 'sync_receipts';
const DEVICE_KEYS = 'device_keys';
const SYNC_CONFIG = 'sync_config';
const MAX_OUTBOX_MESSAGES = 200;
const MAX_RELAY_MESSAGES = 500;

export function relayIdentity(emitterKeyId: string, messageId: string): string {
  return `${emitterKeyId}:${messageId}`;
}

function requireIndexedDb() {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB no está disponible en este dispositivo.');
}

export function openOfflineDb(): Promise<IDBDatabase> {
  requireIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir la base offline.'));
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      // DB v1 almacenaba PendingIncident.payload con GPS/teléfono/descripción en claro.
      // No hacemos una migración silenciosa insegura: al activar SecureEnvelope se descarta
      // esa cola legacy y solo se permite persistir ciphertext a partir de v2.
      if (oldVersion < 2 && db.objectStoreNames.contains(OUTBOX)) db.deleteObjectStore(OUTBOX);

      // V3 endurece el namespace relay para que un peer no pueda ocupar el UUID de otro
      // emisor. Esta rama aún no se ha habilitado para datos reales; descartamos stores
      // relay/receipt pre-productivos en lugar de conservar un keyPath ambiguo.
      if (oldVersion < 3) {
        for (const store of [RELAY_QUEUE, SEEN_MESSAGES, RECEIPTS]) {
          if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
        }
      }

      if (!db.objectStoreNames.contains(OUTBOX)) {
        const store = db.createObjectStore(OUTBOX, { keyPath: 'messageId' });
        store.createIndex('status_createdAt', ['status', 'createdAt'], { unique: false });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(RELAY_QUEUE)) {
        const store = db.createObjectStore(RELAY_QUEUE, { keyPath: 'relayKey' });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
        store.createIndex('receivedAt', 'receivedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(SEEN_MESSAGES)) db.createObjectStore(SEEN_MESSAGES, { keyPath: 'relayKey' });
      if (!db.objectStoreNames.contains(RECEIPTS)) db.createObjectStore(RECEIPTS, { keyPath: 'relayKey' });
      if (!db.objectStoreNames.contains(DEVICE_KEYS)) db.createObjectStore(DEVICE_KEYS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SYNC_CONFIG)) db.createObjectStore(SYNC_CONFIG, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  const db = await openOfflineDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    tx.onabort = () => reject(tx.error ?? new Error('Transacción offline cancelada.'));
    tx.onerror = () => reject(tx.error ?? new Error('Error en almacenamiento offline.'));
    tx.oncomplete = () => db.close();
    action(store, resolve, reject);
  });
}

async function countStore(storeName: string): Promise<number> {
  return withStore<number>(storeName, 'readonly', (store, resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(storeName, 'readonly', (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function putRecord<T>(storeName: string, value: T): Promise<void> {
  await withStore<void>(storeName, 'readwrite', (store, resolve, reject) => {
    const request = store.put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function assertEnvelopeShape(envelope: SecureEnvelopeV1) {
  const forbidden = ['lat', 'lng', 'address', 'description', 'contactPhone', 'phone', 'document', 'fullName'];
  const serializedHeaders = JSON.stringify({
    version: envelope.version,
    messageId: envelope.messageId,
    emitterKeyId: envelope.emitterKeyId,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    kind: envelope.kind,
    cryptoSuite: envelope.cryptoSuite,
    serverKeyId: envelope.serverKeyId,
  });
  for (const field of forbidden) {
    if (serializedHeaders.includes(`\"${field}\"`)) throw new Error('Metadata sensible detectada fuera del ciphertext.');
  }
}

export async function savePendingEnvelope(envelope: SecureEnvelopeV1): Promise<void> {
  assertEnvelopeShape(envelope);
  const existing = await getRecord<PendingEnvelope>(OUTBOX, envelope.messageId);
  if (!existing && (await countStore(OUTBOX)) >= MAX_OUTBOX_MESSAGES) {
    throw new Error('La cola offline local alcanzó su límite. Sincroniza o exporta los reportes antes de crear más.');
  }
  const now = new Date().toISOString();
  await putRecord<PendingEnvelope>(OUTBOX, {
    messageId: envelope.messageId,
    ciphertextSha256: envelope.ciphertextSha256,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    status: existing?.status ?? 'PENDING',
    attempts: existing?.attempts ?? 0,
    lastAttemptAt: existing?.lastAttemptAt,
    lastError: existing?.lastError,
    envelope,
  });
  await rememberSeen(envelope.emitterKeyId, envelope.messageId, envelope.ciphertextSha256, now);
}

export async function getPendingEnvelope(messageId: string): Promise<PendingEnvelope | undefined> {
  return getRecord<PendingEnvelope>(OUTBOX, messageId);
}

export async function listPendingEnvelopes(limit = 50): Promise<PendingEnvelope[]> {
  return withStore<PendingEnvelope[]>(OUTBOX, 'readonly', (store, resolve, reject) => {
    const result: PendingEnvelope[] = [];
    const index = store.index('status_createdAt');
    const range = IDBKeyRange.bound(['PENDING', ''], ['PENDING', '\uffff']);
    const request = index.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) return resolve(result);
      result.push(cursor.value as PendingEnvelope);
      cursor.continue();
    };
  });
}

export async function listRelayEnvelopes(limit = 50): Promise<RelayEnvelope[]> {
  return withStore<RelayEnvelope[]>(RELAY_QUEUE, 'readonly', (store, resolve, reject) => {
    const result: RelayEnvelope[] = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) return resolve(result);
      result.push(cursor.value as RelayEnvelope);
      cursor.continue();
    };
  });
}

export async function saveRelayEnvelope(envelope: SecureEnvelopeV1): Promise<'SAVED' | 'ALREADY_SEEN'> {
  assertEnvelopeShape(envelope);
  const relayKey = relayIdentity(envelope.emitterKeyId, envelope.messageId);
  const seen = await getSeenMessage(envelope.emitterKeyId, envelope.messageId);
  if (seen) {
    if (seen.ciphertextSha256 !== envelope.ciphertextSha256) throw new Error('MESSAGE_ID_DIGEST_CONFLICT');
    return 'ALREADY_SEEN';
  }
  if ((await countStore(RELAY_QUEUE)) >= MAX_RELAY_MESSAGES) throw new Error('RELAY_QUEUE_FULL');
  const now = new Date().toISOString();
  await putRecord<RelayEnvelope>(RELAY_QUEUE, {
    relayKey,
    emitterKeyId: envelope.emitterKeyId,
    messageId: envelope.messageId,
    ciphertextSha256: envelope.ciphertextSha256,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    receivedAt: now,
    envelope,
  });
  await rememberSeen(envelope.emitterKeyId, envelope.messageId, envelope.ciphertextSha256, now);
  return 'SAVED';
}

export async function countOutbox(): Promise<number> {
  return countStore(OUTBOX);
}

export async function countRelayQueue(): Promise<number> {
  return countStore(RELAY_QUEUE);
}

export async function markEnvelopeAttempt(messageId: string, error?: string): Promise<void> {
  const current = await getPendingEnvelope(messageId);
  if (!current) return;
  await putRecord<PendingEnvelope>(OUTBOX, {
    ...current,
    attempts: current.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

export async function markEnvelopeFailed(messageId: string, error: string): Promise<void> {
  const current = await getPendingEnvelope(messageId);
  if (!current) return;
  await putRecord<PendingEnvelope>(OUTBOX, {
    ...current,
    status: 'FAILED',
    attempts: current.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

export async function getSeenMessage(emitterKeyId: string, messageId: string): Promise<SeenMessage | undefined> {
  return getRecord<SeenMessage>(SEEN_MESSAGES, relayIdentity(emitterKeyId, messageId));
}

export async function rememberSeen(
  emitterKeyId: string,
  messageId: string,
  ciphertextSha256: string,
  at = new Date().toISOString(),
): Promise<void> {
  const relayKey = relayIdentity(emitterKeyId, messageId);
  const existing = await getSeenMessage(emitterKeyId, messageId);
  if (existing && existing.ciphertextSha256 !== ciphertextSha256) throw new Error('MESSAGE_ID_DIGEST_CONFLICT');
  await putRecord<SeenMessage>(SEEN_MESSAGES, {
    relayKey,
    emitterKeyId,
    messageId,
    ciphertextSha256,
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastSeenAt: at,
  });
}

export async function saveReceipt(receipt: SyncReceiptV1): Promise<void> {
  const relayKey = relayIdentity(receipt.emitterKeyId, receipt.messageId);
  const stored: StoredReceipt = { ...receipt, relayKey };
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([OUTBOX, RELAY_QUEUE, RECEIPTS], 'readwrite');
    tx.objectStore(RECEIPTS).put(stored);
    tx.objectStore(RELAY_QUEUE).delete(relayKey);

    const ownRequest = tx.objectStore(OUTBOX).get(receipt.messageId);
    ownRequest.onsuccess = () => {
      const own = ownRequest.result as PendingEnvelope | undefined;
      if (
        own?.envelope.emitterKeyId === receipt.emitterKeyId &&
        own.ciphertextSha256 === receipt.ciphertextSha256
      ) {
        tx.objectStore(OUTBOX).delete(receipt.messageId);
      }
    };

    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error ?? new Error('No se pudo guardar el recibo.'); db.close(); reject(error); };
    tx.onabort = tx.onerror;
  });
}

export async function getReceipt(emitterKeyId: string, messageId: string): Promise<SyncReceiptV1 | undefined> {
  return getRecord<StoredReceipt>(RECEIPTS, relayIdentity(emitterKeyId, messageId));
}

export async function listReceipts(limit = 500): Promise<SyncReceiptV1[]> {
  return withStore<SyncReceiptV1[]>(RECEIPTS, 'readonly', (store, resolve, reject) => {
    const result: SyncReceiptV1[] = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) return resolve(result);
      result.push(cursor.value as StoredReceipt);
      cursor.continue();
    };
  });
}

export async function getDeviceKeyRecord(): Promise<DeviceKeyRecord | undefined> {
  return getRecord<DeviceKeyRecord>(DEVICE_KEYS, 'device-signing-v1');
}

export async function saveDeviceKeyRecord(record: DeviceKeyRecord): Promise<void> {
  await putRecord<DeviceKeyRecord>(DEVICE_KEYS, record);
}

export async function getCachedSyncConfig(): Promise<CachedSyncConfig | undefined> {
  return getRecord<CachedSyncConfig>(SYNC_CONFIG, 'sync-crypto-config-v1');
}

export async function saveSyncConfig(config: SyncCryptoConfigV1): Promise<void> {
  await putRecord<CachedSyncConfig>(SYNC_CONFIG, {
    id: 'sync-crypto-config-v1',
    config,
    cachedAt: new Date().toISOString(),
  });
}

export async function pruneExpiredOfflineState(now = new Date()): Promise<void> {
  const cutoff = now.toISOString();
  for (const storeName of [OUTBOX, RELAY_QUEUE]) {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const index = tx.objectStore(storeName).index('expiresAt');
      const request = index.openCursor(IDBKeyRange.upperBound(cutoff));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = tx.onerror;
    });
  }
}

export async function getEnvelopeForRelay(emitterKeyId: string, messageId: string): Promise<SecureEnvelopeV1 | undefined> {
  const own = await getPendingEnvelope(messageId);
  if (own?.envelope.emitterKeyId === emitterKeyId) return own.envelope;
  const relay = await getRecord<RelayEnvelope>(RELAY_QUEUE, relayIdentity(emitterKeyId, messageId));
  return relay?.envelope;
}

export async function listMessageInventory(
  limit = 500,
): Promise<Array<{ emitterKeyId: string; messageId: string; ciphertextSha256: string }>> {
  const own = await listPendingEnvelopes(limit);
  const remaining = Math.max(0, limit - own.length);
  const relay = await listRelayEnvelopes(remaining);
  return [...own, ...relay].map((item) => ({
    emitterKeyId: item.envelope.emitterKeyId,
    messageId: item.messageId,
    ciphertextSha256: item.ciphertextSha256,
  }));
}

export async function requestPersistentStorage(): Promise<boolean | undefined> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return undefined;
  try { return await navigator.storage.persist(); } catch { return undefined; }
}
