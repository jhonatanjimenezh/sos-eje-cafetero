import { Equals, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

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
  @IsString() @Length(3, 100) consentVersion!: string;
}

export class PresignEvidenceDto {
  @IsIn(['ID_FRONT','ID_BACK','LIVENESS_VIDEO','DAMAGE_PHOTO']) kind!: string;
  @IsString() contentType!: string;
  @IsInt() @Min(1) @Max(100_000_000) sizeBytes!: number;
  @IsString() @Matches(/^[a-fA-F0-9]{64}$/) sha256!: string;
}

export class CompleteEvidenceDto {
  @IsString() @Matches(/^[a-fA-F0-9]{64}$/) sha256!: string;
  @IsInt() @Min(1) @Max(100_000_000) sizeBytes!: number;
}

export class LivenessConsentDto {
  @IsBoolean() @Equals(true) consentLiveness!: boolean;
  @IsString() @Length(3, 100) consentVersion!: string;
}

export class VerifyAffectedDto {
  @IsIn(['APPROVED','REJECTED','NEEDS_INFO']) decision!: string;
  @IsOptional() @IsString() @Length(5, 2000) notes?: string;
  @IsOptional() @IsString() @Length(3, 100) method?: string;
}

export class EvidenceAccessDto {
  @IsString() @Length(10, 500) reason!: string;
}

export class IdentityReviewRequestDto {
  @IsIn(['NEEDS_INFO_RESPONSE','APPEAL']) kind!: string;
  @IsString() @Length(10, 2000) message!: string;
}

export class ResolveIdentityReviewDto {
  @IsIn(['RESOLVED','DENIED']) decision!: string;
  @IsString() @Length(5, 2000) notes!: string;
}
