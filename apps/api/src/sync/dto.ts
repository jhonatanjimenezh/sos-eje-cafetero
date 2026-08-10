import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class SecureEnvelopeDto {
  @IsInt() @Min(1) @Max(1) version!: 1;
  @IsUUID() messageId!: string;
  @IsString() @MaxLength(128) @Matches(BASE64URL) emitterKeyId!: string;
  @IsString() @MaxLength(1024) @Matches(BASE64URL) emitterPublicKeySpki!: string;
  @IsISO8601({ strict: true }) createdAt!: string;
  @IsISO8601({ strict: true }) expiresAt!: string;
  @IsIn(['INCIDENT', 'PERSON', 'ANIMAL', 'RESOURCE', 'AFFECTED_PROFILE']) kind!: string;
  @IsString() @MaxLength(128) cryptoSuite!: string;
  @IsString() @MaxLength(128) serverKeyId!: string;
  @IsString() @MaxLength(64) @Matches(BASE64URL) iv!: string;
  @IsString() @MaxLength(2048) @Matches(BASE64URL) wrappedKeyForServer!: string;
  @IsString() @MaxLength(32768) @Matches(BASE64URL) ciphertext!: string;
  @IsString() @MaxLength(128) @Matches(BASE64URL) ciphertextSha256!: string;
  @IsString() @MaxLength(512) @Matches(BASE64URL) signature!: string;
}

export class SecureEnvelopeBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => SecureEnvelopeDto)
  envelopes!: SecureEnvelopeDto[];
}
