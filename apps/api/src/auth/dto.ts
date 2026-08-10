import { IsEnum, IsString, IsUUID, Length } from 'class-validator';

export enum AuthAudience { CITIZEN='CITIZEN', OFFICIAL='OFFICIAL' }
export enum OtpFlow { SIGNUP_CONFIRM='SIGNUP_CONFIRM', AUTH_CHALLENGE='AUTH_CHALLENGE' }

export class RequestOtpDto {
  @IsString() phone!: string;
  @IsEnum(AuthAudience) audience!: AuthAudience;
}

export class VerifyOtpDto {
  @IsUUID() challengeId!: string;
  @IsString() @Length(4, 10) code!: string;
}
