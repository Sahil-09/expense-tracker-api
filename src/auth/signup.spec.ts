import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import request from 'supertest';

import { AuthService } from './auth.service';
import { AuthModule } from './auth.module';
import { env } from '../config/env';
import { User } from '../users/user.schema';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

const PASSWORD = 'a long enough passphrase';
const SIGNUP = 'signup-code-abcdefghij';
const RESET = 'reset-code-abcdefghijkl';

describe('signup and reset', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  const users = () => app.get(UsersService);
  const model = () =>
    app.get<Model<{ deleteMany(q: unknown): Promise<unknown> }>>(
      getModelToken(User.name),
    );

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).send(body);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        UsersModule,
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

  beforeEach(async () => {
    await model().deleteMany({});
    // env is read once at import, so this is the only way to exercise both states in one
    // process. Nothing else reads process.env for these.
    env.signupCode = null;
    env.resetCode = null;
  });

  describe('closed: neither code is configured', () => {
    it('refuses signup the same way it refuses a wrong code', async () => {
      const res = await post('/auth/register', {
        email: 'closed@example.com',
        password: PASSWORD,
        code: 'anything at all',
      });
      expect(res.status).toBe(401);
      expect(await users().findByEmail('closed@example.com')).toBeNull();
    });

    it('refuses a reset without revealing anything', async () => {
      await users().create('someone@example.com', PASSWORD);
      const res = await post('/auth/reset-password', {
        email: 'someone@example.com',
        newPassword: 'irrelevant when closed',
        code: 'anything at all',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('open: both codes are configured', () => {
    beforeEach(() => {
      env.signupCode = SIGNUP;
      env.resetCode = RESET;
    });

    it('creates an account and hands back a usable session', async () => {
      const res = await post('/auth/register', {
        email: 'new@example.com',
        password: PASSWORD,
        code: SIGNUP,
      });
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();

      const user = await users().findByEmail('new@example.com');
      expect(user).not.toBeNull();
      // Argon2, never the plaintext.
      expect(user?.passwordHash).toContain('$argon2id$');
    });

    it('rejects a wrong code without creating anything', async () => {
      const res = await post('/auth/register', {
        email: 'new@example.com',
        password: PASSWORD,
        code: `${SIGNUP}x`,
      });
      expect(res.status).toBe(401);
      expect(await users().findByEmail('new@example.com')).toBeNull();
    });

    it('answers 409, not 500, for an email already registered', async () => {
      await users().create('taken@example.com', PASSWORD);
      const res = await post('/auth/register', {
        email: 'taken@example.com',
        password: PASSWORD,
        code: SIGNUP,
      });
      expect(res.status).toBe(409);
    });

    it('rejects a short password before doing any work', async () => {
      const res = await post('/auth/register', {
        email: 'new@example.com',
        password: 'short',
        code: SIGNUP,
      });
      expect(res.status).toBe(400);
      expect(await users().findByEmail('new@example.com')).toBeNull();
    });

    it('resets a password so the new one works and the old one does not', async () => {
      await users().create('taken@example.com', PASSWORD);

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: 'a brand new passphrase',
        code: RESET,
      }).expect(204);

      await post('/auth/login', {
        email: 'taken@example.com',
        password: 'a brand new passphrase',
      }).expect(200);
      await post('/auth/login', {
        email: 'taken@example.com',
        password: PASSWORD,
      }).expect(401);
    });

    it('kills every existing session when a password is reset', async () => {
      await users().create('taken@example.com', PASSWORD);
      const auth = app.get(AuthService);
      const { user } = await auth.login({
        email: 'taken@example.com',
        password: PASSWORD,
        deviceId: 'phone-a',
      });
      const issued = await auth.tokens(user._id, {
        email: 'taken@example.com',
        password: PASSWORD,
        deviceId: 'phone-a',
      });

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: 'a brand new passphrase',
        code: RESET,
      }).expect(204);

      // A token stolen before the reset must not survive it, or the reset bought nothing.
      await post('/auth/refresh', { refreshToken: issued.refreshToken }).expect(
        401,
      );
    });

    it('never says whether an account exists on reset', async () => {
      await users().create('taken@example.com', PASSWORD);
      const known = await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: 'a brand new passphrase',
        code: RESET,
      });
      const unknown = await post('/auth/reset-password', {
        email: 'ghost@example.com',
        newPassword: 'a brand new passphrase',
        code: RESET,
      });
      expect(known.status).toBe(204);
      expect(unknown.status).toBe(204);
      expect(known.body).toEqual(unknown.body);
    });

    it('will not reset with the signup code', async () => {
      await users().create('taken@example.com', PASSWORD);
      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: 'a brand new passphrase',
        code: SIGNUP,
      }).expect(401);
      // The original password still works, so the attempt really did nothing.
      await post('/auth/login', {
        email: 'taken@example.com',
        password: PASSWORD,
      }).expect(200);
    });
  });
});
