import { Module } from '@nestjs/common';
import { OfficialsController } from './officials.controller';
import { OfficialsService } from './officials.service';
@Module({ controllers:[OfficialsController], providers:[OfficialsService], exports:[OfficialsService] })
export class OfficialsModule {}
