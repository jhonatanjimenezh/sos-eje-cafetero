import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateReunificationRequestDto, ReunificationTargetActionDto } from './dto';
import { ReunificationOriginGuard } from './reunification-origin.guard';
import { ReunificationService } from './reunification.service';

@Controller('reunification')
@UseGuards(JwtAuthGuard, ReunificationOriginGuard)
export class ReunificationController {
  constructor(private readonly service: ReunificationService) {}

  @Post('requests')
  createRequest(@Req() req: any, @Body() dto: CreateReunificationRequestDto) {
    return this.service.createRequest(String(req.auth.sub), dto);
  }

  @Post('requests/:publicId/withdraw')
  withdraw(@Req() req: any, @Param('publicId') publicId: string) {
    return this.service.withdraw(String(req.auth.sub), publicId);
  }

  @Get('inbox')
  inbox(@Req() req: any) {
    return this.service.inbox(String(req.auth.sub));
  }

  @Get('inbox/summary')
  inboxSummary(@Req() req: any) {
    return this.service.inboxSummary(String(req.auth.sub));
  }

  @Post('inbox/:publicId/action')
  targetAction(
    @Req() req: any,
    @Param('publicId') publicId: string,
    @Body() dto: ReunificationTargetActionDto,
  ) {
    return this.service.targetAction(String(req.auth.sub), publicId, dto.action);
  }
}
