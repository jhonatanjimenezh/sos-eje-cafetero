import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { OfficialGuard } from './official.guard';

@Injectable()
export class OperationalGuard implements CanActivate {
  constructor(private readonly official: OfficialGuard) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (process.env.ALLOW_LEGACY_COMMAND_TOKEN === 'true') {
      const expected = process.env.COMMAND_CENTER_TOKEN;
      if (expected && req.headers['x-command-token'] === expected) {
        req.authMode = 'legacy-bootstrap';
        return true;
      }
    }
    return this.official.canActivate(ctx);
  }
}
