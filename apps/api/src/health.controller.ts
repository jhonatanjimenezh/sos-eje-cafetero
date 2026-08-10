import { Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController {
  @Get() health() { return { status: 'ok', service: 'sos-eje-cafetero-api', time: new Date().toISOString() }; }
}
