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
import { PG_POOL } from '../database/database.module';
import { normalizePhone } from '../common/phone';
import { AuthAudience, OtpFlow, RequestOtpDto, VerifyOtpDto } from './dto';

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

  private async ensureOfficialPreauthorized(phone: string) {
    const r = await this.db.query('SELECT id FROM official_profiles WHERE phone_e164=$1 AND status=\'ACTIVE\'', [phone]);
    if (!r.rowCount) throw new ForbiddenException('Este número no está habilitado como funcionario');
  }

  async requestOtp(dto: RequestOtpDto, ip: string) {
    const phone = normalizePhone(dto.phone);
    await this.rateLimit(`otp:phone:${phone}`, 5, 900);
    await this.rateLimit(`otp:ip:${ip || 'unknown'}`, 20, 900);
    if (dto.audience === AuthAudience.OFFICIAL) await this.ensureOfficialPreauthorized(phone);

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
      return { phone, flow: OtpFlow.SIGNUP_CONFIRM };
    }

    if (userStatus === 'UNCONFIRMED') {
      await this.cognito.send(new ResendConfirmationCodeCommand({ ClientId: this.clientId(), Username: phone }));
      return { phone, flow: OtpFlow.SIGNUP_CONFIRM };
    }

    const auth = await this.cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: phone, PREFERRED_CHALLENGE: 'SMS_OTP' },
      ClientId: this.clientId(),
    }));
    if (auth.ChallengeName !== 'SMS_OTP' || !auth.Session) throw new BadRequestException('No fue posible iniciar OTP por SMS');
    return { phone, flow: OtpFlow.AUTH_CHALLENGE, session: auth.Session, delivery: auth.ChallengeParameters };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const phone = normalizePhone(dto.phone);
    if (dto.audience === AuthAudience.OFFICIAL) await this.ensureOfficialPreauthorized(phone);
    let result: any;

    if (dto.flow === OtpFlow.SIGNUP_CONFIRM) {
      const confirmed = await this.cognito.send(new ConfirmSignUpCommand({
        ClientId: this.clientId(), Username: phone, ConfirmationCode: dto.code,
      }));
      result = await this.cognito.send(new InitiateAuthCommand({
        AuthFlow: 'USER_AUTH', ClientId: this.clientId(), Session: confirmed.Session,
        AuthParameters: { USERNAME: phone, PREFERRED_CHALLENGE: 'SMS_OTP' },
      }));
    } else {
      if (!dto.session) throw new BadRequestException('Sesión OTP requerida');
      result = await this.cognito.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'SMS_OTP',
        ChallengeResponses: { USERNAME: phone, SMS_OTP_CODE: dto.code },
        ClientId: this.clientId(), Session: dto.session,
      }));
    }

    const auth = result.AuthenticationResult;
    if (!auth?.AccessToken || !auth?.IdToken) throw new BadRequestException('OTP válido pero no se obtuvo una sesión');
    const claims: any = decodeJwt(auth.IdToken);
    const subject = String(claims.sub);
    const verifiedPhone = normalizePhone(String(claims.phone_number ?? phone));

    await this.db.query(`INSERT INTO auth_identities(subject,phone_e164,last_login_at)
      VALUES($1,$2,now()) ON CONFLICT(subject) DO UPDATE SET phone_e164=excluded.phone_e164,last_login_at=now()`, [subject, verifiedPhone]);

    if (dto.audience === AuthAudience.OFFICIAL) {
      await this.db.query(`UPDATE official_profiles SET auth_subject=$2,updated_at=now()
        WHERE phone_e164=$1 AND status='ACTIVE' AND (auth_subject IS NULL OR auth_subject=$2)`, [verifiedPhone, subject]);
    }

    return {
      accessToken: auth.AccessToken,
      idToken: auth.IdToken,
      refreshToken: auth.RefreshToken,
      expiresIn: auth.ExpiresIn ?? 3600,
      subject,
    };
  }
}
