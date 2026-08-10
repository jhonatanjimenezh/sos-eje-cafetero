import { Body, Controller, Get, Header, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SecureEnvelopeBatchDto } from './dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Get('crypto-config')
  @Header('Cache-Control', 'no-store, max-age=0')
  cryptoConfig() {
    return this.service.cryptoConfig();
  }

  @Post('envelopes/batch')
  @Header('Cache-Control', 'no-store, max-age=0')
  batch(@Req() req: Request, @Body() dto: SecureEnvelopeBatchDto) {
    this.service.enforceRateLimit(req.ip || req.socket.remoteAddress || 'unknown');
    return this.service.processBatch(dto);
  }
}
