import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OfficialGuard } from './official.guard';
import { OperationalGuard } from './operational.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, OfficialGuard, OperationalGuard],
  exports: [AuthService, JwtAuthGuard, OfficialGuard, OperationalGuard],
})
export class AuthModule {}
