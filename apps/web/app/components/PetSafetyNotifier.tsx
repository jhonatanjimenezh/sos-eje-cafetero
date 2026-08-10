'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const ENABLED = process.env.NEXT_PUBLIC_FEATURE_PET_SAFETY === 'true';

export default function PetSafetyNotifier() {
  const [hasMessages, setHasMessages] = useState(false);

  async function refresh() {
    if (!ENABLED) return;
    try {
      const [owner, finder] = await Promise.all([
        fetch(`${API}/pets/owner/inbox/summary`, { credentials: 'include', cache: 'no-store' }),
        fetch(`${API}/pets/finder/inbox/summary`, { credentials: 'include', cache: 'no-store' }),
      ]);
      if ([owner.status, finder.status].some(status => status === 401 || status === 503)) {
        setHasMessages(false);
        return;
      }
      if (!owner.ok || !finder.ok) return;
      const [ownerData, finderData] = await Promise.all([owner.json(), finder.json()]);
      setHasMessages(Number(ownerData?.pending ?? 0) + Number(finderData?.pending ?? 0) > 0);
    } catch {
      // Nunca interrumpir SOS por una notificación auxiliar.
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
        <strong>Hay nuevas pruebas privadas relacionadas con mascotas.</strong>{' '}
        <Link href="/mascotas">Abrir de forma segura</Link>. No mostramos teléfonos, domicilios ni ubicación exacta en esta notificación.
      </div>
    </div>
  );
}
