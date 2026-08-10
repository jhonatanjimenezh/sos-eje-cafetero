'use client';

import { useEffect } from 'react';
import { pruneExpiredOfflineState, requestPersistentStorage } from '../../lib/offline-db';
import { syncPendingIncidents } from '../../lib/offline-sync';
import { prepareSecureOfflineMode } from '../../lib/secure-envelope';

const OFFLINE_QUEUE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE === 'true';
const SECURE_ENVELOPE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_SECURE_ENVELOPE === 'true';
const SECURE_OFFLINE_ENABLED = OFFLINE_QUEUE_ENABLED && SECURE_ENVELOPE_ENABLED;

export default function PwaBootstrap() {
  useEffect(() => {
    let disposed = false;
    let syncing = false;

    const synchronize = async () => {
      if (!SECURE_OFFLINE_ENABLED || disposed || syncing || !navigator.onLine) return;
      syncing = true;
      try {
        await prepareSecureOfflineMode();
        await pruneExpiredOfflineState();
        await syncPendingIncidents();
      } catch {
        // Fail closed for persistence: nunca se degrada a payload plaintext.
        // La ruta online directa sigue disponible desde el formulario.
      } finally {
        syncing = false;
      }
    };

    // El service worker conserva únicamente el shell público. Nunca cachea /api/.
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    if (!SECURE_OFFLINE_ENABLED) return;

    requestPersistentStorage().catch(() => undefined);
    if (navigator.onLine) prepareSecureOfflineMode().catch(() => undefined);
    pruneExpiredOfflineState().catch(() => undefined);
    void synchronize();

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
