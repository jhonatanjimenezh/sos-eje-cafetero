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

export type PendingIncident = {
  messageId: string;
  idempotencyKey: string;
  kind: 'INCIDENT';
  createdAt: string;
  updatedAt: string;
  status: 'PENDING' | 'FAILED';
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  payload: IncidentPayload;
};

export type SyncReceipt = {
  messageId: string;
  idempotencyKey: string;
  status: 'ACCEPTED' | 'ALREADY_PROCESSED';
  receivedAt: string;
  publicId?: string;
};

const DB_NAME = 'sos-eje-cafetero';
const DB_VERSION = 1;
const OUTBOX = 'outbox';
const RECEIPTS = 'sync_receipts';

function requireIndexedDb() {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB no está disponible en este dispositivo.');
  }
}

export function openOfflineDb(): Promise<IDBDatabase> {
  requireIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir la base offline.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const store = db.createObjectStore(OUTBOX, { keyPath: 'messageId' });
        store.createIndex('status_createdAt', ['status', 'createdAt'], { unique: false });
        store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
      }
      if (!db.objectStoreNames.contains(RECEIPTS)) {
        db.createObjectStore(RECEIPTS, { keyPath: 'messageId' });
      }
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

export async function savePendingIncident(item: PendingIncident): Promise<void> {
  await withStore<void>(OUTBOX, 'readwrite', (store, resolve, reject) => {
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getPendingIncident(messageId: string): Promise<PendingIncident | undefined> {
  return withStore<PendingIncident | undefined>(OUTBOX, 'readonly', (store, resolve, reject) => {
    const request = store.get(messageId);
    request.onsuccess = () => resolve(request.result as PendingIncident | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function listPendingIncidents(limit = 50): Promise<PendingIncident[]> {
  return withStore<PendingIncident[]>(OUTBOX, 'readonly', (store, resolve, reject) => {
    const result: PendingIncident[] = [];
    const index = store.index('status_createdAt');
    const range = IDBKeyRange.bound(['PENDING', ''], ['PENDING', '\uffff']);
    const request = index.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) {
        resolve(result);
        return;
      }
      result.push(cursor.value as PendingIncident);
      cursor.continue();
    };
  });
}

export async function countOutbox(): Promise<number> {
  return withStore<number>(OUTBOX, 'readonly', (store, resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function markAttempt(messageId: string, error?: string): Promise<void> {
  const current = await getPendingIncident(messageId);
  if (!current) return;
  await savePendingIncident({
    ...current,
    attempts: current.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
    updatedAt: new Date().toISOString(),
  });
}

export async function markFailed(messageId: string, error: string): Promise<void> {
  const current = await getPendingIncident(messageId);
  if (!current) return;
  await savePendingIncident({
    ...current,
    status: 'FAILED',
    attempts: current.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
    updatedAt: new Date().toISOString(),
  });
}

export async function acknowledgePendingIncident(receipt: SyncReceipt): Promise<void> {
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([OUTBOX, RECEIPTS], 'readwrite');
    tx.objectStore(RECEIPTS).put(receipt);
    tx.objectStore(OUTBOX).delete(receipt.messageId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      const error = tx.error ?? new Error('No se pudo guardar el recibo de sincronización.');
      db.close();
      reject(error);
    };
    tx.onabort = tx.onerror;
  });
}

export async function requestPersistentStorage(): Promise<boolean | undefined> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return undefined;
  try {
    return await navigator.storage.persist();
  } catch {
    return undefined;
  }
}
