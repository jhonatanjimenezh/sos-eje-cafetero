import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
@Injectable()
export class CommandTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.COMMAND_CENTER_TOKEN;
    if (!expected) throw new UnauthorizedException('Command center is not configured');
    const token = ctx.switchToHttp().getRequest().headers['x-command-token'];
    if (token !== expected) throw new UnauthorizedException('Invalid command token');
    return true;
  }
}
