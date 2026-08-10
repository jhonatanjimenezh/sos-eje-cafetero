import type { SecureEnvelopeV1, SyncReceiptV1 } from '@sos/secure-envelope';
import {
  countOutbox,
  IncidentPayload,
  listPendingEnvelopes,
  listRelayEnvelopes,
  markEnvelopeAttempt,
  markEnvelopeFailed,
  savePendingEnvelope,
  saveReceipt,
} from './offline-db';
import { createSecureEnvelope, getServerCryptoConfig, verifyServerReceipt } from './secure-envelope';

const DEFAULT_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const SECURE_OFFLINE_ENABLED =
  process.env.NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE === 'true' &&
  process.env.NEXT_PUBLIC_FEATURE_SECURE_ENVELOPE === 'true';

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
  rejected: number;
  retryableFailures: number;
  permanentFailures: number;
};

type PostResult =
  | { kind: 'success'; body: any; idempotentReplay: boolean }
  | { kind: 'retryable'; error: string }
  | { kind: 'permanent'; error: string };

type BatchResult =
  | { kind: 'success'; receipts: SyncReceiptV1[] }
  | { kind: 'retryable'; error: string }
  | { kind: 'permanent'; error: string };

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function notifyOutboxChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sos-outbox-changed'));
}

function receiptForEnvelope(receipts: SyncReceiptV1[], envelope: SecureEnvelopeV1) {
  return receipts.find((candidate) =>
    candidate.emitterKeyId === envelope.emitterKeyId &&
    candidate.messageId === envelope.messageId &&
    candidate.ciphertextSha256 === envelope.ciphertextSha256,
  );
}

function isNonTerminalRelayRejection(receipt: SyncReceiptV1): boolean {
  return receipt.status === 'REJECTED' && receipt.emitterAuthenticated === false;
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
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
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

async function postEnvelopeBatch(envelopes: SecureEnvelopeV1[], apiBase = DEFAULT_API): Promise<BatchResult> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/sync/envelopes/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes }),
    });
  } catch (error) {
    return { kind: 'retryable', error: error instanceof Error ? error.message : 'Error de red' };
  }

  if (response.ok) {
    const body = await response.json();
    if (!Array.isArray(body?.receipts)) return { kind: 'permanent', error: 'Respuesta de sincronización inválida' };
    return { kind: 'success', receipts: body.receipts as SyncReceiptV1[] };
  }
  const error = await readError(response);
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    return { kind: 'retryable', error };
  }
  return { kind: 'permanent', error };
}

/**
 * Camino seguro cuando la persistencia offline está deshabilitada. Nunca escribe
 * GPS, teléfono o descripción en IndexedDB. Dos intentos reutilizan la misma
 * Idempotency-Key para tolerar una respuesta perdida después de commit.
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
      return { status: 'SENT', publicId: result.body?.public_id, potentialDuplicate: result.body?.potentialDuplicate };
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
  if (!SECURE_OFFLINE_ENABLED) return submitIncidentOnlineOnly(payload, apiBase);

  let envelope: SecureEnvelopeV1;
  try {
    envelope = await createSecureEnvelope('INCIDENT', payload, apiBase);
  } catch (error) {
    // Si hay Internet y el subsistema criptográfico aún no está inicializado, el
    // SOS online sigue disponible. Nunca usamos este fallback después de intentar
    // enviar un envelope, porque podríamos duplicar un commit cuyo ACK se perdió.
    if (typeof navigator === 'undefined' || navigator.onLine) return submitIncidentOnlineOnly(payload, apiBase);
    throw error;
  }

  const canTryNetwork = typeof navigator === 'undefined' || navigator.onLine;
  if (canTryNetwork) {
    const result = await postEnvelopeBatch([envelope], apiBase);
    if (result.kind === 'success') {
      const receipt = receiptForEnvelope(result.receipts, envelope);
      if (!receipt) throw new Error('El servidor no devolvió un recibo ligado criptográficamente a este reporte.');
      await verifyServerReceipt(receipt, envelope, apiBase);

      if (isNonTerminalRelayRejection(receipt)) {
        // Una copia alterada pudo haber llegado al servidor por un relay. El receipt
        // firmado solo confirma el diagnóstico; NO confirma la autenticidad del emisor
        // y por tanto jamás autoriza a borrar el original válido.
        await savePendingEnvelope(envelope);
        notifyOutboxChanged();
        return { status: 'QUEUED', messageId: envelope.messageId };
      }

      if (receipt.status === 'REJECTED') {
        throw new Error(`Reporte rechazado después de autenticar al emisor: ${receipt.reasonCode ?? 'UNKNOWN'}`);
      }

      await saveReceipt(receipt);
      notifyOutboxChanged();
      return { status: 'SENT', publicId: receipt.publicEntityId };
    }
    if (result.kind === 'permanent') throw new Error(result.error);
  }

  // A partir de aquí nunca persistimos el payload original; solo ciphertext firmado.
  await savePendingEnvelope(envelope);
  notifyOutboxChanged();
  return { status: 'QUEUED', messageId: envelope.messageId };
}

export async function syncPendingIncidents(apiBase = DEFAULT_API, limit = 50): Promise<SyncSummary> {
  const summary: SyncSummary = {
    accepted: 0,
    alreadyProcessed: 0,
    rejected: 0,
    retryableFailures: 0,
    permanentFailures: 0,
  };
  if (!SECURE_OFFLINE_ENABLED || (typeof navigator !== 'undefined' && !navigator.onLine)) return summary;

  const config = await getServerCryptoConfig(apiBase);
  const own = await listPendingEnvelopes(limit);
  const relay = await listRelayEnvelopes(Math.max(0, limit - own.length));
  const all = [
    ...own.map((item) => ({ envelope: item.envelope, own: true })),
    ...relay.map((item) => ({ envelope: item.envelope, own: false })),
  ];
  const batchSize = Math.max(1, Math.min(config.maxBatchSize, 4));

  for (let offset = 0; offset < all.length; offset += batchSize) {
    const group = all.slice(offset, offset + batchSize);
    const result = await postEnvelopeBatch(group.map((item) => item.envelope), apiBase);
    if (result.kind === 'retryable') {
      for (const item of group) if (item.own) await markEnvelopeAttempt(item.envelope.messageId, result.error);
      summary.retryableFailures += group.length;
      continue;
    }
    if (result.kind === 'permanent') {
      for (const item of group) if (item.own) await markEnvelopeFailed(item.envelope.messageId, result.error);
      summary.permanentFailures += group.length;
      continue;
    }

    for (const item of group) {
      const receipt = receiptForEnvelope(result.receipts, item.envelope);
      if (!receipt) {
        if (item.own) await markEnvelopeAttempt(item.envelope.messageId, 'MISSING_RECEIPT');
        summary.retryableFailures += 1;
        continue;
      }
      try {
        await verifyServerReceipt(receipt, item.envelope, apiBase);
      } catch {
        if (item.own) await markEnvelopeAttempt(item.envelope.messageId, 'INVALID_SERVER_RECEIPT');
        summary.retryableFailures += 1;
        continue;
      }

      if (isNonTerminalRelayRejection(receipt)) {
        if (item.own) {
          await markEnvelopeAttempt(
            item.envelope.messageId,
            `UNAUTHENTICATED_REJECTION:${receipt.reasonCode ?? 'UNKNOWN'}`,
          );
        }
        // Own y relay conservan ciphertext. Otro camino puede entregar el original.
        summary.retryableFailures += 1;
        continue;
      }

      await saveReceipt(receipt);
      if (receipt.status === 'ACCEPTED') summary.accepted += 1;
      else if (receipt.status === 'ALREADY_PROCESSED') summary.alreadyProcessed += 1;
      else summary.rejected += 1;
    }
  }

  notifyOutboxChanged();
  return summary;
}

export async function secureOutboxCount(): Promise<number> {
  if (!SECURE_OFFLINE_ENABLED) return 0;
  return countOutbox();
}
