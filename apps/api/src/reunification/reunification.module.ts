import { Module } from '@nestjs/common';
import { ReunificationController } from './reunification.controller';
import { ReunificationService } from './reunification.service';

@Module({
  controllers: [ReunificationController],
  providers: [ReunificationService],
})
export class ReunificationModule {}
