'use client';

import { useEffect, useState } from 'react';
import OtpLogin from '../../components/OtpLogin';
import { petJson } from '../../../lib/pet-api';

const ENABLED = process.env.NEXT_PUBLIC_FEATURE_PET_SAFETY === 'true';

type QueueItem = {
  asset_id: string;
  case_id: string;
  kind: 'LOST' | 'FOUND';
  public_name: string;
  content_type: string;
  created_at: string;
};

type Review = {
  assetId: string;
  caseId: string;
  contentType: string;
  url: string;
  expiresIn: number;
  checklist: string[];
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'No fue posible completar la revisión.';
}

export default function PetPhotoReviewPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function refresh() {
    if (!ENABLED) return;
    try {
      const data = await petJson('/pets/moderation/photos');
      setAuthenticated(true);
      setQueue(Array.isArray(data) ? data : []);
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        setAuthenticated(false);
        setQueue([]);
        setReview(null);
      } else {
        setMsg(errorMessage(error));
      }
    }
  }

  useEffect(() => {
    if (ENABLED) void refresh();
  }, []);

  async function open(assetId: string) {
    setBusy(true);
    setMsg('');
    try {
      const data = await petJson(`/pets/moderation/photos/${encodeURIComponent(assetId)}`);
      setReview(data);
      setReason('');
    } catch (error) {
      setMsg(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'APPROVE' | 'REJECT') {
    if (!review) return;
    if (decision === 'REJECT' && !reason.trim()) {
      setMsg('Escribe un motivo breve para el rechazo. No copies teléfonos ni otros datos sensibles al motivo.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await petJson(`/pets/moderation/photos/${encodeURIComponent(review.assetId)}`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: decision === 'REJECT' ? reason : undefined }),
      });
      setMsg(decision === 'APPROVE'
        ? 'Fotografía aprobada para el catálogo público.'
        : 'Fotografía rechazada y retirada de la cola pública.');
      setReview(null);
      setReason('');
      await refresh();
    } catch (error) {
      setMsg(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!ENABLED) {
    return <main className="wrap"><section className="hero"><h1>Moderación de fotografías de mascotas</h1><div className="alert">Mascotas Seguras está deshabilitado.</div></section></main>;
  }

  return (
    <main className="wrap">
      <section className="hero">
        <span className="badge">OPERACIONAL · PRIVADO</span>
        <h1>Moderación de fotografías de mascotas</h1>
        <p className="muted lead">Una foto no entra al catálogo solo por superar antivirus y metadatos. Revisa que no sea un afiche/captura con teléfono, dirección, QR u otra información personal dibujada en la imagen.</p>
      </section>

      {authenticated === false && (
        <section className="card">
          <h2>Acceso oficial requerido</h2>
          <OtpLogin audience="OFFICIAL" onAuthenticated={() => void refresh()} />
        </section>
      )}

      {authenticated && !review && (
        <section className="card">
          <h2>Cola pendiente ({queue.length})</h2>
          {queue.length === 0 && <p>No hay fotografías pendientes.</p>}
          {queue.map(item => (
            <article className="card" key={item.asset_id}>
              <h3>{item.kind === 'LOST' ? item.public_name : 'Sin identificar'}</h3>
              <p className="muted">{item.kind} · Caso {item.case_id}</p>
              <button className="btn primary" disabled={busy} type="button" onClick={() => open(item.asset_id)}>Abrir revisión privada</button>
            </article>
          ))}
        </section>
      )}

      {authenticated && review && (
        <section className="card">
          <h2>Revisión privada</h2>
          <img src={review.url} alt="Fotografía pendiente de moderación" style={{ width: '100%', maxHeight: 560, objectFit: 'contain', borderRadius: 14 }} />
          <div className="alert">
            <strong>Checklist obligatorio</strong>
            <ul>{review.checklist.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
          <label>Motivo si rechazas</label>
          <textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={4} placeholder="Ej. contiene un número telefónico visible en la imagen." />
          <div className="row">
            <button className="btn primary" disabled={busy} type="button" onClick={() => decide('APPROVE')}>Aprobar foto limpia</button>
            <button className="btn danger" disabled={busy} type="button" onClick={() => decide('REJECT')}>Rechazar</button>
            <button className="btn secondary" disabled={busy} type="button" onClick={() => setReview(null)}>Volver</button>
          </div>
        </section>
      )}

      {msg && <p className="alert" aria-live="polite">{msg}</p>}
    </main>
  );
}
