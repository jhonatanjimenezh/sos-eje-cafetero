import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum PetPhotoModerationDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class PetPhotoModerationDto {
  @IsEnum(PetPhotoModerationDecision)
  decision!: PetPhotoModerationDecision;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
