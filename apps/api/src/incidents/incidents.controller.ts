import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OfficialGuard } from '../auth/official.guard';
import { CreateIncidentDto } from './dto';
import { IncidentsService } from './incidents.service';
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}
  @Post() create(@Body() dto: CreateIncidentDto,@Headers('idempotency-key') key?:string) { return this.service.create(dto,'WEB',key); }
  @UseGuards(OfficialGuard) @Post('official') official(@Body() dto:CreateIncidentDto,@Req() req:Request & {official:any},@Headers('idempotency-key') key?:string){ return this.service.create(dto,'OFFICIAL',key,req.official.id); }
  @Get('map/public') publicMap() { return this.service.publicMap(); }
  @UseGuards(OfficialGuard) @Get('command') command() { return this.service.operational(); }
  @UseGuards(OfficialGuard) @Patch(':id/status') update(@Param('id') id:string,@Body('status') status:string) { return this.service.updateStatus(id,status); }
}
