'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import OtpLogin from '../../components/OtpLogin';
import RekognitionLiveness from '../../components/RekognitionLiveness';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const FEATURE_LIVENESS = process.env.NEXT_PUBLIC_FEATURE_LIVENESS === 'true';
const LIVENESS_PROVIDER = (process.env.NEXT_PUBLIC_LIVENESS_PROVIDER ?? 'MANUAL').toUpperCase();

type Profile = {
  id: string;
  public_id: string;
  verification_status: string;
  full_name: string;
  document_type: string;
  document_last4: string;
  address?: string;
  city?: string;
  neighborhood?: string;
  household_size?: number;
  liveness_status?: string;
  open_review_request?: { id: string; kind: string; status: string } | null;
};

type UploadState = { assetId: string; malwareScanStatus: string };

export default function AffectedRegistration() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [msg, setMsg] = useState('');
  const [challenge, setChallenge] = useState<any>(null);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [stream, setStream] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  async function refresh() {
    const response = await fetch(`${API}/affected/me`, { credentials: 'include' });
    if (response.status === 401) {
      setAuth(false);
      return;
    }
    setAuth(response.ok);
    if (response.ok) setProfile(await response.json());
  }

  useEffect(() => { refresh(); }, []);

  function gps() {
    navigator.geolocation.getCurrentPosition(
      position => setLoc({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setMsg('No fue posible obtener GPS. Revisa el permiso de ubicación.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function profileBody(form: FormData) {
    if (!loc) throw new Error('Primero comparte ubicación GPS.');
    return {
      fullName: form.get('fullName'),
      documentType: form.get('documentType'),
      documentNumber: form.get('documentNumber'),
      address: form.get('address'),
      city: form.get('city') || 'Manizales',
      neighborhood: form.get('neighborhood') || undefined,
      householdSize: Number(form.get('householdSize') || 1),
      notes: form.get('notes') || undefined,
      lat: loc.lat,
      lng: loc.lng,
      consentSensitiveData: form.get('consent') === 'on',
      consentVersion: 'affected-consent-v2',
    };
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const response = await fetch(`${API}/affected/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profileBody(new FormData(e.currentTarget))),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message);
      setProfile(data);
      setMsg('Datos guardados. Continúa con la evidencia privada.');
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible guardar el expediente.');
    }
  }

  async function hash(blob: Blob) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function pollSecurity(assetId: string, kind: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const response = await fetch(`${API}/affected/evidence/${assetId}/security/refresh`, {
        method: 'POST', credentials: 'include',
      });
      if (!response.ok) return;
      const data = await response.json();
      setUploads(current => ({ ...current, [kind]: { assetId, malwareScanStatus: data.malwareScanStatus } }));
      if (!['PENDING', 'NOT_CONFIGURED'].includes(data.malwareScanStatus)) return;
    }
  }

  async function upload(kind: string, file: File | Blob, type: string) {
    if (!profile) return;
    if (!type) {
      setMsg('El dispositivo no informó el tipo MIME del archivo. Usa JPEG, PNG, WebP, MP4 o WebM.');
      return;
    }
    try {
      const sha256 = await hash(file);
      const presign = await fetch(`${API}/affected/${profile.id}/evidence/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kind, contentType: type, sizeBytes: file.size, sha256 }),
      });
      const prepared = await presign.json();
      if (!presign.ok) throw new Error(Array.isArray(prepared.message) ? prepared.message.join(', ') : prepared.message);

      const uploaded = await fetch(prepared.uploadUrl, {
        method: 'PUT',
        headers: prepared.uploadHeaders,
        body: file,
      });
      if (!uploaded.ok) throw new Error('Falló la carga privada de evidencia');

      const completed = await fetch(`${API}/affected/evidence/${prepared.assetId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sha256, sizeBytes: file.size }),
      });
      const result = await completed.json();
      if (!completed.ok) throw new Error(Array.isArray(result.message) ? result.message.join(', ') : result.message);

      setUploads(current => ({
        ...current,
        [kind]: { assetId: prepared.assetId, malwareScanStatus: result.malwareScanStatus },
      }));
      if (result.malwareScanStatus === 'PENDING') void pollSecurity(prepared.assetId, kind);
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible validar la evidencia.');
    }
  }

  async function challengeNow() {
    if (!profile) return;
    const response = await fetch(`${API}/affected/${profile.id}/liveness/challenge`, { method: 'POST', credentials: 'include' });
    const data = await response.json();
    if (response.ok) setChallenge(data);
    else setMsg(Array.isArray(data.message) ? data.message.join(', ') : data.message);
  }

  async function camera() {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      setStream(media);
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
    } catch {
      setMsg('Revisa los permisos de cámara y micrófono.');
    }
  }

  async function record() {
    if (!stream) return;
    const type = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const parts: BlobPart[] = [];
    recorder.ondataavailable = event => event.data.size && parts.push(event.data);
    recorder.onstop = async () => {
      const blob = new Blob(parts, { type });
      await upload('LIVENESS_VIDEO', blob, type);
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 8000);
  }

  async function submit() {
    if (!profile) return;
    const response = await fetch(`${API}/affected/${profile.id}/submit`, { method: 'POST', credentials: 'include' });
    const data = await response.json();
    if (!response.ok) {
      setMsg(Array.isArray(data.message) ? data.message.join(', ') : data.message);
      return;
    }
    setProfile(current => current ? { ...current, verification_status: data.status } : current);
    setMsg(`Registro ${data.publicId} enviado a verificación oficial. Ningún score biométrico toma la decisión final.`);
  }

  async function appeal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!profile) return;
    const form = new FormData(e.currentTarget);
    const response = await fetch(`${API}/affected/${profile.id}/review-requests`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'APPEAL', message: form.get('message') }),
    });
    const data = await response.json();
    if (!response.ok) setMsg(Array.isArray(data.message) ? data.message.join(', ') : data.message);
    else { setMsg('Apelación registrada para revisión humana.'); await refresh(); }
  }

  async function respondNeedsInfo(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!profile) return;
    const form = new FormData(e.currentTarget);
    if (!loc) { setMsg('Para corregir el expediente vuelve a compartir tu ubicación GPS.'); return; }
    try {
      const review = await fetch(`${API}/affected/${profile.id}/review-requests`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'NEEDS_INFO_RESPONSE', message: form.get('responseMessage') }),
      });
      const reviewData = await review.json();
      if (!review.ok) throw new Error(Array.isArray(reviewData.message) ? reviewData.message.join(', ') : reviewData.message);

      const updated = await fetch(`${API}/affected/profile`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileBody(form)),
      });
      const updatedData = await updated.json();
      if (!updated.ok) throw new Error(Array.isArray(updatedData.message) ? updatedData.message.join(', ') : updatedData.message);
      setProfile(updatedData);
      setMsg('Corrección guardada. Revisa o reemplaza las evidencias y vuelve a enviar el expediente.');
    } catch (error: any) {
      setMsg(error?.message ?? 'No fue posible registrar la corrección.');
    }
  }

  if (auth === null) return <main className="wrap"><div className="card">Cargando…</div></main>;
  if (!auth) return (
    <main className="wrap">
      <h1>Registro de damnificados</h1>
      <div className="alert"><b>Emergencia inmediata:</b> este registro nunca es requisito para pedir rescate.</div>
      <OtpLogin audience="CITIZEN" onAuthenticated={refresh} />
    </main>
  );

  if (profile?.verification_status === 'VERIFIED' || profile?.verification_status === 'PENDING_OFFICIAL_VERIFICATION') {
    return <main className="wrap"><div className="card">
      <span className="badge">{profile.public_id}</span>
      <h1>{profile.full_name}</h1>
      <h2>Estado: {profile.verification_status}</h2>
      <p>Documento terminado en {profile.document_last4}. La evidencia permanece privada y cada acceso oficial debe quedar auditado.</p>
      {profile.verification_status === 'PENDING_OFFICIAL_VERIFICATION' && <p>La decisión está en manos de un funcionario autorizado; liveness y antimalware son señales de seguridad, no decisiones automáticas.</p>}
    </div></main>;
  }

  if (profile?.verification_status === 'REJECTED') {
    return <main className="wrap"><div className="card">
      <span className="badge">{profile.public_id}</span><h1>Solicitar revisión</h1>
      <p>Un rechazo no elimina tu derecho a pedir revisión. Explica por qué consideras que debe revisarse nuevamente.</p>
      {profile.open_review_request ? <div className="alert">Ya existe una apelación abierta en revisión.</div> : <form onSubmit={appeal}>
        <label>Motivo de la apelación</label><textarea name="message" required minLength={10} />
        <button className="btn primary">Enviar apelación</button>
      </form>}
      {msg && <p className="alert">{msg}</p>}
    </div></main>;
  }

  if (profile?.verification_status === 'NEEDS_INFO') {
    return <main className="wrap"><div className="card">
      <span className="badge">{profile.public_id}</span><h1>Corregir información solicitada</h1>
      <p>El funcionario pidió información adicional. La corrección conserva el historial y vuelve a pasar por revisión humana.</p>
      <button className="btn primary" type="button" onClick={gps}>{loc ? '✓ GPS actualizado' : '📍 Volver a capturar ubicación'}</button>
      <form onSubmit={respondNeedsInfo}>
        <label>Respuesta al funcionario</label><textarea name="responseMessage" required minLength={10} />
        <label>Nombres completos</label><input name="fullName" defaultValue={profile.full_name} required />
        <label>Tipo de documento</label><select name="documentType" defaultValue={profile.document_type}><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="TI">Tarjeta de identidad</option><option value="PP">Pasaporte</option><option value="OTRO">Otro</option></select>
        <label>Número de identificación completo</label><input name="documentNumber" required autoComplete="off" />
        <label>Dirección afectada</label><input name="address" defaultValue={profile.address} required />
        <label>Ciudad</label><input name="city" defaultValue={profile.city ?? 'Manizales'} />
        <label>Barrio</label><input name="neighborhood" defaultValue={profile.neighborhood} />
        <label>Personas del hogar afectadas</label><input name="householdSize" type="number" min="1" max="50" defaultValue={profile.household_size ?? 1} />
        <label>Descripción/corrección adicional</label><textarea name="notes" />
        <label className="check"><input name="consent" type="checkbox" required /> Confirmo nuevamente el consentimiento para tratar estos datos sensibles durante la corrección.</label>
        <button className="btn danger">Guardar corrección</button>
      </form>
      {msg && <p className="alert">{msg}</p>}
    </div></main>;
  }

  return <main className="wrap">
    <h1>Registro guiado de damnificados</h1>
    {!profile ? <div className="card chat">
      <div className="bubble assistant"><b>Asistente:</b> Vamos paso a paso. OTP, documento, ubicación y revisión humana reducen suplantaciones sin bloquear una emergencia.</div>
      <button className="btn primary" type="button" onClick={gps}>{loc ? '✓ GPS capturado' : '📍 Compartir ubicación exacta'}</button>
      <form onSubmit={save}>
        <label>Nombres completos</label><input name="fullName" required />
        <label>Tipo de documento</label><select name="documentType"><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="TI">Tarjeta de identidad</option><option value="PP">Pasaporte</option><option value="OTRO">Otro</option></select>
        <label>Número de identificación</label><input name="documentNumber" required autoComplete="off" />
        <label>Dirección afectada</label><input name="address" required />
        <label>Ciudad</label><input name="city" defaultValue="Manizales" />
        <label>Barrio</label><input name="neighborhood" />
        <label>Personas del hogar afectadas</label><input name="householdSize" type="number" min="1" max="50" defaultValue="1" />
        <label>Descripción de afectación</label><textarea name="notes" />
        <label className="check"><input name="consent" type="checkbox" required /> Autorizo expresamente el tratamiento de datos sensibles para verificación antifraude y coordinación humanitaria.</label>
        <button className="btn danger">Guardar y continuar</button>
      </form>
    </div> : <div className="card chat">
      <div className="bubble assistant"><b>Asistente:</b> Necesito el documento por ambos lados. Los archivos se validan por tamaño, checksum, contenido real y análisis antimalware cuando está habilitado.</div>
      <h3>1. Documento frente</h3>
      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event => event.target.files?.[0] && upload('ID_FRONT', event.target.files[0], event.target.files[0].type)} />
      {uploads.ID_FRONT && <p className={uploads.ID_FRONT.malwareScanStatus === 'THREATS_FOUND' ? 'alert' : 'success'}>✓ Recibido · seguridad: {uploads.ID_FRONT.malwareScanStatus}</p>}
      <h3>2. Documento reverso</h3>
      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event => event.target.files?.[0] && upload('ID_BACK', event.target.files[0], event.target.files[0].type)} />
      {uploads.ID_BACK && <p className={uploads.ID_BACK.malwareScanStatus === 'THREATS_FOUND' ? 'alert' : 'success'}>✓ Recibido · seguridad: {uploads.ID_BACK.malwareScanStatus}</p>}

      <h3>3. Prueba de presencia</h3>
      {!FEATURE_LIVENESS && <div className="alert">La biometría/liveness está deshabilitada en este despliegue. El expediente seguirá usando OTP + documento + GPS + revisión oficial.</div>}
      {FEATURE_LIVENESS && LIVENESS_PROVIDER === 'REKOGNITION' && <RekognitionLiveness profileId={profile.id} onComplete={() => setProfile(current => current ? { ...current, liveness_status: 'PROVIDER_RESULT_AVAILABLE' } : current)} onMessage={setMsg} />}
      {FEATURE_LIVENESS && LIVENESS_PROVIDER === 'MANUAL' && <>
        {!challenge ? <button className="btn primary" type="button" onClick={challengeNow}>Generar reto manual</button> : <>
          <div className="alert"><b>Reto:</b> {challenge.challenge_text}</div>
          {!stream ? <button className="btn primary" type="button" onClick={camera}>Abrir cámara frontal</button> : <>
            <video ref={video} muted playsInline className="selfie-video" />
            <button className="btn danger" type="button" onClick={record}>Grabar 8 segundos</button>
          </>}
        </>}
        {uploads.LIVENESS_VIDEO && <p className="success">✓ Video recibido · seguridad: {uploads.LIVENESS_VIDEO.malwareScanStatus}</p>}
      </>}

      <hr />
      <button className="btn danger" type="button" onClick={submit}>Enviar a verificación oficial</button>
      <p>La aprobación o rechazo final requiere un funcionario autorizado. El sistema no asigna ni niega ayudas vitales automáticamente por una puntuación biométrica.</p>
    </div>}
    {msg && <p className="alert">{msg}</p>}
  </main>;
}
