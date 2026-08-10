import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module';
import { SyncController } from './sync.controller';
import { SyncCryptoService } from './sync.crypto';
import { SyncService } from './sync.service';

@Module({
  imports: [IncidentsModule],
  controllers: [SyncController],
  providers: [SyncCryptoService, SyncService],
})
export class SyncModule {}
