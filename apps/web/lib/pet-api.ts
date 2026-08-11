export const PET_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

export async function petJson(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${PET_API}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers,
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

export async function sanitizePublicPetImage(file: File) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('La fotografía debe ser JPEG, PNG o WebP.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const maxSide = 2000;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('No fue posible preparar la fotografía de forma segura.');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('No fue posible sanitizar la fotografía.')), 'image/jpeg', 0.9);
    });
    return new File([blob], `pet-catalog-${Date.now()}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
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
