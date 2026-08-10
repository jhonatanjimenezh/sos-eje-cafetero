'use client';

import { useState } from 'react';
import { FaceLivenessDetectorCore, type AwsCredentialProvider } from '@aws-amplify/ui-react-liveness';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

type Session = {
  provider: string;
  sessionId: string;
  region: string;
  expiresAt: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
  };
};

export default function RekognitionLiveness({
  profileId,
  onComplete,
  onMessage,
}: {
  profileId: string;
  onComplete: () => void;
  onMessage: (message: string) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);

  async function createSession() {
    if (!consent) {
      onMessage('Debes autorizar expresamente la prueba de presencia antes de iniciar la cámara.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API}/affected/${profileId}/liveness/session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentLiveness: true, consentVersion: 'liveness-consent-v1' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message);
      setSession(data);
    } catch (error: any) {
      onMessage(error?.message ?? 'No fue posible iniciar la prueba de presencia.');
    } finally {
      setLoading(false);
    }
  }

  const credentialProvider: AwsCredentialProvider = async () => {
    if (!session) throw new Error('Sesión de liveness no disponible');
    return {
      accessKeyId: session.credentials.accessKeyId,
      secretAccessKey: session.credentials.secretAccessKey,
      sessionToken: session.credentials.sessionToken,
      expiration: new Date(session.credentials.expiration),
    };
  };

  async function complete() {
    if (!session) return;
    setLoading(true);
    try {
      const response = await fetch(`${API}/affected/${profileId}/liveness/complete`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message);
      onMessage(data.message ?? 'Prueba de presencia registrada para revisión oficial.');
      onComplete();
      setSession(null);
    } catch (error: any) {
      onMessage(error?.message ?? 'No fue posible confirmar el resultado de liveness.');
    } finally {
      setLoading(false);
    }
  }

  if (!session) {
    return (
      <div>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
          Autorizo esta prueba de presencia facial únicamente para prevención de suplantación y revisión de mi expediente. Entiendo que el resultado no decide automáticamente si recibo ayuda.
        </label>
        <button className="btn primary" type="button" disabled={loading || !consent} onClick={createSession}>
          {loading ? 'Preparando…' : 'Iniciar prueba de presencia segura'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="alert">
        La cámara realizará una prueba guiada de presencia. La señal biométrica es solo un factor adicional y será revisada por personal autorizado.
      </div>
      <FaceLivenessDetectorCore
        sessionId={session.sessionId}
        region={session.region}
        onAnalysisComplete={complete}
        onError={(error) => {
          console.error('Face Liveness error', error);
          setSession(null);
          onMessage('La prueba de presencia no pudo completarse. Puedes iniciar un nuevo intento; los reintentos están limitados para prevenir fraude.');
        }}
        config={{ credentialProvider }}
      />
    </div>
  );
}
