import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = String(request.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : request.cookies?.sos_access;
    if (!token) throw new UnauthorizedException('Sesión requerida');

    const region = process.env.AWS_REGION ?? 'us-east-1';
    const poolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!poolId || !clientId) throw new UnauthorizedException('Autenticación no configurada');
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
    this.jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    try {
      const verified = await jwtVerify(token, this.jwks, { issuer });
      const payload: any = verified.payload;
      if (payload.token_use !== 'access' || payload.client_id !== clientId) throw new Error('invalid token claims');
      request.auth = { sub: String(payload.sub), claims: payload };
      return true;
    } catch {
      throw new UnauthorizedException('Sesión inválida o vencida');
    }
  }
}
