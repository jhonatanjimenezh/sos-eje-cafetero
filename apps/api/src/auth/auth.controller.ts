import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RequestOtpDto, VerifyOtpDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('otp/request')
  request(@Body() dto: RequestOtpDto, @Req() req: Request) {
    return this.service.requestOtp(dto, req.ip ?? req.socket.remoteAddress ?? 'unknown');
  }

  @Post('otp/verify')
  async verify(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.service.verifyOtp(dto);
    const secure = process.env.NODE_ENV === 'production';
    const base = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
    res.cookie('sos_access', session.accessToken, { ...base, maxAge: session.expiresIn * 1000 });
    res.cookie('sos_id', session.idToken, { ...base, maxAge: session.expiresIn * 1000 });
    if (session.refreshToken) res.cookie('sos_refresh', session.refreshToken, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
    return { authenticated: true, subject: session.subject, expiresIn: session.expiresIn };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('sos_access', { path: '/' });
    res.clearCookie('sos_id', { path: '/' });
    res.clearCookie('sos_refresh', { path: '/' });
    return { ok: true };
  }
}
