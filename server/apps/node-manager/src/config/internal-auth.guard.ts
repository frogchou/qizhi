import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export const NODE_INTERNAL_TOKEN_HASH = Symbol('NODE_INTERNAL_TOKEN_HASH');

@Injectable()
export class InternalAuthGuard implements CanActivate {
  public constructor(@Inject(NODE_INTERNAL_TOKEN_HASH) private readonly expectedHash: string) {}
  public canActivate(context: ExecutionContext): boolean {
    const token = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers['x-mg-internal-token'];
    const actual = token ? Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex') : Buffer.alloc(0);
    const expected = Buffer.from(this.expectedHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Internal node-manager token required.');
    return true;
  }
}
