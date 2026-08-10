import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
export enum IncidentType { PEOPLE_TRAPPED='PEOPLE_TRAPPED', INJURED_PERSON='INJURED_PERSON', BUILDING_DAMAGE='BUILDING_DAMAGE', BUILDING_COLLAPSE='BUILDING_COLLAPSE', FIRE='FIRE', GAS_LEAK='GAS_LEAK', MEDICAL_NEED='MEDICAL_NEED', WATER_NEED='WATER_NEED', FOOD_NEED='FOOD_NEED', ROAD_BLOCKED='ROAD_BLOCKED', LANDSLIDE='LANDSLIDE', OTHER='OTHER' }
export enum IncidentPriority { CRITICAL='CRITICAL', HIGH='HIGH', MEDIUM='MEDIUM', LOW='LOW' }
export class CreateIncidentDto {
  @IsEnum(IncidentType) type!: IncidentType;
  @IsOptional() @IsEnum(IncidentPriority) priority?: IncidentPriority;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) peopleAffected?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) peopleTrapped?: number;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() buildingDamageLevel?: string;
}
