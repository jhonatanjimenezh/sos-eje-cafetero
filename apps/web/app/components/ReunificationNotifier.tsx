'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const ENABLED = process.env.NEXT_PUBLIC_FEATURE_REUNIFICATION === 'true';

export default function ReunificationNotifier() {
  const [hasMessages, setHasMessages] = useState(false);

  async function refresh() {
    if (!ENABLED) return;
    try {
      const response = await fetch(`${API}/reunification/inbox/summary`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 503) {
        setHasMessages(false);
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      setHasMessages(Number(data?.count ?? 0) > 0);
    } catch {
      // La notificación nunca interrumpe el SOS ni otros flujos críticos.
    }
  }

  useEffect(() => {
    if (!ENABLED) return;
    void refresh();
    const onAuth = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('sos-auth-changed', onAuth);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener('sos-auth-changed', onAuth);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  if (!ENABLED || !hasMessages) return null;
  return (
    <div className="wrap" aria-live="polite">
      <div className="alert">
        <strong>Tienes mensajes privados de reencuentro.</strong>{' '}
        <Link href="/reencuentro">Abrir de forma segura</Link>. No compartimos tu ubicación, actividad ni inicio de sesión con quien te busca.
      </div>
    </div>
  );
}
