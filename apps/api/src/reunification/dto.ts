import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// El seeker no puede saltarse REVEAL_CONTACT insertando otro teléfono/email/handle
// dentro de nombre, relación o mensaje. El único contacto revelable debe provenir
// del phone_e164 OTP-verificado del seeker.
const NO_DIRECT_CONTACT = /^(?![\s\S]*(?:https?:\/\/|www\.|wa\.me|t\.me))(?![\s\S]*[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})(?![\s\S]*(?:^|\s)@[A-Za-z0-9_]{3,})(?![\s\S]*\+?\d[\d\s().-]{6,}\d)[\s\S]*$/i;
const NO_DIRECT_CONTACT_MESSAGE = 'Por seguridad no incluyas teléfonos, emails, enlaces ni usuarios externos; el contacto verificado se revela solo si la persona buscada lo decide.';

export class CreateReunificationRequestDto {
  @IsString()
  @MinLength(8)
  @MaxLength(24)
  targetPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(NO_DIRECT_CONTACT, { message: NO_DIRECT_CONTACT_MESSAGE })
  seekerDisplayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(NO_DIRECT_CONTACT, { message: NO_DIRECT_CONTACT_MESSAGE })
  declaredRelationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Matches(NO_DIRECT_CONTACT, { message: NO_DIRECT_CONTACT_MESSAGE })
  message?: string;

  @IsBoolean()
  shareSeekerPhone!: boolean;
}

export enum ReunificationTargetAction {
  REVEAL_CONTACT = 'REVEAL_CONTACT',
  IGNORE = 'IGNORE',
  BLOCK = 'BLOCK',
  REPORT_ABUSE = 'REPORT_ABUSE',
}

export class ReunificationTargetActionDto {
  @IsEnum(ReunificationTargetAction)
  action!: ReunificationTargetAction;
}
