import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateReunificationRequestDto {
  @IsString()
  @MinLength(8)
  @MaxLength(24)
  targetPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  seekerDisplayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  declaredRelationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
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
