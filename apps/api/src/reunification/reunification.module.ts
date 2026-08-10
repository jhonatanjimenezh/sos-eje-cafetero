import { Module } from '@nestjs/common';
import { ReunificationController } from './reunification.controller';
import { ReunificationOriginGuard } from './reunification-origin.guard';
import { ReunificationService } from './reunification.service';

@Module({
  controllers: [ReunificationController],
  providers: [ReunificationService, ReunificationOriginGuard],
})
export class ReunificationModule {}
