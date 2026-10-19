import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { env } from '../config/env';
import { SmsAuthGuard } from './sms-auth.guard';

function contextWith(token: string) {
  const req: { headers: Record<string, string>; user?: unknown } = {
    headers: { authorization: `Bearer ${token}` },
  };
  return {
    req,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
}

describe('SmsAuthGuard', () => {
  const original = {
    token: env.smsIngestToken,
    email: env.smsUserEmail,
  };

  afterEach(() => {
    env.smsIngestToken = original.token;
    env.smsUserEmail = original.email;
  });

  it('maps the ingest token to the configured account', async () => {
    env.smsIngestToken = 'shortcut-token-123';
    env.smsUserEmail = 'me@example.com';

    const { req, ctx } = contextWith('shortcut-token-123');
    const guard = new SmsAuthGuard(
      { verify: jest.fn() } as never,
      {
        findByEmail: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      } as never,
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'user-1' });
  });

  it('still accepts a normal access token', async () => {
    env.smsIngestToken = null;
    const { req, ctx } = contextWith('jwt');
    const guard = new SmsAuthGuard(
      { verify: jest.fn().mockReturnValue({ sub: 'user-2' }) } as never,
      {} as never,
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'user-2' });
  });

  it('rejects a token that is neither', async () => {
    env.smsIngestToken = 'shortcut-token-123';
    const { ctx } = contextWith('wrong');
    const guard = new SmsAuthGuard(
      {
        verify: jest.fn(() => {
          throw new Error('bad');
        }),
      } as never,
      {} as never,
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
