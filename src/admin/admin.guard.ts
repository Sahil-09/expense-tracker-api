import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { env } from '../config/env';
import { UsersService } from '../users/users.service';
import { AccessPayload } from '../auth/auth.service';

/**
 * Guard that allows access only to users whose email is in the ADMIN_EMAILS allowlist.
 *
 * - Verifies JWT directly (same logic as JwtAuthGuard).
 * - If ADMIN_EMAILS is empty, all requests are forbidden (admin endpoints are closed).
 * - The requesting user's email is resolved via UsersService.findById from the JWT sub.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessPayload }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer '))
      throw new ForbiddenException('Missing bearer token');

    try {
      req.user = this.jwt.verify<AccessPayload>(header.slice(7), {
        secret: env.jwtSecret,
      });
    } catch {
      throw new ForbiddenException('Token is not valid');
    }

    const userId = req.user?.sub as string | undefined;
    if (!userId) {
      throw new ForbiddenException('Missing user identity');
    }

    const allowlist = env.adminEmails;
    if (allowlist.length === 0) {
      throw new ForbiddenException('Admin access is disabled');
    }

    const user = await this.users.findById(userId);
    if (!user) {
      throw new ForbiddenException('User not found');
    }

    const email = user.email.toLowerCase();
    if (!allowlist.includes(email)) {
      throw new ForbiddenException('Not an admin');
    }

    return true;
  }
}
