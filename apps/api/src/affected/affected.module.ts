import { Module } from '@nestjs/common';
import { AffectedController } from './affected.controller';
import { AffectedService } from './affected.service';
import { RekognitionLivenessProvider } from './rekognition-liveness.provider';

@Module({
  controllers: [AffectedController],
  providers: [AffectedService, RekognitionLivenessProvider],
  exports: [AffectedService],
})
export class AffectedModule {}
