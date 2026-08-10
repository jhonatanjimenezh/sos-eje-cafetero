import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { decodeJwt } from 'jose';
import Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { randomInt, randomUUID } from 'node:crypto';
import { PG_POOL } from '../database/database.module';
import { normalizePhone } from '../common/phone';
import { AuthAudience, OtpFlow, RequestOtpDto, VerifyOtpDto } from './dto';

type StoredOtpChallenge = {
  phone: string;
  audience: AuthAudience;
  flow: OtpFlow | 'DENY';
  session?: string;
};

@Injectable()
export class AuthService {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  private readonly cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private poolId() {
    const id = process.env.COGNITO_USER_POOL_ID;
    if (!id) throw new ServiceUnavailableException('COGNITO_USER_POOL_ID no está configurado');
    return id;
  }

  private clientId() {
    const id = process.env.COGNITO_CLIENT_ID;
    if (!id) throw new ServiceUnavailableException('COGNITO_CLIENT_ID no está configurado');
    return id;
  }

  private async rateLimit(key: string, max: number, ttlSeconds: number) {
    const value = await this.redis.incr(key);
    if (value === 1) await this.redis.expire(key, ttlSeconds);
    if (value > max) throw new HttpException('Demasiados intentos. Intenta nuevamente más tarde.', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async officialPreauthorized(phone: string) {
    const r = await this.db.query('SELECT id FROM official_profiles WHERE phone_e164=$1 AND status=\'ACTIVE\'', [phone]);
    return Boolean(r.rowCount);
  }

  private async ensureOfficialPreauthorized(phone: string) {
    if (!(await this.officialPreauthorized(phone))) throw new ForbiddenException('Acceso institucional no autorizado');
  }

  private async responseFloor(startedAt: number) {
    // Reduce discrepancias triviales de timing entre alta nueva y login existente.
    // No reemplaza la respuesta genérica; es defensa adicional contra enumeración.
    const floorMs = 700 + randomInt(0, 151);
    const remaining = floorMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  }

  private async saveChallenge(challenge: StoredOtpChallenge) {
    const challengeId = randomUUID();
    await this.redis.set(`otp:challenge:${challengeId}`, JSON.stringify(challenge), 'EX', 600);
    return challengeId;
  }

  async requestOtp(dto: RequestOtpDto, ip: string) {
    const startedAt = Date.now();
    const phone = normalizePhone(dto.phone);
    await this.rateLimit(`otp:phone:${phone}`, 5, 900);
    await this.rateLimit(`otp:ip:${ip || 'unknown'}`, 20, 900);

    // No revelar si un teléfono pertenece a un funcionario preautorizado.
    if (dto.audience === AuthAudience.OFFICIAL && !(await this.officialPreauthorized(phone))) {
      const challengeId = await this.saveChallenge({ phone, audience: dto.audience, flow: 'DENY' });
      await this.responseFloor(startedAt);
      return { status: 'OTP_SENT', challengeId, expiresIn: 600 };
    }

    let challenge: StoredOtpChallenge;
    try {
      let userStatus: string | undefined;
      try {
        const user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.poolId(), Username: phone }));
        userStatus = user.UserStatus;
      } catch (error: any) {
        if (error?.name !== 'UserNotFoundException') throw error;
      }

      if (!userStatus) {
        await this.cognito.send(new SignUpCommand({
          ClientId: this.clientId(),
          Username: phone,
          UserAttributes: [{ Name: 'phone_number', Value: phone }],
        }));
        challenge = { phone, audience: dto.audience, flow: OtpFlow.SIGNUP_CONFIRM };
      } else if (userStatus === 'UNCONFIRMED') {
        await this.cognito.send(new ResendConfirmationCodeCommand({ ClientId: this.clientId(), Username: phone }));
        challenge = { phone, audience: dto.audience, flow: OtpFlow.SIGNUP_CONFIRM };
      } else {
        const auth = await this.cognito.send(new InitiateAuthCommand({
          AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: phone, PREFERRED_CHALLENGE: 'SMS_OTP' },
          ClientId: this.clientId(),
        }));
        if (auth.ChallengeName !== 'SMS_OTP' || !auth.Session) throw new Error('OTP provider did not return challenge session');
        challenge = { phone, audience: dto.audience, flow: OtpFlow.AUTH_CHALLENGE, session: auth.Session };
      }

      const challengeId = await this.saveChallenge(challenge);
      await this.responseFloor(startedAt);
      // Forma deliberadamente idéntica para cuenta nueva, no confirmada o existente.
      return { status: 'OTP_SENT', challengeId, expiresIn: 600 };
    } catch (error) {
      await this.responseFloor(startedAt);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('No fue posible iniciar la verificación OTP en este momento');
    }
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const key = `otp:challenge:${dto.challengeId}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Código o desafío inválido o vencido');

    let challenge: StoredOtpChallenge;
    try {
      challenge = JSON.parse(raw) as StoredOtpChallenge;
    } catch {
      await this.redis.del(key);
      throw new BadRequestException('Código o desafío inválido o vencido');
    }

    await this.rateLimit(`otp:verify:${dto.challengeId}`, 5, 600);
    if (challenge.flow === 'DENY') {
      throw new BadRequestException('Código o desafío inválido o vencido');
    }

    try {
      if (challenge.audience === AuthAudience.OFFICIAL) await this.ensureOfficialPreauthorized(challenge.phone);
      let result: any;

      if (challenge.flow === OtpFlow.SIGNUP_CONFIRM) {
        const confirmed = await this.cognito.send(new ConfirmSignUpCommand({
          ClientId: this.clientId(), Username: challenge.phone, ConfirmationCode: dto.code,
        }));
        result = await this.cognito.send(new InitiateAuthCommand({
          AuthFlow: 'USER_AUTH', ClientId: this.clientId(), Session: confirmed.Session,
          AuthParameters: { USERNAME: challenge.phone, PREFERRED_CHALLENGE: 'SMS_OTP' },
        }));
      } else {
        if (!challenge.session) throw new BadRequestException('Código o desafío inválido o vencido');
        result = await this.cognito.send(new RespondToAuthChallengeCommand({
          ChallengeName: 'SMS_OTP',
          ChallengeResponses: { USERNAME: challenge.phone, SMS_OTP_CODE: dto.code },
          ClientId: this.clientId(), Session: challenge.session,
        }));
      }

      const auth = result.AuthenticationResult;
      if (!auth?.AccessToken || !auth?.IdToken) throw new BadRequestException('Código o desafío inválido o vencido');
      const claims: any = decodeJwt(auth.IdToken);
      const subject = String(claims.sub);
      const verifiedPhone = normalizePhone(String(claims.phone_number ?? challenge.phone));

      await this.db.query(`INSERT INTO auth_identities(subject,phone_e164,last_login_at)
        VALUES($1,$2,now()) ON CONFLICT(subject) DO UPDATE SET phone_e164=excluded.phone_e164,last_login_at=now()`, [subject, verifiedPhone]);

      if (challenge.audience === AuthAudience.OFFICIAL) {
        await this.db.query(`UPDATE official_profiles SET auth_subject=$2,updated_at=now()
          WHERE phone_e164=$1 AND status='ACTIVE' AND (auth_subject IS NULL OR auth_subject=$2)`, [verifiedPhone, subject]);
      }

      await this.redis.del(key, `otp:verify:${dto.challengeId}`);
      return {
        accessToken: auth.AccessToken,
        idToken: auth.IdToken,
        refreshToken: auth.RefreshToken,
        expiresIn: auth.ExpiresIn ?? 3600,
        subject,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      const name = String(error?.name ?? '');
      if (['CodeMismatchException', 'ExpiredCodeException', 'NotAuthorizedException', 'UserNotFoundException', 'InvalidParameterException'].includes(name)) {
        throw new BadRequestException('Código o desafío inválido o vencido');
      }
      if (['TooManyRequestsException', 'LimitExceededException'].includes(name)) {
        throw new HttpException('Demasiados intentos. Intenta nuevamente más tarde.', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new ServiceUnavailableException('No fue posible completar la verificación OTP en este momento');
    }
  }
}
