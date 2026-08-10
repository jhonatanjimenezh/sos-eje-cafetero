import { Controller, ForbiddenException, Get, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { OperationalGuard } from '../auth/operational.guard';
import { OfficialsService } from './officials.service';

@Controller('officials')
@UseGuards(OperationalGuard)
export class OfficialsController {
  constructor(private readonly service: OfficialsService) {}

  private assertAdmin(req: Request & { official?: any; authMode?: string }) {
    if (req.authMode === 'legacy-bootstrap') return;
    if (!req.official || !['ADMIN','COORDINATOR'].includes(req.official.role)) throw new ForbiddenException('Rol insuficiente para administrar funcionarios');
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2_000_000 } }))
  import(@UploadedFile() file: any, @Req() req: Request & { official?: any; authMode?: string }) {
    this.assertAdmin(req);
    if (!file?.buffer) throw new ForbiddenException('Archivo CSV requerido');
    const actor = req.official?.id ?? req.authMode ?? 'bootstrap';
    return this.service.importCsv(file.buffer, String(actor));
  }

  @Get()
  list(@Req() req: Request & { official?: any; authMode?: string }) { this.assertAdmin(req); return this.service.list(); }
}
