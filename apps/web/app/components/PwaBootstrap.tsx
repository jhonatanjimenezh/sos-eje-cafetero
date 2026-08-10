'use client';

import { useEffect } from 'react';
import { requestPersistentStorage } from '../../lib/offline-db';
import { syncPendingIncidents } from '../../lib/offline-sync';

const OFFLINE_QUEUE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE === 'true';

export default function PwaBootstrap() {
  useEffect(() => {
    let disposed = false;
    let syncing = false;

    const synchronize = async () => {
      if (!OFFLINE_QUEUE_ENABLED || disposed || syncing || !navigator.onLine) return;
      syncing = true;
      try {
        await syncPendingIncidents();
      } catch {
        // La cola permanece intacta. Se intentará de nuevo en el próximo trigger.
      } finally {
        syncing = false;
      }
    };

    // El service worker puede seguir cacheando el shell público aunque la cola
    // offline sensible esté apagada. Nunca debe cachear respuestas /api/.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    if (!OFFLINE_QUEUE_ENABLED) return;

    requestPersistentStorage().catch(() => undefined);
    synchronize();

    const onOnline = () => void synchronize();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void synchronize();
    };
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SOS_SYNC_REQUEST') void synchronize();
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);

    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    };
  }, []);

  return null;
}
