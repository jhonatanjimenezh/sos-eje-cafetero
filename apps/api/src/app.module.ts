import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';
import { IncidentsModule } from './incidents/incidents.module';
import { ReportsModule } from './reports/reports.module';
import { UnitsModule } from './units/units.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { OfficialsModule } from './officials/officials.module';
import { AffectedModule } from './affected/affected.module';
import { AssistanceModule } from './assistance/assistance.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    IncidentsModule,
    ReportsModule,
    UnitsModule,
    WhatsAppModule,
    OfficialsModule,
    AffectedModule,
    AssistanceModule,
    AnalyticsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
