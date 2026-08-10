import { IsEnum, IsString, Length } from 'class-validator';

export enum AuthAudience { CITIZEN='CITIZEN', OFFICIAL='OFFICIAL' }
export enum OtpFlow { SIGNUP_CONFIRM='SIGNUP_CONFIRM', AUTH_CHALLENGE='AUTH_CHALLENGE' }

export class RequestOtpDto {
  @IsString() phone!: string;
  @IsEnum(AuthAudience) audience!: AuthAudience;
}

export class VerifyOtpDto {
  @IsString() phone!: string;
  @IsEnum(AuthAudience) audience!: AuthAudience;
  @IsEnum(OtpFlow) flow!: OtpFlow;
  @IsString() @Length(4, 10) code!: string;
  @IsString() session?: string;
}
