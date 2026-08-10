import {
  acknowledgePendingIncident,
  IncidentPayload,
  listPendingIncidents,
  markAttempt,
  markFailed,
  PendingIncident,
  savePendingIncident,
} from './offline-db';

const DEFAULT_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

export type ResilientSubmitResult =
  | { status: 'SENT'; publicId?: string; potentialDuplicate?: unknown }
  | { status: 'QUEUED'; messageId: string };

export type OnlineSubmitResult = {
  status: 'SENT';
  publicId?: string;
  potentialDuplicate?: unknown;
};

export type SyncSummary = {
  accepted: number;
  alreadyProcessed: number;
  retryableFailures: number;
  permanentFailures: number;
};

type PostResult =
  | { kind: 'success'; body: any; idempotentReplay: boolean }
  | { kind: 'retryable'; error: string }
  | { kind: 'permanent'; error: string };

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function notifyOutboxChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sos-outbox-changed'));
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    return message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function postIncident(
  payload: IncidentPayload,
  idempotencyKey: string,
  apiBase = DEFAULT_API,
): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { kind: 'retryable', error: error instanceof Error ? error.message : 'Error de red' };
  }

  if (response.ok) {
    const body = await response.json();
    return { kind: 'success', body, idempotentReplay: Boolean(body?.idempotentReplay) };
  }

  const error = await readError(response);
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    return { kind: 'retryable', error };
  }
  return { kind: 'permanent', error };
}

function buildPending(payload: IncidentPayload): PendingIncident {
  const messageId = newId();
  const now = new Date().toISOString();
  return {
    messageId,
    idempotencyKey: `web:${messageId}`,
    kind: 'INCIDENT',
    createdAt: now,
    updatedAt: now,
    status: 'PENDING',
    attempts: 0,
    payload,
  };
}

/**
 * Safe-mode submit used when persistent offline storage is disabled.
 * Nothing is written to IndexedDB. Two network attempts reuse the exact same
 * Idempotency-Key so a lost response after a successful server commit does not
 * create a duplicate during the automatic retry.
 */
export async function submitIncidentOnlineOnly(
  payload: IncidentPayload,
  apiBase = DEFAULT_API,
): Promise<OnlineSubmitResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Sin conexión. El modo seguro actual no almacena ubicación ni contacto offline.');
  }

  const idempotencyKey = `web:${newId()}`;
  let lastRetryableError = 'No fue posible contactar el servidor.';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await postIncident(payload, idempotencyKey, apiBase);
    if (result.kind === 'success') {
      return {
        status: 'SENT',
        publicId: result.body?.public_id,
        potentialDuplicate: result.body?.potentialDuplicate,
      };
    }
    if (result.kind === 'permanent') throw new Error(result.error);
    lastRetryableError = result.error;
  }

  throw new Error(`${lastRetryableError} No se guardó información sensible en este dispositivo.`);
}

export async function submitIncidentResilient(
  payload: IncidentPayload,
  apiBase = DEFAULT_API,
): Promise<ResilientSubmitResult> {
  const pending = buildPending(payload);
  const canTryNetwork = typeof navigator === 'undefined' || navigator.onLine;

  if (canTryNetwork) {
    const result = await postIncident(payload, pending.idempotencyKey, apiBase);
    if (result.kind === 'success') {
      await acknowledgePendingIncident({
        messageId: pending.messageId,
        idempotencyKey: pending.idempotencyKey,
        status: result.idempotentReplay ? 'ALREADY_PROCESSED' : 'ACCEPTED',
        receivedAt: new Date().toISOString(),
        publicId: result.body?.public_id,
      });
      notifyOutboxChanged();
      return {
        status: 'SENT',
        publicId: result.body?.public_id,
        potentialDuplicate: result.body?.potentialDuplicate,
      };
    }
    if (result.kind === 'permanent') throw new Error(result.error);
  }

  await savePendingIncident(pending);
  notifyOutboxChanged();
  return { status: 'QUEUED', messageId: pending.messageId };
}

export async function syncPendingIncidents(apiBase = DEFAULT_API, limit = 50): Promise<SyncSummary> {
  const summary: SyncSummary = {
    accepted: 0,
    alreadyProcessed: 0,
    retryableFailures: 0,
    permanentFailures: 0,
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) return summary;

  const pending = await listPendingIncidents(limit);
  for (const item of pending) {
    const result = await postIncident(item.payload, item.idempotencyKey, apiBase);
    if (result.kind === 'success') {
      await acknowledgePendingIncident({
        messageId: item.messageId,
        idempotencyKey: item.idempotencyKey,
        status: result.idempotentReplay ? 'ALREADY_PROCESSED' : 'ACCEPTED',
        receivedAt: new Date().toISOString(),
        publicId: result.body?.public_id,
      });
      if (result.idempotentReplay) summary.alreadyProcessed += 1;
      else summary.accepted += 1;
      continue;
    }

    if (result.kind === 'retryable') {
      await markAttempt(item.messageId, result.error);
      summary.retryableFailures += 1;
      continue;
    }

    await markFailed(item.messageId, result.error);
    summary.permanentFailures += 1;
  }

  notifyOutboxChanged();
  return summary;
}
