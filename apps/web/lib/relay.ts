import type { SecureEnvelopeV1, SyncReceiptV1 } from '@sos/secure-envelope';
import {
  getEnvelopeForRelay,
  getReceipt,
  listMessageInventory,
  listReceipts,
  relayIdentity,
  saveReceipt,
  saveRelayEnvelope,
} from './offline-db';
import { verifyEnvelopePublicIntegrity, verifyServerReceipt } from './secure-envelope';

const MAX_RELAY_PACKET_BYTES = 24 * 1024;
const MAX_INVENTORY_ITEMS = 500;
const encoder = new TextEncoder();

type RelayDigestRef = { emitterKeyId: string; messageId: string; ciphertextSha256: string };
type RelayIdRef = { emitterKeyId: string; messageId: string };

export type RelayMessage =
  | { type: 'INVENTORY'; messages: RelayDigestRef[]; receipts: RelayDigestRef[] }
  | { type: 'NEED'; messages: RelayIdRef[]; receipts: RelayIdRef[] }
  | { type: 'ENVELOPE'; envelope: SecureEnvelopeV1 }
  | { type: 'RECEIPT'; receipt: SyncReceiptV1 }
  | { type: 'PING' };

function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function send(channel: RTCDataChannel, message: RelayMessage) {
  if (channel.readyState !== 'open') return;
  const json = JSON.stringify(message);
  if (encoder.encode(json).byteLength > MAX_RELAY_PACKET_BYTES) throw new Error('RELAY_PACKET_TOO_LARGE');
  channel.send(json);
}

export async function buildRelayInventory(): Promise<RelayMessage> {
  const [messages, receipts] = await Promise.all([
    listMessageInventory(MAX_INVENTORY_ITEMS),
    listReceipts(MAX_INVENTORY_ITEMS),
  ]);
  return {
    type: 'INVENTORY',
    messages,
    receipts: receipts.map((item) => ({
      emitterKeyId: item.emitterKeyId,
      messageId: item.messageId,
      ciphertextSha256: item.ciphertextSha256,
    })),
  };
}

async function handleInventory(channel: RTCDataChannel, message: Extract<RelayMessage, { type: 'INVENTORY' }>) {
  const localMessages = new Map(
    (await listMessageInventory(MAX_INVENTORY_ITEMS)).map((item) => [
      relayIdentity(item.emitterKeyId, item.messageId),
      item.ciphertextSha256,
    ]),
  );
  const localReceipts = new Map(
    (await listReceipts(MAX_INVENTORY_ITEMS)).map((item) => [
      relayIdentity(item.emitterKeyId, item.messageId),
      item.ciphertextSha256,
    ]),
  );
  const messages: RelayIdRef[] = [];
  const receipts: RelayIdRef[] = [];

  for (const remote of message.messages.slice(0, MAX_INVENTORY_ITEMS)) {
    const key = relayIdentity(remote.emitterKeyId, remote.messageId);
    const localDigest = localMessages.get(key);
    if (!localDigest) messages.push({ emitterKeyId: remote.emitterKeyId, messageId: remote.messageId });
    else if (localDigest !== remote.ciphertextSha256) {
      // Mismo emisor+messageId con otro digest implica conflicto/tampering.
      // Otro emisor puede reutilizar deliberadamente el UUID sin ocupar este namespace.
      continue;
    }
  }
  for (const remote of message.receipts.slice(0, MAX_INVENTORY_ITEMS)) {
    const key = relayIdentity(remote.emitterKeyId, remote.messageId);
    const localDigest = localReceipts.get(key);
    if (!localDigest) receipts.push({ emitterKeyId: remote.emitterKeyId, messageId: remote.messageId });
    else if (localDigest !== remote.ciphertextSha256) continue;
  }
  send(channel, { type: 'NEED', messages, receipts });
}

async function handleNeed(channel: RTCDataChannel, message: Extract<RelayMessage, { type: 'NEED' }>) {
  for (const ref of message.messages.slice(0, MAX_INVENTORY_ITEMS)) {
    const envelope = await getEnvelopeForRelay(ref.emitterKeyId, ref.messageId);
    if (!envelope) continue;
    const packet: RelayMessage = { type: 'ENVELOPE', envelope };
    if (encodedSize(packet) <= MAX_RELAY_PACKET_BYTES) send(channel, packet);
  }
  for (const ref of message.receipts.slice(0, MAX_INVENTORY_ITEMS)) {
    const receipt = await getReceipt(ref.emitterKeyId, ref.messageId);
    if (receipt) send(channel, { type: 'RECEIPT', receipt });
  }
}

export async function handleRelayMessage(channel: RTCDataChannel, raw: string): Promise<string> {
  if (encoder.encode(raw).byteLength > MAX_RELAY_PACKET_BYTES) throw new Error('RELAY_PACKET_TOO_LARGE');
  let message: RelayMessage;
  try { message = JSON.parse(raw) as RelayMessage; } catch { throw new Error('RELAY_JSON_INVALID'); }

  if (message.type === 'PING') return 'PING';
  if (message.type === 'INVENTORY') {
    await handleInventory(channel, message);
    return 'INVENTORY';
  }
  if (message.type === 'NEED') {
    await handleNeed(channel, message);
    return 'NEED';
  }
  if (message.type === 'ENVELOPE') {
    if (!message.envelope || encodedSize(message) > MAX_RELAY_PACKET_BYTES) throw new Error('ENVELOPE_TOO_LARGE');
    await verifyEnvelopePublicIntegrity(message.envelope);
    const status = await saveRelayEnvelope(message.envelope);
    return status === 'SAVED' ? 'ENVELOPE_SAVED' : 'ENVELOPE_ALREADY_SEEN';
  }
  if (message.type === 'RECEIPT') {
    if (!message.receipt) throw new Error('RECEIPT_INVALID');
    const localEnvelope = await getEnvelopeForRelay(message.receipt.emitterKeyId, message.receipt.messageId);
    await verifyServerReceipt(message.receipt, localEnvelope);
    await saveReceipt(message.receipt);
    return 'RECEIPT_SAVED';
  }
  throw new Error('RELAY_MESSAGE_UNSUPPORTED');
}

export async function announceRelayInventory(channel: RTCDataChannel) {
  send(channel, (await buildRelayInventory()) as RelayMessage);
}

export function wireRelayDataChannel(
  channel: RTCDataChannel,
  callbacks?: { onStatus?: (status: string) => void; onError?: (error: string) => void },
) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    callbacks?.onStatus?.('Canal seguro de transporte abierto');
    void announceRelayInventory(channel).catch((error) => callbacks?.onError?.(String(error)));
  };
  channel.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      callbacks?.onError?.('Binarios no permitidos en relay V1');
      return;
    }
    void handleRelayMessage(channel, event.data)
      .then((status) => callbacks?.onStatus?.(status))
      .catch((error) => callbacks?.onError?.(error instanceof Error ? error.message : String(error)));
  };
  channel.onerror = () => callbacks?.onError?.('Error RTCDataChannel');
  channel.onclose = () => callbacks?.onStatus?.('Canal relay cerrado');
}
