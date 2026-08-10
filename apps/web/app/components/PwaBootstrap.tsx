'use client';

import { useEffect } from 'react';
import { requestPersistentStorage } from '../../lib/offline-db';
import { syncPendingIncidents } from '../../lib/offline-sync';

export default function PwaBootstrap() {
  useEffect(() => {
    let disposed = false;
    let syncing = false;

    const synchronize = async () => {
      if (disposed || syncing || !navigator.onLine) return;
      syncing = true;
      try {
        await syncPendingIncidents();
      } catch {
        // La cola permanece intacta. Se intentará de nuevo en el próximo trigger.
      } finally {
        syncing = false;
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

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
