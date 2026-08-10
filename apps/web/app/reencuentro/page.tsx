'use client';

import { FormEvent, useEffect, useState } from 'react';
import OtpLogin from '../components/OtpLogin';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const ENABLED = process.env.NEXT_PUBLIC_FEATURE_REUNIFICATION === 'true';

type InboxItem = {
  id: string;
  seekerDisplayName?: string;
  declaredRelationship?: string;
  relationshipVerified: false;
  message?: string;
  contactAvailable: boolean;
  createdAt: string;
  expiresAt: string;
};

type ContactState = {
  phone?: string;
  warning?: string;
  status: string;
};

export default function ReunificationPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Record<string, ContactState>>({});

  async function refreshInbox() {
    if (!ENABLED) return;
    try {
      const response = await fetch(`${API}/reunification/inbox`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (response.status === 401) {
        setAuthenticated(false);
        setInbox([]);
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message || 'No fue posible abrir el inbox.');
      }
      setAuthenticated(true);
      setInbox(await response.json());
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible abrir el inbox privado.');
    }
  }

  useEffect(() => {
    if (ENABLED) void refreshInbox();
  }, []);

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(`${API}/reunification/requests`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetPhone: form.get('targetPhone'),
          seekerDisplayName: form.get('seekerDisplayName') || undefined,
          declaredRelationship: form.get('declaredRelationship') || undefined,
          message: form.get('message') || undefined,
          shareSeekerPhone: form.get('shareSeekerPhone') === 'on',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message || 'No fue posible registrar la solicitud.');
      setLastRequestId(data.requestId ?? null);
      setMsg('Solicitud recibida. Por seguridad no podemos confirmar si esa persona está registrada, si inició sesión, si vio el mensaje o si decidió responder.');
      event.currentTarget.reset();
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible registrar la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!lastRequestId) return;
    setBusy(true);
    try {
      const response = await fetch(`${API}/reunification/requests/${encodeURIComponent(lastRequestId)}/withdraw`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'No fue posible retirar la solicitud.');
      setLastRequestId(null);
      setMsg('Solicitud de retiro procesada. No mostramos información sobre la actividad de la otra persona.');
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible retirar la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: 'REVEAL_CONTACT' | 'IGNORE' | 'BLOCK' | 'REPORT_ABUSE') {
    setBusy(true);
    setMsg('');
    try {
      const response = await fetch(`${API}/reunification/inbox/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message || 'No fue posible completar la acción.');

      if (action === 'REVEAL_CONTACT') {
        setContacts(current => ({
          ...current,
          [id]: { status: data.status, phone: data.contactPhone, warning: data.warning },
        }));
        if (data.status !== 'CONTACT_AVAILABLE') setMsg('La persona que dejó este aviso decidió no compartir un teléfono de contacto.');
      } else {
        if (action === 'REPORT_ABUSE') setMsg('Reporte recibido. Este solicitante quedó bloqueado para tu cuenta y el caso quedó marcado para revisión.');
        else if (action === 'BLOCK') setMsg('Solicitante bloqueado. No le informaremos que lo bloqueaste.');
        else setMsg('Mensaje ocultado. No le informaremos al solicitante.');
        await refreshInbox();
      }
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible completar la acción.');
    } finally {
      setBusy(false);
    }
  }

  if (!ENABLED) {
    return (
      <main className="wrap">
        <section className="hero">
          <h1>Reencuentro seguro</h1>
          <div className="alert"><strong>Función protegida por feature flag.</strong> Debe habilitarse únicamente cuando OTP, el secreto HMAC y los controles antiabuso estén configurados.</div>
        </section>
      </main>
    );
  }

  if (authenticated === false) {
    return (
      <main className="wrap">
        <section className="hero">
          <span className="badge">PRIVADO · ANTI-ACOSO</span>
          <h1>Reencontrarnos sin exponer a nadie</h1>
          <p className="muted lead">Verifica primero tu propio celular. Nadie podrá usar esta herramienta para consultar si otra persona está conectada, registrada o localizada.</p>
        </section>
        <OtpLogin audience="CITIZEN" onAuthenticated={() => void refreshInbox()} />
      </main>
    );
  }

  return (
    <main className="wrap">
      <section className="hero">
        <span className="badge">REUNIFICACIÓN FAMILIAR · PRIVADO</span>
        <h1>Reencuentro seguro</h1>
        <p className="muted lead">Puedes dejar un aviso para un número que conoces. Si esa persona autentica ese mismo número, solo ella podrá verlo y decidir si quiere contactarte.</p>
        <div className="alert"><strong>Protección esencial:</strong> nunca te diremos si la persona está registrada, si inició sesión, si abrió el aviso, dónde está ni qué decisión tomó.</div>
      </section>

      <section className="grid">
        <form className="card" onSubmit={createRequest}>
          <h2>Estoy buscando a alguien</h2>
          <p className="muted">Tu número de contacto se toma de tu OTP verificado; no puedes escribir aquí un número distinto haciéndolo pasar por tuyo.</p>

          <label>Número conocido de la persona buscada</label>
          <input name="targetPhone" inputMode="tel" autoComplete="off" placeholder="3001234567" required maxLength={24} />

          <label>Tu nombre o apodo</label>
          <input name="seekerDisplayName" maxLength={80} placeholder="Ej. Ana" />

          <label>Relación que declaras tener</label>
          <select name="declaredRelationship" defaultValue="">
            <option value="">Prefiero no indicarla</option>
            <option value="MADRE_PADRE">Madre / padre</option>
            <option value="HIJA_HIJO">Hija / hijo</option>
            <option value="HERMANA_HERMANO">Hermana / hermano</option>
            <option value="PAREJA">Pareja</option>
            <option value="FAMILIAR">Otro familiar</option>
            <option value="AMISTAD">Amistad</option>
            <option value="OTRA">Otra</option>
          </select>
          <p className="muted">La plataforma mostrará esta relación como <strong>declarada, no verificada</strong>.</p>

          <label>Mensaje breve</label>
          <textarea name="message" maxLength={280} rows={5} placeholder="Ej. Estamos intentando saber que estás bien. Si quieres, puedes llamarme." />
          <p className="muted">No se permiten enlaces. No publiques ubicación, documentos, contraseñas ni información que pueda poner a alguien en riesgo.</p>

          <label>
            <input name="shareSeekerPhone" type="checkbox" defaultChecked />{' '}
            Si esta persona recibe el aviso y lo decide, puede ver mi teléfono verificado para contactarme.
          </label>

          <button className="btn primary" disabled={busy} type="submit">{busy ? 'Procesando…' : 'Dejar aviso privado'}</button>

          {lastRequestId && (
            <div className="alert">
              <p>Referencia privada: <strong>{lastRequestId}</strong></p>
              <button className="btn secondary" disabled={busy} type="button" onClick={withdraw}>Retirar esta solicitud</button>
            </div>
          )}
        </form>

        <section className="card">
          <h2>Mensajes para mí</h2>
          <p className="muted">Estos mensajes aparecen únicamente porque el número de esta sesión fue verificado por OTP. Quien te busca no recibe confirmación de que estás aquí.</p>
          <div className="alert"><strong>Tú tienes el control.</strong> No compartimos con el solicitante tu número actual, ubicación, última actividad, lectura ni decisión. Si decides llamar o escribir desde tu celular, entonces tu propio canal de comunicación sí podría revelar tu número.</div>

          {inbox.length === 0 && <p>No tienes avisos privados de reencuentro en este momento.</p>}

          {inbox.map(item => {
            const contact = contacts[item.id];
            return (
              <article className="card" key={item.id}>
                <h3>{item.seekerDisplayName || 'Una persona con teléfono verificado'} te está buscando</h3>
                {item.declaredRelationship && <p><strong>Relación declarada:</strong> {item.declaredRelationship} <span className="muted">(no verificada)</span></p>}
                {item.message && <p>{item.message}</p>}
                <p className="muted">El sistema no ha confirmado que esta persona sea familiar, autoridad ni voluntario. Evalúa el contexto antes de contactarla.</p>

                {contact?.status === 'CONTACT_AVAILABLE' && contact.phone && (
                  <div className="alert">
                    <p><strong>Contacto verificado del solicitante:</strong> {contact.phone}</p>
                    <p>{contact.warning}</p>
                    <a className="btn primary" href={`tel:${contact.phone}`}>Llamar si yo lo decido</a>
                  </div>
                )}

                <div className="row">
                  {item.contactAvailable && !contact?.phone && (
                    <button className="btn primary" disabled={busy} type="button" onClick={() => act(item.id, 'REVEAL_CONTACT')}>Quiero ver el contacto</button>
                  )}
                  <button className="btn secondary" disabled={busy} type="button" onClick={() => act(item.id, 'IGNORE')}>Ocultar</button>
                  <button className="btn secondary" disabled={busy} type="button" onClick={() => act(item.id, 'BLOCK')}>Bloquear</button>
                  <button className="btn danger" disabled={busy} type="button" onClick={() => act(item.id, 'REPORT_ABUSE')}>Reportar abuso</button>
                </div>
              </article>
            );
          })}
        </section>
      </section>

      {msg && <p className="alert" aria-live="polite">{msg}</p>}
    </main>
  );
}
