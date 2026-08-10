'use client';

import { FormEvent, useEffect, useState } from 'react';
import { countOutbox, IncidentPayload } from '../../lib/offline-db';
import {
  submitIncidentOnlineOnly,
  submitIncidentResilient,
  syncPendingIncidents,
} from '../../lib/offline-sync';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const OFFLINE_QUEUE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE === 'true';

type Location = { lat: number; lng: number };

type SyncRegistration = ServiceWorkerRegistration & {
  sync?: { register(tag: string): Promise<void> };
};

async function requestBackgroundSync() {
  if (!OFFLINE_QUEUE_ENABLED || !('serviceWorker' in navigator)) return;
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
  const [online, setOnline] = useState(true);

  const refreshPending = async () => {
    if (!OFFLINE_QUEUE_ENABLED) {
      setPending(0);
      return;
    }
    try {
      setPending(await countOutbox());
    } catch {
      setPending(0);
    }
  };

  useEffect(() => {
    setOnline(navigator.onLine);
    void refreshPending();

    const onOnline = () => {
      setOnline(true);
      void refreshPending();
    };
    const onOffline = () => setOnline(false);
    const onOutboxChanged = () => void refreshPending();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (OFFLINE_QUEUE_ENABLED) window.addEventListener('sos-outbox-changed', onOutboxChanged);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (OFFLINE_QUEUE_ENABLED) window.removeEventListener('sos-outbox-changed', onOutboxChanged);
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
    if (!loc) {
      setMsg('Primero comparte tu ubicación.');
      return;
    }

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
      const result = OFFLINE_QUEUE_ENABLED
        ? await submitIncidentResilient(payload, API)
        : await submitIncidentOnlineOnly(payload, API);

      if (result.status === 'SENT') {
        setMsg(
          `✅ Reporte ${result.publicId ?? ''} registrado${result.potentialDuplicate ? ' · El sistema detectó otro reporte cercano y será revisado.' : ''}`,
        );
        form.reset();
        setLoc(null);
      } else {
        setMsg(
          '📴 No hay conexión estable. El reporte quedó almacenado localmente para sincronizarse al recuperar Internet.',
        );
        await requestBackgroundSync();
        form.reset();
        setLoc(null);
      }
      await refreshPending();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'error desconocido';
      setMsg(
        OFFLINE_QUEUE_ENABLED
          ? `No se pudo guardar el reporte: ${detail}`
          : `⚠️ ${detail} Mantén este formulario abierto y vuelve a pulsar Enviar cuando regrese la conexión.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (!OFFLINE_QUEUE_ENABLED) return;
    if (!navigator.onLine) {
      setMsg('📴 Sigues sin conexión. Los reportes permanecerán guardados en este dispositivo.');
      return;
    }
    setSyncing(true);
    try {
      const summary = await syncPendingIncidents(API);
      await refreshPending();
      const delivered = summary.accepted + summary.alreadyProcessed;
      if (delivered > 0) {
        setMsg(`✅ Sincronización completada: ${delivered} reporte(s) entregados al centro de mando.`);
      } else if (summary.retryableFailures > 0) {
        setMsg('La red volvió, pero el servidor aún no respondió. Conservamos los reportes para reintentar.');
      } else if (summary.permanentFailures > 0) {
        setMsg('Hay reportes que requieren revisión antes de poder enviarse. Los conservamos localmente.');
      } else {
        setMsg('No hay reportes pendientes por sincronizar.');
      }
    } catch {
      setMsg('No se pudo sincronizar todavía. Los reportes siguen guardados localmente.');
    } finally {
      setSyncing(false);
    }
  }

  const connectionLabel = online
    ? '🟢 con conexión'
    : OFFLINE_QUEUE_ENABLED
      ? '🟡 sin conexión · cola offline habilitada'
      : '🟠 sin conexión · modo seguro sin persistencia sensible';

  return (
    <main className="wrap">
      <div className="card">
        <h1>🆘 Reportar emergencia</h1>
        <p>Comparte primero tu ubicación GPS. No necesitas crear una cuenta.</p>

        <p className="muted">
          Estado: {connectionLabel}
          {pending > 0 ? ` · ${pending} reporte(s) pendientes en este dispositivo` : ''}
        </p>

        {!OFFLINE_QUEUE_ENABLED && !online && (
          <p className="alert">
            Por seguridad, esta versión no guarda GPS, teléfono ni descripción en el dispositivo cuando no hay Internet.
            El formulario permanecerá aquí para que puedas reintentar cuando vuelva la conexión.
          </p>
        )}

        {OFFLINE_QUEUE_ENABLED && pending > 0 && (
          <button className="btn" type="button" disabled={syncing || !online} onClick={syncNow}>
            {syncing ? 'Sincronizando…' : '↻ Sincronizar ahora'}
          </button>
        )}

        <button className="btn danger" type="button" onClick={gps}>
          {loc ? '✓ Ubicación capturada' : '📍 Compartir mi ubicación'}
        </button>
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
            <option value="HIGH">Alta</option>
            <option value="MEDIUM">Media</option>
            <option value="LOW">Baja</option>
          </select>

          <label>Dirección / referencia</label>
          <input name="address" placeholder="Barrio, calle, edificio o referencia" />

          <label>Descripción</label>
          <textarea name="description" rows={4} placeholder="¿Qué está ocurriendo?" />

          <div className="grid">
            <div>
              <label>Personas afectadas</label>
              <input name="peopleAffected" type="number" min="0" defaultValue="0" />
            </div>
            <div>
              <label>Personas atrapadas</label>
              <input name="peopleTrapped" type="number" min="0" defaultValue="0" />
            </div>
          </div>

          <label>Teléfono de contacto</label>
          <input name="contactPhone" inputMode="tel" />

          <button disabled={busy} className="btn danger" type="submit">
            {busy
              ? 'Enviando…'
              : online
                ? 'Enviar reporte'
                : OFFLINE_QUEUE_ENABLED
                  ? 'Guardar reporte offline'
                  : 'Reintentar envío'}
          </button>
        </form>

        {msg && <p className="alert">{msg}</p>}
      </div>
    </main>
  );
}
