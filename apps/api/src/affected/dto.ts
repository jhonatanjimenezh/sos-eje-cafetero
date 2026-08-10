import { Equals, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpsertAffectedProfileDto {
  @IsString() fullName!: string;
  @IsIn(['CC','CE','TI','PP','OTRO']) documentType!: string;
  @IsString() documentNumber!: string;
  @IsString() address!: string;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsInt() @Min(1) @Max(50) householdSize!: number;
  @IsOptional() @IsString() notes?: string;
  @IsBoolean() @Equals(true) consentSensitiveData!: boolean;
  @IsString() consentVersion!: string;
}

export class PresignEvidenceDto {
  @IsIn(['ID_FRONT','ID_BACK','LIVENESS_VIDEO','DAMAGE_PHOTO']) kind!: string;
  @IsString() contentType!: string;
}

export class CompleteEvidenceDto {
  @IsString() sha256!: string;
  @IsInt() @Min(1) @Max(100_000_000) sizeBytes!: number;
}

export class VerifyAffectedDto {
  @IsIn(['APPROVED','REJECTED','NEEDS_INFO']) decision!: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() method?: string;
}
