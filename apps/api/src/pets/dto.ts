import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export enum PetAnimalType {
  DOG = 'DOG',
  CAT = 'CAT',
  BIRD = 'BIRD',
  OTHER = 'OTHER',
}

export enum PetSex {
  FEMALE = 'FEMALE',
  MALE = 'MALE',
  UNKNOWN = 'UNKNOWN',
}

export enum PetCaseKind {
  LOST = 'LOST',
  FOUND = 'FOUND',
}

export enum PetClaimRole {
  FINDER = 'FINDER',
  OWNER_CLAIMANT = 'OWNER_CLAIMANT',
}

export enum PetClaimEvidenceKind {
  PROOF_OF_LIFE = 'PROOF_OF_LIFE',
  OWNERSHIP_HISTORY = 'OWNERSHIP_HISTORY',
}

export enum PetOwnerAction {
  AUTHORIZE_CONTACT = 'AUTHORIZE_CONTACT',
  REJECT = 'REJECT',
  BLOCK = 'BLOCK',
  REPORT_ABUSE = 'REPORT_ABUSE',
}

export enum PetFinderAction {
  ACCEPT_OWNER = 'ACCEPT_OWNER',
  REJECT_OWNER = 'REJECT_OWNER',
  BLOCK_OWNER = 'BLOCK_OWNER',
  REPORT_ABUSE = 'REPORT_ABUSE',
}

export class CreatePetProfileDto {
  @IsString()
  @Length(1, 80)
  petName!: string;

  @IsEnum(PetAnimalType)
  animalType!: PetAnimalType;

  @IsOptional()
  @IsEnum(PetSex)
  sex?: PetSex;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  approximateAgeMonths?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  breed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  color?: string;

  @IsOptional()
  @IsBoolean()
  sterilized?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  microchip?: string;

  @IsString()
  @Length(2, 120)
  ownerFullName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,24}$/i)
  ownerDocumentType?: string;

  @ValidateIf((value) => Boolean(value.ownerDocumentType))
  @IsString()
  @Length(4, 40)
  ownerDocumentNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(800)
  privateDistinguishingMarks?: string;

  @IsString()
  @Length(1, 40)
  consentVersion!: string;
}

export class CreatePetCaseDto {
  @IsEnum(PetCaseKind)
  kind!: PetCaseKind;

  @IsOptional()
  @IsString()
  @Matches(/^PET-[A-Z0-9]{6,20}$/)
  petProfilePublicId?: string;

  @IsEnum(PetAnimalType)
  animalType!: PetAnimalType;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  publicName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  publicDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  breed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  areaHint?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsString()
  occurredAt?: string;

  @IsOptional()
  @IsBoolean()
  shareCreatorPhone?: boolean;
}

export class CreatePetClaimDto {
  @IsEnum(PetClaimRole)
  role!: PetClaimRole;

  @IsOptional()
  @IsString()
  @Matches(/^PET-[A-Z0-9]{6,20}$/)
  petProfilePublicId?: string;

  @IsOptional()
  @IsBoolean()
  shareClaimantPhone?: boolean;
}

export class PresignPetCasePhotoDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;

  @IsInt()
  @Min(1)
  @Max(15_000_000)
  sizeBytes!: number;

  @IsString()
  @Matches(/^image\/(jpeg|png|webp)$/)
  contentType!: string;
}

export class PresignPetClaimEvidenceDto {
  @IsEnum(PetClaimEvidenceKind)
  kind!: PetClaimEvidenceKind;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;

  @IsInt()
  @Min(1)
  @Max(50_000_000)
  sizeBytes!: number;

  @IsString()
  @Matches(/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp))$/)
  contentType!: string;

  @IsOptional()
  @IsString()
  challengeId?: string;
}

export class CompletePetMediaDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;

  @IsInt()
  @Min(1)
  @Max(50_000_000)
  sizeBytes!: number;
}

export class PetOwnerActionDto {
  @IsEnum(PetOwnerAction)
  action!: PetOwnerAction;
}

export class PetFinderActionDto {
  @IsEnum(PetFinderAction)
  action!: PetFinderAction;
}
