import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

const CATEGORIES = ['WATER','FOOD','MEDICINE','SHELTER','TRANSPORT','CLOTHING','HYGIENE','PET_SUPPLIES','VOLUNTEER','OTHER'] as const;

export class CreateNeedDto {
  @IsIn(CATEGORIES) category!: string;
  @IsOptional() @IsString() description?: string;
  @IsNumber() @Min(0.1) @Max(100000) quantity!: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsIn(['CRITICAL','HIGH','MEDIUM','LOW']) priority?: string;
}

export class CreateOfferDto {
  @IsString() providerName!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsOptional() @IsString() description?: string;
  @IsNumber() @Min(0.1) @Max(100000) quantityAvailable!: number;
  @IsOptional() @IsString() unit?: string;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsInt() @Min(500) @Max(100000) radiusMeters!: number;
}
