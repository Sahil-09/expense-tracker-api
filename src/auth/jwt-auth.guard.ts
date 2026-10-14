import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { env } from '../config/env';
import { AccessPayload } from './auth.service';

/**
 * Verifies the bearer token and hangs the user id off the request.
 *
 * Hand-rolled rather than pulled from Passport: there is one scheme, one secret and no
 * need for the strategy/guard/decorator machinery, and the whole thing is this short.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessPayload }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer '))
      throw new UnauthorizedException('Missing bearer token');

    try {
      req.user = this.jwt.verify<AccessPayload>(header.slice(7), {
        secret: env.jwtSecret,
      });
      return true;
    } catch {
      throw new UnauthorizedException('Token is not valid');
    }
  }
}
