import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class ReunificationOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const method = String(req.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;

    // Bearer clients are not vulnerable to ambient-cookie CSRF because the token must
    // be supplied explicitly by the caller. Browser PWA uses HttpOnly cookies.
    const authorization = String(req.headers.authorization ?? '');
    if (/^Bearer\s+\S+$/i.test(authorization)) return true;

    const allowed = String(process.env.WEB_ORIGIN ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (!allowed.length) {
      // A sensitive feature must not silently accept every origin in production.
      if (process.env.NODE_ENV === 'production') {
        throw new ForbiddenException('Origen de seguridad no configurado');
      }
      return true;
    }

    const origin = String(req.headers.origin ?? '');
    if (!origin || !allowed.includes(origin)) {
      throw new ForbiddenException('Origen no autorizado');
    }
    return true;
  }
}
