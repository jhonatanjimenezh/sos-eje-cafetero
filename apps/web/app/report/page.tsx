'use client';

import { FormEvent, useEffect, useState } from 'react';
import { countOutbox, countRelayQueue, IncidentPayload } from '../../lib/offline-db';
import {
  submitIncidentOnlineOnly,
  submitIncidentResilient,
  syncPendingIncidents,
} from '../../lib/offline-sync';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const OFFLINE_QUEUE_REQUESTED = process.env.NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE === 'true';
const SECURE_ENVELOPE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_SECURE_ENVELOPE === 'true';
const SECURE_OFFLINE_ENABLED = OFFLINE_QUEUE_REQUESTED && SECURE_ENVELOPE_ENABLED;
const RELAY_ENABLED = process.env.NEXT_PUBLIC_FEATURE_WEBRTC_RELAY === 'true';

type Location = { lat: number; lng: number };
type SyncRegistration = ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } };

async function requestBackgroundSync() {
  if (!SECURE_OFFLINE_ENABLED || !('serviceWorker' in navigator)) return;
  try {
    const registration = (await navigator.serviceWorker.ready) as SyncRegistration;
    await registration.sync?.register('sos-outbox');
  } catch {
    // Progressive enhancement only. Foreground/online/manual sync remain available.
  }
}

export default function Report() {
  const [loc, setLoc] = useState<Location | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [relayed, setRelayed] = useState(0);
  const [online, setOnline] = useState(true);

  const refreshPending = async () => {
    if (!SECURE_OFFLINE_ENABLED) {
      setPending(0);
      setRelayed(0);
      return;
    }
    try {
      const [own, relay] = await Promise.all([countOutbox(), countRelayQueue()]);
      setPending(own);
      setRelayed(relay);
    } catch {
      setPending(0);
      setRelayed(0);
    }
  };

  useEffect(() => {
    setOnline(navigator.onLine);
    void refreshPending();
    const onOnline = () => { setOnline(true); void refreshPending(); };
    const onOffline = () => setOnline(false);
    const onOutboxChanged = () => void refreshPending();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (SECURE_OFFLINE_ENABLED) window.addEventListener('sos-outbox-changed', onOutboxChanged);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (SECURE_OFFLINE_ENABLED) window.removeEventListener('sos-outbox-changed', onOutboxChanged);
    };
  }, []);

  const gps = () =>
    navigator.geolocation.getCurrentPosition(
      (position) => setLoc({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setMsg('No fue posible obtener GPS. Activa ubicación e inténtalo de nuevo.'),
      { enableHighAccuracy: true, timeout: 12000 },
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loc) { setMsg('Primero comparte tu ubicación.'); return; }

    setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload: IncidentPayload = {
      type: String(data.get('type') ?? ''),
      priority: String(data.get('priority') ?? 'MEDIUM'),
      lat: loc.lat,
      lng: loc.lng,
      address: String(data.get('address') ?? ''),
      description: String(data.get('description') ?? ''),
      peopleAffected: Number(data.get('peopleAffected') || 0),
      peopleTrapped: Number(data.get('peopleTrapped') || 0),
      contactPhone: String(data.get('contactPhone') ?? ''),
    };

    try {
      const result = SECURE_OFFLINE_ENABLED
        ? await submitIncidentResilient(payload, API)
        : await submitIncidentOnlineOnly(payload, API);

      if (result.status === 'SENT') {
        setMsg(`✅ Reporte ${result.publicId ?? ''} registrado${'potentialDuplicate' in result && result.potentialDuplicate ? ' · El sistema detectó otro reporte cercano y será revisado.' : ''}`);
      } else {
        setMsg('🔐 Sin conexión estable. El reporte quedó cifrado y firmado localmente; GPS, teléfono y descripción no se guardaron en texto claro.');
        await requestBackgroundSync();
      }
      form.reset();
      setLoc(null);
      await refreshPending();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'error desconocido';
      setMsg(
        SECURE_OFFLINE_ENABLED
          ? `⚠️ No se pudo guardar el reporte de forma criptográficamente segura: ${detail}`
          : `⚠️ ${detail} Mantén este formulario abierto y vuelve a pulsar Enviar cuando regrese la conexión.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (!SECURE_OFFLINE_ENABLED) return;
    if (!navigator.onLine) { setMsg('📴 Sigues sin conexión. Los envelopes cifrados permanecen en este dispositivo.'); return; }
    setSyncing(true);
    try {
      const summary = await syncPendingIncidents(API);
      await refreshPending();
      const delivered = summary.accepted + summary.alreadyProcessed;
      if (delivered > 0) setMsg(`✅ Sincronización verificada: ${delivered} reporte(s) entregados al centro de mando.`);
      else if (summary.rejected > 0) setMsg(`⚠️ ${summary.rejected} envelope(s) fueron rechazados por validaciones de seguridad o esquema.`);
      else if (summary.retryableFailures > 0) setMsg('La red volvió, pero el servidor aún no respondió. Conservamos ciphertext para reintentar.');
      else if (summary.permanentFailures > 0) setMsg('Hay mensajes con un error no reintentable. No se enviará plaintext como fallback.');
      else setMsg('No hay reportes pendientes por sincronizar.');
    } catch {
      setMsg('No se pudo sincronizar todavía. Los envelopes cifrados siguen guardados localmente.');
    } finally {
      setSyncing(false);
    }
  }

  const connectionLabel = online
    ? '🟢 con conexión'
    : SECURE_OFFLINE_ENABLED
      ? '🟡 sin conexión · cola cifrada habilitada'
      : '🟠 sin conexión · modo seguro sin persistencia sensible';

  return (
    <main className="wrap">
      <div className="card">
        <h1>🆘 Reportar emergencia</h1>
        <p>Comparte primero tu ubicación GPS. No necesitas crear una cuenta para pedir rescate o reportar una emergencia.</p>
        <p className="muted">
          Estado: {connectionLabel}
          {pending > 0 ? ` · ${pending} reporte(s) propios cifrados` : ''}
          {relayed > 0 ? ` · ${relayed} mensaje(s) cifrados transportados para otros` : ''}
        </p>

        {!SECURE_OFFLINE_ENABLED && !online && (
          <p className="alert">
            Por seguridad, esta versión no persistirá GPS, teléfono ni descripción mientras no exista el canal cifrado completo.
            El formulario puede reintentarse al volver la red.
          </p>
        )}
        {OFFLINE_QUEUE_REQUESTED && !SECURE_ENVELOPE_ENABLED && (
          <p className="alert">La cola offline fue solicitada pero SecureEnvelope está deshabilitado. Se aplica fail-closed: no habrá persistencia sensible en plaintext.</p>
        )}
        {SECURE_OFFLINE_ENABLED && (
          <p className="muted">🔐 Si la red falla, el navegador guarda únicamente un envelope AES-256-GCM firmado; el servidor es el destinatario del contenido.</p>
        )}

        {SECURE_OFFLINE_ENABLED && (pending > 0 || relayed > 0) && (
          <button className="btn" type="button" disabled={syncing || !online} onClick={syncNow}>
            {syncing ? 'Sincronizando…' : '↻ Sincronizar envelopes ahora'}
          </button>
        )}
        {RELAY_ENABLED && SECURE_OFFLINE_ENABLED && <p><a href="/relay/">↔ Transportar mensajes cifrados entre dispositivos cercanos</a></p>}

        <button className="btn danger" type="button" onClick={gps}>{loc ? '✓ Ubicación capturada' : '📍 Compartir mi ubicación'}</button>
        {loc && <p className="muted">GPS recibido con precisión del dispositivo.</p>}

        <form onSubmit={submit}>
          <label>Tipo</label>
          <select name="type" required>
            <option value="PEOPLE_TRAPPED">Personas atrapadas</option>
            <option value="INJURED_PERSON">Persona herida</option>
            <option value="BUILDING_COLLAPSE">Edificación colapsada</option>
            <option value="BUILDING_DAMAGE">Vivienda/edificación dañada</option>
            <option value="FIRE">Incendio</option>
            <option value="GAS_LEAK">Fuga de gas</option>
            <option value="MEDICAL_NEED">Necesidad médica</option>
            <option value="WATER_NEED">Necesidad de agua</option>
            <option value="FOOD_NEED">Necesidad de alimentos</option>
            <option value="ROAD_BLOCKED">Vía bloqueada</option>
            <option value="LANDSLIDE">Deslizamiento</option>
            <option value="OTHER">Otra</option>
          </select>

          <label>Prioridad percibida</label>
          <select name="priority" defaultValue="MEDIUM">
            <option value="CRITICAL">Crítica: vidas en riesgo inmediato</option>
            <option value="HIGH">Alta</option><option value="MEDIUM">Media</option><option value="LOW">Baja</option>
          </select>

          <label>Dirección / referencia</label>
          <input name="address" placeholder="Barrio, calle, edificio o referencia" />
          <label>Descripción</label>
          <textarea name="description" rows={4} placeholder="¿Qué está ocurriendo?" />
          <div className="grid">
            <div><label>Personas afectadas</label><input name="peopleAffected" type="number" min="0" defaultValue="0" /></div>
            <div><label>Personas atrapadas</label><input name="peopleTrapped" type="number" min="0" defaultValue="0" /></div>
          </div>
          <label>Teléfono de contacto</label>
          <input name="contactPhone" inputMode="tel" />
          <button disabled={busy} className="btn danger" type="submit">
            {busy ? 'Protegiendo y enviando…' : online ? 'Enviar reporte' : SECURE_OFFLINE_ENABLED ? 'Cifrar y guardar reporte offline' : 'Reintentar envío'}
          </button>
        </form>
        {msg && <p className="alert">{msg}</p>}
      </div>
    </main>
  );
}
