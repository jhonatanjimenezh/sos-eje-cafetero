import { Body, Controller, Get, Header, HttpException, HttpStatus, Post } from '@nestjs/common';
import { SecureEnvelopeBatchDto } from './dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  private readonly emitterRate = new Map<string, { minute: number; count: number }>();
  private globalRate = { minute: -1, count: 0 };

  constructor(private readonly service: SyncService) {}

  private enforceRateLimit(dto: SecureEnvelopeBatchDto) {
    const minute = Math.floor(Date.now() / 60000);
    const globalMax = Number(process.env.SYNC_GLOBAL_BATCHES_PER_MINUTE ?? 1200);
    const emitterMax = Number(
      process.env.SYNC_EMITTER_BATCHES_PER_MINUTE ?? process.env.SYNC_BATCH_REQUESTS_PER_MINUTE ?? 60,
    );

    if (this.globalRate.minute !== minute) this.globalRate = { minute, count: 0 };
    this.globalRate.count += 1;
    if (this.globalRate.count > globalMax) {
      throw new HttpException('Capacidad temporal de sincronización excedida; el ciphertext permanece reintentable.', HttpStatus.TOO_MANY_REQUESTS);
    }

    // No usamos req.ip: detrás de CloudFront/ALB y carrier NAT una IP puede representar
    // a muchos ciudadanos. Limitamos por procedencia criptográfica de dispositivo y
    // mantenemos WAF/global limit como capas anti-DoS adicionales.
    for (const emitterKeyId of new Set(dto.envelopes.map((envelope) => envelope.emitterKeyId))) {
      const current = this.emitterRate.get(emitterKeyId);
      if (!current || current.minute !== minute) {
        this.emitterRate.set(emitterKeyId, { minute, count: 1 });
        continue;
      }
      current.count += 1;
      if (current.count > emitterMax) {
        throw new HttpException('Demasiados lotes desde este dispositivo; conserva el ciphertext e intenta nuevamente.', HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    // Evita crecimiento indefinido del mapa si un atacante rota emitter keys.
    if (this.emitterRate.size > 10000) {
      for (const [key, value] of this.emitterRate) if (value.minute !== minute) this.emitterRate.delete(key);
      if (this.emitterRate.size > 10000) this.emitterRate.clear();
    }
  }

  @Get('crypto-config')
  @Header('Cache-Control', 'no-store, max-age=0')
  cryptoConfig() {
    return this.service.cryptoConfig();
  }

  @Post('envelopes/batch')
  @Header('Cache-Control', 'no-store, max-age=0')
  batch(@Body() dto: SecureEnvelopeBatchDto) {
    this.enforceRateLimit(dto);
    return this.service.processBatch(dto);
  }
}
