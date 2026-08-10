export const PET_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

export async function petJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${PET_API}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(data?.message)
      ? data.message.join(', ')
      : data?.message || `HTTP ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function sha256Hex(file: File) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function uploadSignedFile(file: File, signed: {
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
}) {
  const response = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: signed.uploadHeaders ?? { 'Content-Type': file.type },
    body: file,
  });
  if (!response.ok) throw new Error(`La carga privada falló (${response.status}).`);
}
