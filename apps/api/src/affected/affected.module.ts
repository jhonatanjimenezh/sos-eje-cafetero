import { Module } from '@nestjs/common';
import { AffectedController } from './affected.controller';
import { AffectedService } from './affected.service';
@Module({controllers:[AffectedController],providers:[AffectedService],exports:[AffectedService]})
export class AffectedModule {}
