'use client';

import { useRef, useState } from 'react';
import { announceRelayInventory, wireRelayDataChannel } from '../../lib/relay';

const RELAY_ENABLED = process.env.NEXT_PUBLIC_FEATURE_WEBRTC_RELAY === 'true';

type PairingBlob = { type: 'offer' | 'answer'; sdp: string };

function encodePairing(description: RTCSessionDescriptionInit): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ type: description.type, sdp: description.sdp }))));
}

function decodePairing(value: string): PairingBlob {
  const parsed = JSON.parse(decodeURIComponent(escape(atob(value.trim())))) as PairingBlob;
  if (!['offer', 'answer'].includes(parsed.type) || typeof parsed.sdp !== 'string') throw new Error('Código de emparejamiento inválido');
  return parsed;
}

function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
    setTimeout(() => { pc.removeEventListener('icegatheringstatechange', handler); resolve(); }, 5000);
  });
}

export default function RelayPage() {
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const [localCode, setLocalCode] = useState('');
  const [remoteCode, setRemoteCode] = useState('');
  const [status, setStatus] = useState('Listo para emparejar dos dispositivos cercanos.');

  const callbacks = {
    onStatus: (message: string) => setStatus(`✅ ${message}`),
    onError: (message: string) => setStatus(`⚠️ ${message}`),
  };

  function newPeer() {
    peerRef.current?.close();
    // No usamos servidores STUN/TURN en el modo offline. Solo candidatos host/locales.
    const pc = new RTCPeerConnection({ iceServers: [] });
    peerRef.current = pc;
    pc.onconnectionstatechange = () => setStatus(`Estado WebRTC: ${pc.connectionState}`);
    pc.ondatachannel = (event) => {
      channelRef.current = event.channel;
      wireRelayDataChannel(event.channel, callbacks);
    };
    return pc;
  }

  async function createOffer() {
    try {
      const pc = newPeer();
      const channel = pc.createDataChannel('sos-secure-relay-v1', { ordered: true });
      channelRef.current = channel;
      wireRelayDataChannel(channel, callbacks);
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete(pc);
      if (!pc.localDescription) throw new Error('No se generó oferta local');
      setLocalCode(encodePairing(pc.localDescription));
      setStatus('Oferta creada. Compártela directamente con el segundo dispositivo.');
    } catch (error) {
      setStatus(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function acceptOffer() {
    try {
      const remote = decodePairing(remoteCode);
      if (remote.type !== 'offer') throw new Error('Este dispositivo esperaba una oferta');
      const pc = newPeer();
      await pc.setRemoteDescription(remote);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIceComplete(pc);
      if (!pc.localDescription) throw new Error('No se generó respuesta local');
      setLocalCode(encodePairing(pc.localDescription));
      setStatus('Respuesta creada. Devuélvela al primer dispositivo.');
    } catch (error) {
      setStatus(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function acceptAnswer() {
    try {
      const pc = peerRef.current;
      if (!pc) throw new Error('Primero crea una oferta en este dispositivo');
      const remote = decodePairing(remoteCode);
      if (remote.type !== 'answer') throw new Error('Este dispositivo esperaba una respuesta');
      await pc.setRemoteDescription(remote);
      setStatus('Respuesta aplicada. Esperando apertura del canal local.');
    } catch (error) {
      setStatus(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function refreshInventory() {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') return setStatus('El canal todavía no está abierto.');
    try { await announceRelayInventory(channel); } catch (error) { setStatus(`⚠️ ${String(error)}`); }
  }

  if (!RELAY_ENABLED) {
    return (
      <main className="wrap"><div className="card">
        <h1>Relay seguro entre dispositivos</h1>
        <p>Esta capacidad está deshabilitada por feature flag hasta completar sus pruebas operacionales.</p>
      </div></main>
    );
  }

  return (
    <main className="wrap">
      <div className="card">
        <h1>🔐 Relay seguro sin Internet</h1>
        <p>
          Este modo transporta únicamente <strong>envelopes cifrados y firmados</strong>. El dispositivo intermediario no recibe GPS,
          teléfono, nombre, documento ni descripción en texto claro y no puede declarar un reporte como verdadero.
        </p>
        <p className="alert">
          Empareja solo dispositivos físicamente presentes y de confianza operacional. El código WebRTC puede contener información
          de red local: no lo publiques en chats, redes sociales o canales abiertos.
        </p>

        <div className="grid">
          <div>
            <h2>Dispositivo A</h2>
            <button className="btn" type="button" onClick={createOffer}>1. Crear oferta</button>
          </div>
          <div>
            <h2>Dispositivo B</h2>
            <button className="btn" type="button" onClick={acceptOffer}>2. Aceptar oferta y crear respuesta</button>
          </div>
        </div>

        <label>Código recibido del otro dispositivo</label>
        <textarea rows={5} value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="Pega aquí oferta o respuesta" />
        <button className="btn" type="button" onClick={acceptAnswer}>3. Aplicar respuesta en A</button>

        <label>Código generado por este dispositivo</label>
        <textarea rows={5} readOnly value={localCode} placeholder="Se generará aquí" />

        <button className="btn" type="button" onClick={refreshInventory}>↻ Intercambiar inventario cifrado</button>
        <p className="muted">{status}</p>
        <p className="muted">
          Relay V1 solo mueve mensajes estructurados pequeños. Fotos y videos permanecen fuera de esta ruta para proteger batería,
          almacenamiento y disponibilidad.
        </p>
      </div>
    </main>
  );
}
