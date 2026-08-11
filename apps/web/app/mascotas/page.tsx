'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import OtpLogin from '../components/OtpLogin';
import { petJson, PET_API, sha256Hex, uploadSignedFile } from '../../lib/pet-api';

const ENABLED = process.env.NEXT_PUBLIC_FEATURE_PET_SAFETY === 'true';

type PetCase = {
  id: string;
  kind: 'LOST' | 'FOUND';
  name: string;
  status: string;
  photoUrl?: string | null;
};

type PetProfile = {
  public_id: string;
  pet_name: string;
  animal_type: 'DOG' | 'CAT' | 'BIRD' | 'OTHER';
  sex?: string;
  approximate_age_months?: number;
  breed?: string;
  color?: string;
  microchip_last4?: string;
};

type OwnerInboxItem = {
  claimId: string;
  caseId: string;
  petName: string;
  proofOfLifeReady: boolean;
  createdAt: string;
};

type FinderInboxItem = {
  claimId: string;
  caseId: string;
  claimedPetName: string;
  ownershipEvidenceReady: boolean;
  createdAt: string;
};

type ClaimWorkflow = {
  claimId: string;
  caseId: string;
  role: 'FINDER' | 'OWNER_CLAIMANT';
  challengeId?: string;
  challengeCode?: string;
  instructions?: string;
  evidenceReady?: boolean;
  pendingAssetId?: string;
  pendingSha256?: string;
  pendingSizeBytes?: number;
};

type EvidenceView = {
  url: string;
  contentType: string;
  warning?: string;
};

type ContactView = {
  phone?: string;
  status: string;
  warning?: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'No fue posible completar la operación.';
}

function animalLabel(type: string) {
  return ({ DOG: 'Perro', CAT: 'Gato', BIRD: 'Ave', OTHER: 'Otro' } as Record<string, string>)[type] ?? type;
}

export default function PetsPage() {
  const [tab, setTab] = useState<'LOST' | 'FOUND'>('LOST');
  const [cases, setCases] = useState<PetCase[]>([]);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<PetProfile[]>([]);
  const [ownerInbox, setOwnerInbox] = useState<OwnerInboxItem[]>([]);
  const [finderInbox, setFinderInbox] = useState<FinderInboxItem[]>([]);
  const [selectedCase, setSelectedCase] = useState<PetCase | null>(null);
  const [claimSharePhone, setClaimSharePhone] = useState(false);
  const [claimProfileId, setClaimProfileId] = useState('');
  const [workflow, setWorkflow] = useState<ClaimWorkflow | null>(null);
  const [claimFile, setClaimFile] = useState<File | null>(null);
  const [evidenceViews, setEvidenceViews] = useState<Record<string, EvidenceView>>({});
  const [contacts, setContacts] = useState<Record<string, ContactView>>({});
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [pendingCasePhoto, setPendingCasePhoto] = useState<{
    assetId: string;
    sha256: string;
    sizeBytes: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.public_id === claimProfileId) ?? null,
    [profiles, claimProfileId],
  );

  async function refreshPublic(nextTab = tab) {
    if (!ENABLED) return;
    try {
      const response = await fetch(`${PET_API}/pets/cases?kind=${nextTab}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await response.json().catch(() => []);
      if (!response.ok) throw new Error(data?.message || 'No fue posible cargar el catálogo.');
      setCases(Array.isArray(data) ? data : []);
    } catch (error) {
      setMsg(messageOf(error));
    }
  }

  async function refreshPrivate() {
    if (!ENABLED) return;
    try {
      const response = await fetch(`${PET_API}/pets/profiles/me`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (response.status === 401) {
        setAuthenticated(false);
        setProfiles([]);
        setOwnerInbox([]);
        setFinderInbox([]);
        return;
      }
      const data = await response.json().catch(() => []);
      if (!response.ok) throw new Error(data?.message || 'No fue posible abrir tu espacio privado.');
      setAuthenticated(true);
      setProfiles(Array.isArray(data) ? data : []);
      const [owner, finder] = await Promise.all([
        petJson('/pets/owner/inbox'),
        petJson('/pets/finder/inbox'),
      ]);
      setOwnerInbox(Array.isArray(owner) ? owner : []);
      setFinderInbox(Array.isArray(finder) ? finder : []);
    } catch (error: any) {
      if (error?.status === 401) setAuthenticated(false);
      else setMsg(messageOf(error));
    }
  }

  useEffect(() => {
    if (!ENABLED) return;
    void refreshPublic(tab);
  }, [tab]);

  useEffect(() => {
    if (!ENABLED) return;
    void refreshPrivate();
    try {
      const stored = window.localStorage.getItem('sos-pet-last-claim');
      if (stored) setWorkflow(JSON.parse(stored));
    } catch {
      // El claim ID es opaco; si storage está dañado simplemente se ignora.
    }
  }, []);

  function saveWorkflow(next: ClaimWorkflow | null) {
    setWorkflow(next);
    try {
      if (next) window.localStorage.setItem('sos-pet-last-claim', JSON.stringify(next));
      else window.localStorage.removeItem('sos-pet-last-claim');
    } catch {
      // El flujo sigue funcionando durante la sesión actual aunque localStorage falle.
    }
  }

  function locate() {
    setMsg('');
    if (!navigator.geolocation) {
      setMsg('Este dispositivo no permite obtener ubicación. Puedes continuar sin compartirla.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => {
        setLat(position.coords.latitude);
        setLng(position.coords.longitude);
        setMsg('Ubicación guardada de forma privada para ayudar al matching. No se mostrará en el catálogo público.');
      },
      () => setMsg('No fue posible obtener ubicación. Puedes continuar sin compartirla.'),
      { enableHighAccuracy: true, timeout: 12_000 },
    );
  }

  async function uploadCasePhoto(caseId: string, file: File) {
    const sha256 = await sha256Hex(file);
    const signed = await petJson(`/pets/cases/${encodeURIComponent(caseId)}/photo/presign`, {
      method: 'POST',
      body: JSON.stringify({ sha256, sizeBytes: file.size, contentType: file.type }),
    });
    await uploadSignedFile(file, signed);
    const completed = await petJson(`/pets/case-photo/${encodeURIComponent(signed.assetId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256, sizeBytes: file.size }),
    });
    if (completed.status === 'SCAN_PENDING') {
      setPendingCasePhoto({ assetId: signed.assetId, sha256, sizeBytes: file.size });
    } else {
      setPendingCasePhoto(null);
    }
    return completed.status;
  }

  async function retryCasePhotoScan() {
    if (!pendingCasePhoto) return;
    setBusy(true);
    setMsg('');
    try {
      const completed = await petJson(`/pets/case-photo/${encodeURIComponent(pendingCasePhoto.assetId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256: pendingCasePhoto.sha256, sizeBytes: pendingCasePhoto.sizeBytes }),
      });
      if (completed.status === 'READY') {
        setPendingCasePhoto(null);
        setMsg('Foto validada y habilitada para el catálogo.');
        await refreshPublic(tab);
      } else {
        setMsg('La foto sigue en revisión automática de seguridad.');
      }
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const form = new FormData(event.currentTarget);
      const ageRaw = String(form.get('approximateAgeMonths') ?? '').trim();
      const payload = {
        petName: form.get('petName'),
        animalType: form.get('animalType'),
        sex: form.get('sex'),
        approximateAgeMonths: ageRaw ? Number(ageRaw) : undefined,
        breed: form.get('breed') || undefined,
        color: form.get('color') || undefined,
        sterilized: form.get('sterilized') === 'on',
        microchip: form.get('microchip') || undefined,
        ownerFullName: form.get('ownerFullName'),
        ownerDocumentType: form.get('ownerDocumentType') || undefined,
        ownerDocumentNumber: form.get('ownerDocumentNumber') || undefined,
        privateDistinguishingMarks: form.get('privateDistinguishingMarks') || undefined,
        consentVersion: 'pet-safety-v1',
      };
      await petJson('/pets/profiles', { method: 'POST', body: JSON.stringify(payload) });
      event.currentTarget.reset();
      setMsg('Perfil privado de mascota registrado. Los identificadores sensibles no forman parte del catálogo público.');
      await refreshPrivate();
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function createLost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const form = new FormData(event.currentTarget);
      const profileId = String(form.get('petProfilePublicId') ?? '');
      const profile = profiles.find(item => item.public_id === profileId);
      if (!profile) throw new Error('Selecciona una mascota registrada.');
      const photo = form.get('photo');
      if (!(photo instanceof File) || !photo.size) throw new Error('Selecciona una fotografía de la mascota.');
      const created = await petJson('/pets/cases', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'LOST',
          petProfilePublicId: profile.public_id,
          animalType: profile.animal_type,
          lat: lat ?? undefined,
          lng: lng ?? undefined,
          shareCreatorPhone: false,
        }),
      });
      const uploadStatus = await uploadCasePhoto(created.public_id, photo);
      event.currentTarget.reset();
      setLat(null);
      setLng(null);
      setMsg(uploadStatus === 'READY'
        ? 'Caso PERDIDO creado. El catálogo público mostrará únicamente la fotografía y el nombre.'
        : 'Caso creado. La fotografía quedará visible cuando finalice el control automático de seguridad.');
      await refreshPublic('LOST');
      setTab('LOST');
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function createFound(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const form = new FormData(event.currentTarget);
      const photo = form.get('photo');
      if (!(photo instanceof File) || !photo.size) throw new Error('Selecciona una fotografía del animal encontrado.');
      const created = await petJson('/pets/cases', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'FOUND',
          animalType: form.get('animalType'),
          lat: lat ?? undefined,
          lng: lng ?? undefined,
          shareCreatorPhone: form.get('shareCreatorPhone') === 'on',
        }),
      });
      const uploadStatus = await uploadCasePhoto(created.public_id, photo);
      event.currentTarget.reset();
      setLat(null);
      setLng(null);
      setMsg(uploadStatus === 'READY'
        ? 'Caso ENCONTRADO creado. No publicamos quién lo tiene, teléfono ni ubicación.'
        : 'Caso creado. La fotografía quedará visible cuando finalice el control automático de seguridad.');
      await refreshPublic('FOUND');
      setTab('FOUND');
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function chooseCase(petCase: PetCase) {
    setSelectedCase(petCase);
    setClaimSharePhone(false);
    setClaimProfileId('');
    setMsg(authenticated === false
      ? 'Para continuar debes verificar tu propio celular mediante OTP. El catálogo no revelará datos de la otra persona.'
      : 'Completa el paso privado para aportar evidencia.');
  }

  async function createClaim() {
    if (!selectedCase) return;
    if (!authenticated) {
      setMsg('Verifica primero tu celular mediante OTP.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const role = selectedCase.kind === 'LOST' ? 'FINDER' : 'OWNER_CLAIMANT';
      if (role === 'OWNER_CLAIMANT' && !selectedProfile) throw new Error('Selecciona tu mascota registrada para reclamar este caso.');
      const claim = await petJson(`/pets/cases/${encodeURIComponent(selectedCase.id)}/claims`, {
        method: 'POST',
        body: JSON.stringify({
          role,
          petProfilePublicId: role === 'OWNER_CLAIMANT' ? selectedProfile?.public_id : undefined,
          shareClaimantPhone: claimSharePhone,
        }),
      });
      let next: ClaimWorkflow = {
        claimId: claim.claimId,
        caseId: selectedCase.id,
        role,
      };
      if (role === 'FINDER') {
        const challenge = await petJson(`/pets/claims/${encodeURIComponent(claim.claimId)}/challenge`, { method: 'POST' });
        next = {
          ...next,
          challengeId: challenge.challengeId,
          challengeCode: challenge.challengeCode,
          instructions: challenge.instructions,
        };
      }
      saveWorkflow(next);
      setSelectedCase(null);
      setClaimFile(null);
      setMsg(role === 'FINDER'
        ? 'Claim privado creado. Ahora graba la prueba de vida con el challenge temporal.'
        : 'Reclamación privada creada. Aporta evidencia histórica que ayude a demostrar que la mascota es tuya.');
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadClaimEvidence() {
    if (!workflow || !claimFile) return;
    setBusy(true);
    setMsg('');
    try {
      const sha256 = await sha256Hex(claimFile);
      const kind = workflow.role === 'FINDER' ? 'PROOF_OF_LIFE' : 'OWNERSHIP_HISTORY';
      const signed = await petJson(`/pets/claims/${encodeURIComponent(workflow.claimId)}/evidence/presign`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          sha256,
          sizeBytes: claimFile.size,
          contentType: claimFile.type,
          challengeId: workflow.role === 'FINDER' ? workflow.challengeId : undefined,
        }),
      });
      await uploadSignedFile(claimFile, signed);
      const completed = await petJson(`/pets/claim-evidence/${encodeURIComponent(signed.assetId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256, sizeBytes: claimFile.size }),
      });
      const next = {
        ...workflow,
        evidenceReady: completed.status === 'READY',
        pendingAssetId: completed.status === 'SCAN_PENDING' ? signed.assetId : undefined,
        pendingSha256: completed.status === 'SCAN_PENDING' ? sha256 : undefined,
        pendingSizeBytes: completed.status === 'SCAN_PENDING' ? claimFile.size : undefined,
      };
      saveWorkflow(next);
      setMsg(completed.status === 'READY'
        ? 'Evidencia privada validada. La otra parte podrá revisarla sin recibir todavía tu teléfono ni ubicación.'
        : 'La evidencia fue recibida y sigue en revisión automática de seguridad.');
      await refreshPrivate();
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryClaimScan() {
    if (!workflow?.pendingAssetId || !workflow.pendingSha256 || !workflow.pendingSizeBytes) return;
    setBusy(true);
    setMsg('');
    try {
      const completed = await petJson(`/pets/claim-evidence/${encodeURIComponent(workflow.pendingAssetId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256: workflow.pendingSha256, sizeBytes: workflow.pendingSizeBytes }),
      });
      if (completed.status === 'READY') {
        saveWorkflow({ ...workflow, evidenceReady: true, pendingAssetId: undefined, pendingSha256: undefined, pendingSizeBytes: undefined });
        setMsg('Evidencia validada y disponible para revisión privada.');
        await refreshPrivate();
      } else {
        setMsg('La evidencia sigue en revisión automática de seguridad.');
      }
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(claimId: string, side: 'owner' | 'finder') {
    setBusy(true);
    setMsg('');
    try {
      const data = await petJson(`/pets/${side}/inbox/${encodeURIComponent(claimId)}/evidence`);
      setEvidenceViews(current => ({ ...current, [claimId]: data }));
      setMsg('Prueba privada abierta mediante enlace temporal. Revísala antes de autorizar cualquier contacto o entrega.');
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function ownerAction(claimId: string, action: 'AUTHORIZE_CONTACT' | 'REJECT' | 'BLOCK' | 'REPORT_ABUSE') {
    if (action === 'AUTHORIZE_CONTACT' && !evidenceViews[claimId]) {
      setMsg('Primero abre y revisa la prueba de vida privada antes de autorizar que compartamos tu teléfono.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const data = await petJson(`/pets/owner/inbox/${encodeURIComponent(claimId)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setMsg(data.warning || data.notice || (action === 'AUTHORIZE_CONTACT'
        ? 'Autorización registrada.'
        : 'Decisión privada registrada. No enviamos un recibo de rechazo/bloqueo a la otra persona.'));
      if (action === 'BLOCK' || action === 'REPORT_ABUSE') await refreshPrivate();
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function finderAction(claimId: string, action: 'ACCEPT_OWNER' | 'REJECT_OWNER' | 'BLOCK_OWNER' | 'REPORT_ABUSE') {
    if (action === 'ACCEPT_OWNER' && !evidenceViews[claimId]) {
      setMsg('Primero abre y revisa la evidencia histórica privada antes de aceptar a un supuesto propietario.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const data = await petJson(`/pets/finder/inbox/${encodeURIComponent(claimId)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setMsg(data.notice || 'Decisión privada registrada.');
      if (action === 'BLOCK_OWNER' || action === 'REPORT_ABUSE') await refreshPrivate();
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function getContact(claimId: string, path: string) {
    setBusy(true);
    setMsg('');
    try {
      const data = await petJson(path);
      setContacts(current => ({ ...current, [claimId]: data }));
      setMsg(data.status === 'CONTACT_AVAILABLE'
        ? 'Contacto OTP-verificado disponible por consentimiento. No se comparte domicilio ni ubicación.'
        : 'No hay un contacto autorizado disponible. Por seguridad no mostramos el motivo.');
    } catch (error) {
      setMsg(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (!ENABLED) {
    return (
      <main className="wrap">
        <section className="hero">
          <span className="badge">MASCOTAS · PROTEGIDO</span>
          <h1>Mascotas perdidas y encontradas</h1>
          <div className="alert"><strong>Función protegida por feature flag.</strong> Solo debe habilitarse cuando OTP real, almacenamiento cifrado, scanner de evidencia y controles anti-extorsión hayan superado el gate operacional.</div>
        </section>
      </main>
    );
  }

  return (
    <main className="wrap">
      <section className="hero">
        <span className="badge">🐾 PERDIDOS · ENCONTRADOS · ANTI-EXTORSIÓN</span>
        <h1>Ayudemos a que vuelvan a casa</h1>
        <p className="muted lead">El catálogo público muestra únicamente la fotografía y el nombre o “Sin identificar”. Teléfonos, identidad, ubicación exacta y pruebas permanecen fuera de la vista pública.</p>
        <div className="alert"><strong>No pagues por una supuesta prueba.</strong> Si alguien afirma tener una mascota, debe verificar su celular y aportar una prueba privada dentro del sistema. No publiques tu teléfono ni domicilio.</div>
      </section>

      <section className="card">
        <div className="row">
          <button className={`btn ${tab === 'LOST' ? 'primary' : 'secondary'}`} type="button" onClick={() => setTab('LOST')}>🔎 Perdidos</button>
          <button className={`btn ${tab === 'FOUND' ? 'primary' : 'secondary'}`} type="button" onClick={() => setTab('FOUND')}>🐾 Encontrados</button>
        </div>
        <p className="muted">{tab === 'LOST' ? 'Mascotas reportadas como perdidas.' : 'Animales encontrados aunque nadie los haya reportado previamente.'}</p>
        <section className="grid">
          {cases.length === 0 && <div className="card"><p>No hay casos visibles en esta sección todavía.</p></div>}
          {cases.map(petCase => (
            <article className="card" key={petCase.id}>
              {petCase.photoUrl
                ? <img src={petCase.photoUrl} alt={petCase.name} style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 14 }} />
                : <div className="alert">Fotografía en validación de seguridad</div>}
              <h2>{petCase.name}</h2>
              <p className="muted">{petCase.kind === 'LOST' ? 'PERDIDO' : 'ENCONTRADO'}</p>
              <button className="btn primary" type="button" onClick={() => chooseCase(petCase)}>
                {petCase.kind === 'LOST' ? 'Creo que la encontré' : 'Creo que es mi mascota'}
              </button>
            </article>
          ))}
        </section>
      </section>

      {selectedCase && (
        <section className="card">
          <h2>{selectedCase.kind === 'LOST' ? 'Tengo información / encontré esta mascota' : 'Creo que este animal es mío'}</h2>
          <p className="muted">No revelaremos datos de ninguna de las partes en este paso.</p>
          {authenticated === false && <OtpLogin audience="CITIZEN" onAuthenticated={() => void refreshPrivate()} />}
          {authenticated && selectedCase.kind === 'FOUND' && (
            <>
              <label>Selecciona tu mascota registrada</label>
              <select value={claimProfileId} onChange={event => setClaimProfileId(event.target.value)}>
                <option value="">Seleccionar…</option>
                {profiles.map(profile => (
                  <option key={profile.public_id} value={profile.public_id}>{profile.pet_name} · {animalLabel(profile.animal_type)}</option>
                ))}
              </select>
              {profiles.length === 0 && <p className="alert">Primero registra tu mascota de forma privada más abajo. El caso encontrado seguirá disponible.</p>}
            </>
          )}
          {authenticated && (
            <>
              <label>
                <input type="checkbox" checked={claimSharePhone} onChange={event => setClaimSharePhone(event.target.checked)} />{' '}
                Autorizo que mi teléfono OTP-verificado pueda mostrarse a la otra persona únicamente después de la evidencia/aceptación definida por este flujo.
              </label>
              <div className="row">
                <button className="btn primary" disabled={busy} type="button" onClick={createClaim}>Continuar de forma privada</button>
                <button className="btn secondary" disabled={busy} type="button" onClick={() => setSelectedCase(null)}>Cancelar</button>
              </div>
            </>
          )}
        </section>
      )}

      {workflow && authenticated && (
        <section className="card">
          <h2>{workflow.role === 'FINDER' ? 'Prueba privada de vida' : 'Prueba privada de propiedad'}</h2>
          <p>Referencia privada: <strong>{workflow.claimId}</strong></p>
          {workflow.role === 'FINDER' && (
            <div className="alert">
              <p><strong>Challenge temporal:</strong> {workflow.challengeCode}</p>
              <p>{workflow.instructions}</p>
              <p className="muted">El video ayuda a demostrar que tienes al animal ahora; no es una prueba matemática infalible y será evaluado por una persona.</p>
            </div>
          )}
          {workflow.role === 'OWNER_CLAIMANT' && (
            <div className="alert">
              <strong>Usa evidencia anterior al desastre.</strong> Fotos o videos históricos, documentos veterinarios no sensibles u otros elementos que demuestren una relación previa con la mascota. No subas contraseñas ni datos bancarios.
            </div>
          )}
          {!workflow.evidenceReady && !workflow.pendingAssetId && (
            <>
              <label>{workflow.role === 'FINDER' ? 'Video del animal con el challenge' : 'Foto o video histórico'}</label>
              <input
                type="file"
                accept={workflow.role === 'FINDER' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime'}
                onChange={event => setClaimFile(event.target.files?.[0] ?? null)}
              />
              <button className="btn primary" disabled={busy || !claimFile} type="button" onClick={uploadClaimEvidence}>Subir prueba privada</button>
            </>
          )}
          {workflow.pendingAssetId && (
            <div className="alert">
              <p>La prueba está esperando el resultado del análisis automático de seguridad.</p>
              <button className="btn secondary" disabled={busy} type="button" onClick={retryClaimScan}>Comprobar seguridad del archivo</button>
            </div>
          )}
          {workflow.evidenceReady && (
            <div className="alert">
              <strong>Prueba lista.</strong> La otra parte puede revisarla de manera privada. Tu teléfono todavía no se comparte salvo que se cumplan los consentimientos del flujo.
            </div>
          )}
          {workflow.evidenceReady && workflow.role === 'FINDER' && (
            <button className="btn secondary" disabled={busy} type="button" onClick={() => getContact(workflow.claimId, `/pets/claims/${encodeURIComponent(workflow.claimId)}/contact`)}>Consultar si el propietario autorizó un contacto</button>
          )}
          {workflow.evidenceReady && workflow.role === 'OWNER_CLAIMANT' && (
            <button className="btn secondary" disabled={busy} type="button" onClick={() => getContact(workflow.claimId, `/pets/found-claims/${encodeURIComponent(workflow.claimId)}/finder-contact`)}>Consultar contacto autorizado de quien lo encontró</button>
          )}
          {contacts[workflow.claimId]?.status === 'CONTACT_AVAILABLE' && contacts[workflow.claimId]?.phone && (
            <div className="alert">
              <p><strong>Contacto OTP-verificado autorizado:</strong> {contacts[workflow.claimId].phone}</p>
              <p>{contacts[workflow.claimId].warning}</p>
              <a className="btn primary" href={`tel:${contacts[workflow.claimId].phone}`}>Llamar si yo lo decido</a>
            </div>
          )}
        </section>
      )}

      {authenticated === false && !selectedCase && (
        <section className="card">
          <h2>Espacio privado</h2>
          <p className="muted">Para registrar una mascota, reportar un animal encontrado o revisar pruebas debes verificar tu propio celular. El OTP no confirma públicamente si ya existía una cuenta.</p>
          <OtpLogin audience="CITIZEN" onAuthenticated={() => void refreshPrivate()} />
        </section>
      )}

      {authenticated && (
        <>
          <section className="grid">
            <form className="card" onSubmit={createProfile}>
              <h2>Registrar mi mascota</h2>
              <p className="muted">Estos datos ayudan a probar propiedad. Solo foto y nombre podrán aparecer en un caso público; los identificadores privados no forman parte del catálogo.</p>
              <label>Nombre de la mascota</label>
              <input name="petName" required maxLength={80} />
              <label>Tipo</label>
              <select name="animalType" required defaultValue="DOG">
                <option value="DOG">Perro</option><option value="CAT">Gato</option><option value="BIRD">Ave</option><option value="OTHER">Otro</option>
              </select>
              <label>Sexo</label>
              <select name="sex" defaultValue="UNKNOWN">
                <option value="UNKNOWN">No indicado</option><option value="FEMALE">Hembra</option><option value="MALE">Macho</option>
              </select>
              <label>Edad aproximada en meses</label>
              <input name="approximateAgeMonths" type="number" min="0" max="600" />
              <label>Raza (opcional)</label><input name="breed" maxLength={80} />
              <label>Color (opcional)</label><input name="color" maxLength={80} />
              <label><input name="sterilized" type="checkbox" /> Esterilizada/o</label>
              <label>Microchip (opcional)</label><input name="microchip" maxLength={64} autoComplete="off" />
              <hr />
              <label>Nombre del propietario</label><input name="ownerFullName" required maxLength={120} />
              <label>Tipo de documento (opcional)</label><input name="ownerDocumentType" placeholder="CC" maxLength={24} />
              <label>Número de documento (opcional)</label><input name="ownerDocumentNumber" autoComplete="off" maxLength={40} />
              <label>Rasgos que solo un propietario debería conocer</label>
              <textarea name="privateDistinguishingMarks" rows={5} maxLength={800} placeholder="Ej. cicatriz bajo el collar, marca escondida, comportamiento o detalle no publicado." />
              <div className="alert">
                <strong>Privacidad:</strong> tus datos personales y las pruebas privadas se protegen cifrados en tránsito y en reposo, fuera del catálogo público, con acceso autenticado y auditado. No compartiremos datos de contacto con otra persona sin el consentimiento previsto por el flujo.
              </div>
              <label><input type="checkbox" required /> Entiendo y autorizo este tratamiento limitado para recuperar mi mascota.</label>
              <button className="btn primary" disabled={busy} type="submit">Registrar de forma privada</button>
            </form>

            <form className="card" onSubmit={createLost}>
              <h2>Mi mascota está perdida</h2>
              <label>Mascota registrada</label>
              <select name="petProfilePublicId" required defaultValue="">
                <option value="">Seleccionar…</option>
                {profiles.map(profile => <option key={profile.public_id} value={profile.public_id}>{profile.pet_name} · {animalLabel(profile.animal_type)}</option>)}
              </select>
              <label>Fotografía que sí autorizas mostrar</label>
              <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required />
              <button className="btn secondary" type="button" onClick={locate}>Usar mi ubicación de forma privada</button>
              {lat != null && lng != null && <p className="muted">Ubicación recibida. No se publicarán coordenadas.</p>}
              <button className="btn danger" disabled={busy || profiles.length === 0} type="submit">Publicar como PERDIDA</button>
            </form>

            <form className="card" onSubmit={createFound}>
              <h2>Encontré un animal</h2>
              <p className="muted">No necesitas que exista un reporte previo. El nombre público será “Sin identificar”.</p>
              <label>Tipo</label>
              <select name="animalType" required defaultValue="DOG">
                <option value="DOG">Perro</option><option value="CAT">Gato</option><option value="BIRD">Ave</option><option value="OTHER">Otro</option>
              </select>
              <label>Fotografía</label>
              <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required />
              <button className="btn secondary" type="button" onClick={locate}>Guardar ubicación exacta solo de forma privada</button>
              {lat != null && lng != null && <p className="muted">Ubicación recibida. No se mostrará públicamente.</p>}
              <label><input name="shareCreatorPhone" type="checkbox" /> Si un supuesto propietario aporta evidencia y yo la acepto, permito que pueda ver mi teléfono OTP-verificado.</label>
              <button className="btn primary" disabled={busy} type="submit">Publicar como ENCONTRADO</button>
            </form>
          </section>

          {pendingCasePhoto && (
            <section className="card">
              <h2>Foto esperando control de seguridad</h2>
              <button className="btn secondary" disabled={busy} type="button" onClick={retryCasePhotoScan}>Comprobar de nuevo</button>
            </section>
          )}

          <section className="grid">
            <div className="card">
              <h2>Pruebas sobre mis mascotas perdidas</h2>
              <p className="muted">Que alguien haya subido un video no significa que debas confiar automáticamente. Revisa el challenge y nunca envíes dinero por adelantado.</p>
              {ownerInbox.length === 0 && <p>No hay pruebas privadas pendientes.</p>}
              {ownerInbox.map(item => (
                <article className="card" key={item.claimId}>
                  <h3>{item.petName}</h3>
                  <p>Alguien OTP-verificado afirma haber encontrado esta mascota y aportó una prueba privada.</p>
                  <button className="btn primary" disabled={busy} type="button" onClick={() => openEvidence(item.claimId, 'owner')}>Ver prueba de vida privada</button>
                  {evidenceViews[item.claimId] && (
                    <div className="alert">
                      <video controls preload="metadata" src={evidenceViews[item.claimId].url} style={{ width: '100%', maxHeight: 420 }} />
                      <p>{evidenceViews[item.claimId].warning}</p>
                    </div>
                  )}
                  <div className="row">
                    <button className="btn secondary" disabled={busy || !evidenceViews[item.claimId]} type="button" onClick={() => getContact(item.claimId, `/pets/owner/inbox/${encodeURIComponent(item.claimId)}/finder-contact`)}>Ver teléfono del finder si lo autorizó</button>
                    <button className="btn primary" disabled={busy || !evidenceViews[item.claimId]} type="button" onClick={() => ownerAction(item.claimId, 'AUTHORIZE_CONTACT')}>Autorizar que vea mi teléfono</button>
                    <button className="btn secondary" disabled={busy} type="button" onClick={() => ownerAction(item.claimId, 'REJECT')}>Rechazar</button>
                    <button className="btn secondary" disabled={busy} type="button" onClick={() => ownerAction(item.claimId, 'BLOCK')}>Bloquear</button>
                    <button className="btn danger" disabled={busy} type="button" onClick={() => ownerAction(item.claimId, 'REPORT_ABUSE')}>Reportar intento de abuso</button>
                  </div>
                  {contacts[item.claimId]?.status === 'CONTACT_AVAILABLE' && contacts[item.claimId]?.phone && (
                    <div className="alert">
                      <p><strong>Teléfono OTP-verificado:</strong> {contacts[item.claimId].phone}</p>
                      <p>{contacts[item.claimId].warning}</p>
                      <a className="btn primary" href={`tel:${contacts[item.claimId].phone}`}>Llamar si yo lo decido</a>
                    </div>
                  )}
                </article>
              ))}
            </div>

            <div className="card">
              <h2>Personas que reclaman animales que encontré</h2>
              <p className="muted">No entregues un animal solo porque alguien conozca su nombre o haya visto una foto pública. Revisa evidencia histórica privada.</p>
              {finderInbox.length === 0 && <p>No hay reclamaciones privadas pendientes.</p>}
              {finderInbox.map(item => (
                <article className="card" key={item.claimId}>
                  <h3>Reclamación para {item.claimedPetName}</h3>
                  <button className="btn primary" disabled={busy} type="button" onClick={() => openEvidence(item.claimId, 'finder')}>Ver evidencia histórica privada</button>
                  {evidenceViews[item.claimId] && (
                    <div className="alert">
                      {evidenceViews[item.claimId].contentType.startsWith('video/')
                        ? <video controls preload="metadata" src={evidenceViews[item.claimId].url} style={{ width: '100%', maxHeight: 420 }} />
                        : <img src={evidenceViews[item.claimId].url} alt="Evidencia privada de propiedad" style={{ width: '100%', maxHeight: 420, objectFit: 'contain' }} />}
                      <p>{evidenceViews[item.claimId].warning}</p>
                    </div>
                  )}
                  <div className="row">
                    <button className="btn primary" disabled={busy || !evidenceViews[item.claimId]} type="button" onClick={() => finderAction(item.claimId, 'ACCEPT_OWNER')}>La evidencia me convence</button>
                    <button className="btn secondary" disabled={busy || !evidenceViews[item.claimId]} type="button" onClick={() => getContact(item.claimId, `/pets/finder/inbox/${encodeURIComponent(item.claimId)}/owner-contact`)}>Ver contacto autorizado</button>
                    <button className="btn secondary" disabled={busy} type="button" onClick={() => finderAction(item.claimId, 'REJECT_OWNER')}>Rechazar</button>
                    <button className="btn secondary" disabled={busy} type="button" onClick={() => finderAction(item.claimId, 'BLOCK_OWNER')}>Bloquear</button>
                    <button className="btn danger" disabled={busy} type="button" onClick={() => finderAction(item.claimId, 'REPORT_ABUSE')}>Reportar abuso</button>
                  </div>
                  {contacts[item.claimId]?.status === 'CONTACT_AVAILABLE' && contacts[item.claimId]?.phone && (
                    <div className="alert">
                      <p><strong>Teléfono OTP-verificado autorizado:</strong> {contacts[item.claimId].phone}</p>
                      <p>{contacts[item.claimId].warning}</p>
                      <a className="btn primary" href={`tel:${contacts[item.claimId].phone}`}>Llamar si yo lo decido</a>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}

      {msg && <p className="alert" aria-live="polite">{msg}</p>}
    </main>
  );
}
