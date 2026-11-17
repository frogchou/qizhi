import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_TOKEN_HASH = Symbol('ADMIN_TOKEN_HASH');

@Injectable()
export class AdminAuthGuard implements CanActivate {
  public constructor(@Inject(ADMIN_TOKEN_HASH) private readonly expectedHash: string) {}

  public canActivate(context: ExecutionContext): boolean {
    const authorization = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers.authorization;
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token || !matchesHash(token, this.expectedHash)) throw new UnauthorizedException('Administrator bearer token required.');
    return true;
  }
}

function matchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
