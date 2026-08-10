import { Body, Controller, Get, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { WhatsAppService } from './whatsapp.service';
@Controller('whatsapp/webhook')
export class WhatsAppController {
  constructor(private readonly service:WhatsAppService) {}
  @Get() verify(@Query('hub.mode') mode:string,@Query('hub.verify_token') token:string,@Query('hub.challenge') challenge:string,@Res() res:Response){ if(mode==='subscribe' && token===process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge); return res.sendStatus(403); }
  @Post() async receive(@Req() req:Request & {rawBody?:Buffer},@Body() body:any){ const secret=process.env.WHATSAPP_APP_SECRET; if(secret && req.rawBody){ const supplied=String(req.headers['x-hub-signature-256'] ?? ''); const expected='sha256='+createHmac('sha256',secret).update(req.rawBody).digest('hex'); const a=Buffer.from(supplied), b=Buffer.from(expected); if(a.length!==b.length || !timingSafeEqual(a,b)) throw new UnauthorizedException('Invalid Meta signature'); }
    for(const entry of body?.entry ?? []) for(const change of entry?.changes ?? []) if(change.field==='messages') await this.service.handle(change.value); return {ok:true}; }
}
