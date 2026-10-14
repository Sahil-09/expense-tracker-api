import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { AuthModule } from './auth.module';
import { Device } from '../devices/device.schema';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

const PASSWORD = 'a long enough passphrase';

describe('auth', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).send(body);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        UsersModule,
        // AuthModule brings its own controller and providers. Re-declaring the
        // controller here would build a second copy with nothing to inject.
        AuthModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('signs in and hands back a token', async () => {
    await app.get(UsersService).create('me@example.com', PASSWORD);
    const res = await post('/auth/login', {
      email: 'me@example.com',
      password: PASSWORD,
      deviceId: 'phone-a',
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.deviceId).toBe('phone-a');
  });

  it('gives a missing account and a wrong password the same answer', async () => {
    const wrongPassword = await post('/auth/login', {
      email: 'me@example.com',
      password: 'nope',
    });
    const noAccount = await post('/auth/login', {
      email: 'ghost@example.com',
      password: 'nope',
    });
    expect(wrongPassword.status).toBe(401);
    expect(noAccount.status).toBe(401);
    expect(wrongPassword.body.message).toBe(noAccount.body.message);
  });

  it('never stores the refresh token in the clear', async () => {
    const res = await post('/auth/login', {
      email: 'me@example.com',
      password: PASSWORD,
    });
    const devices = app.get<{ find(): { lean(): Promise<unknown[]> } }>(
      getModelToken(Device.name),
    );
    const rows = (await devices.find().lean()) as {
      refreshTokenHash?: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.refreshTokenHash).not.toBe(res.body.refreshToken);
    }
  });

  it('rotates the refresh token, so the old one stops working', async () => {
    const first = await post('/auth/login', {
      email: 'me@example.com',
      password: PASSWORD,
    });
    const second = await post('/auth/refresh', {
      refreshToken: first.body.refreshToken,
    });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);

    const reused = await post('/auth/refresh', {
      refreshToken: first.body.refreshToken,
    });
    expect(reused.status).toBe(401);
  });

  it('logs out idempotently', async () => {
    const res = await post('/auth/login', {
      email: 'me@example.com',
      password: PASSWORD,
    });
    expect(
      (await post('/auth/logout', { refreshToken: res.body.refreshToken }))
        .status,
    ).toBe(204);
    expect(
      (await post('/auth/logout', { refreshToken: res.body.refreshToken }))
        .status,
    ).toBe(204);
    expect(
      (await post('/auth/refresh', { refreshToken: res.body.refreshToken }))
        .status,
    ).toBe(401);
  });
});
