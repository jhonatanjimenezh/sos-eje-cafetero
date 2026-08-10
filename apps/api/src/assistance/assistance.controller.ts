import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OfficialGuard } from '../auth/official.guard';
import { AssistanceService } from './assistance.service';
import { CreateNeedDto, CreateOfferDto } from './dto';

@Controller('assistance')
export class AssistanceController {
  constructor(private readonly service: AssistanceService) {}
  @UseGuards(JwtAuthGuard) @Post('needs')
  need(@Req() req: Request & { auth: any }, @Body() dto: CreateNeedDto) { return this.service.createNeed(req.auth.sub,dto); }
  @UseGuards(JwtAuthGuard) @Post('offers')
  offer(@Req() req: Request & { auth: any }, @Body() dto: CreateOfferDto) { return this.service.createOffer(req.auth.sub,dto); }
  @UseGuards(OfficialGuard) @Post('matches/propose')
  propose(@Req() req:Request & {official:any},@Query('needId') needId?: string) { return this.service.proposeMatches(needId,req.official); }
  @UseGuards(OfficialGuard) @Get('matches/command')
  matches() { return this.service.commandMatches(); }
  @UseGuards(OfficialGuard) @Post('matches/:id/approve')
  approve(@Param('id') id:string,@Req() req:Request & {official:any}) { return this.service.approveMatch(id,req.official); }
}
