import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

import { AccessPayload } from '../auth/auth.service';
import { env } from '../config/env';
import { UsersService } from '../users/users.service';

const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * `/sms` takes either the ordinary access token or `SMS_INGEST_TOKEN`.
 *
 * The Shortcut path needs the second one: an iOS automation has no way to run the
 * refresh-token dance every 15 minutes, so a normal access token would make the
 * automation silently stop working a few minutes after it was set up.
 */
@Injectable()
export class SmsAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessPayload }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer '))
      throw new UnauthorizedException('Missing bearer token');

    const token = header.slice(7);
    if (env.smsIngestToken && sameToken(token, env.smsIngestToken)) {
      const user = await this.users.findByEmail(env.smsUserEmail as string);
      if (!user) throw new UnauthorizedException('SMS account is missing');
      req.user = { sub: user._id.toString() };
      return true;
    }

    try {
      req.user = this.jwt.verify<AccessPayload>(token, {
        secret: env.jwtSecret,
      });
      return true;
    } catch {
      throw new UnauthorizedException('Token is not valid');
    }
  }
}
