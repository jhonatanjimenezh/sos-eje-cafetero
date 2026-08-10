import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OfficialGuard } from '../auth/official.guard';
import { AffectedService } from './affected.service';
import { CompleteEvidenceDto, PresignEvidenceDto, UpsertAffectedProfileDto, VerifyAffectedDto } from './dto';

@Controller('affected')
export class AffectedController {
  constructor(private readonly service: AffectedService) {}

  @UseGuards(JwtAuthGuard) @Get('me')
  me(@Req() req: Request & { auth: any }) { return this.service.me(req.auth.sub); }

  @UseGuards(JwtAuthGuard) @Post('profile')
  upsert(@Req() req: Request & { auth: any }, @Body() dto: UpsertAffectedProfileDto) { return this.service.upsert(req.auth.sub, dto); }

  @UseGuards(JwtAuthGuard) @Post(':id/liveness/challenge')
  challenge(@Req() req: Request & { auth: any }, @Param('id') id: string) { return this.service.createLivenessChallenge(id, req.auth.sub); }

  @UseGuards(JwtAuthGuard) @Post(':id/evidence/presign')
  presign(@Req() req: Request & { auth: any }, @Param('id') id: string, @Body() dto: PresignEvidenceDto) { return this.service.presignEvidence(id, req.auth.sub, dto); }

  @UseGuards(JwtAuthGuard) @Post('evidence/:assetId/complete')
  complete(@Req() req: Request & { auth: any }, @Param('assetId') assetId: string, @Body() dto: CompleteEvidenceDto) { return this.service.completeEvidence(assetId, req.auth.sub, dto); }

  @UseGuards(JwtAuthGuard) @Post(':id/submit')
  submit(@Req() req: Request & { auth: any }, @Param('id') id: string) { return this.service.submit(id, req.auth.sub); }

  @UseGuards(OfficialGuard) @Post(':id/verify')
  verify(@Req() req: Request & { official: any }, @Param('id') id: string, @Body() dto: VerifyAffectedDto) { return this.service.verify(id, req.official, dto); }

  @UseGuards(OfficialGuard) @Get('command')
  command() { return this.service.commandList(); }
}
