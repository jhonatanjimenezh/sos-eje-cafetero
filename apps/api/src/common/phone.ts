import { BadRequestException } from '@nestjs/common';

export function normalizePhone(raw: string): string {
  const value = String(raw ?? '').replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (/^57\d{10}$/.test(digits)) return `+${digits}`;
  if (/^3\d{9}$/.test(digits)) return `+57${digits}`;
  throw new BadRequestException('Número celular inválido. Use formato colombiano 3XXXXXXXXX o E.164 +57...');
}
