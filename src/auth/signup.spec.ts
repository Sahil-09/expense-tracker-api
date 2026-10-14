import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import request from 'supertest';

import { AuthService } from './auth.service';
import { AuthModule } from './auth.module';
import { env } from '../config/env';
import { sendPasswordResetEmail } from '../mail/resend';
import {
  PasswordReset,
  PasswordResetDocument,
} from '../password-resets/password-reset.schema';
import { User } from '../users/user.schema';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

jest.mock('../mail/resend', () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

const PASSWORD = 'a long enough passphrase';
const NEW_PASSWORD = 'a brand new passphrase';
const SIGNUP = 'signup-code-abcdefghij';

const mailer = sendPasswordResetEmail as jest.MockedFunction<
  typeof sendPasswordResetEmail
>;

describe('signup and password reset', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  const users = () => app.get(UsersService);
  const userRows = () =>
    app.get<Model<{ deleteMany(q: unknown): Promise<unknown> }>>(
      getModelToken(User.name),
    );
  const resets = () =>
    app.get<Model<PasswordResetDocument>>(getModelToken(PasswordReset.name));

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).send(body);

  /** The last code handed to the mailer. The only way to read it: nothing else ever has it. */
  const mailedCode = () => mailer.mock.calls.at(-1)?.[1] as string;

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
    await userRows().deleteMany({});
    await resets().deleteMany({});
    mailer.mockClear();
    mailer.mockResolvedValue(undefined);
    // env is read once at import, so this is the only way to exercise both states in one
    // process. Nothing else reads process.env for these.
    env.signupCode = null;
    env.resendApiKey = 'resend-key-abcdefghij';
    env.mailFrom = 'Expense Tracker <no-reply@example.com>';
  });

  describe('closed: signup code is not configured', () => {
    it('refuses signup the same way it refuses a wrong code', async () => {
      const res = await post('/auth/register', {
        email: 'closed@example.com',
        password: PASSWORD,
        code: 'anything at all',
      });
      expect(res.status).toBe(401);
      expect(await users().findByEmail('closed@example.com')).toBeNull();
    });
  });

  describe('register', () => {
    beforeEach(() => {
      env.signupCode = SIGNUP;
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
  });

  describe('forgot-password', () => {
    it('answers 200 and does nothing at all for an unknown address', async () => {
      const res = await post('/auth/forgot-password', {
        email: 'ghost@example.com',
      });
      expect(res.status).toBe(200);
      expect(await resets().countDocuments({})).toBe(0);
      expect(mailer).not.toHaveBeenCalled();
    });

    it('mails one code and stores one hash for a known address', async () => {
      await users().create('taken@example.com', PASSWORD);
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);

      expect(mailer).toHaveBeenCalledTimes(1);
      expect(mailer.mock.calls[0][0]).toBe('taken@example.com');
      expect(await resets().countDocuments({})).toBe(1);

      // The stored value is the hash, not the code. Equal length, zero shared characters.
      const stored = String((await resets().findOne({}))?.codeHash ?? '');
      expect(stored).toHaveLength(64);
      expect(stored).not.toContain(mailedCode());
    });

    it('issues a second request inside the cooldown no second row', async () => {
      await users().create('taken@example.com', PASSWORD);
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);

      expect(await resets().countDocuments({})).toBe(1);
      expect(mailer).toHaveBeenCalledTimes(1);
    });

    it('still answers 200 when the mail never went out', async () => {
      await users().create('taken@example.com', PASSWORD);
      mailer.mockRejectedValue(new Error('resend is down'));

      const res = await post('/auth/forgot-password', {
        email: 'taken@example.com',
      });
      expect(res.status).toBe(200);
      // A row exists but nothing was delivered, so the next real attempt is still throttled.
      expect(await resets().countDocuments({})).toBe(1);
    });
  });

  describe('reset-password', () => {
    const requestReset = async () => {
      await users().create('taken@example.com', PASSWORD);
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);
      return mailedCode();
    };

    it('rejects a wrong code and leaves the old password working', async () => {
      await requestReset();

      const res = await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code: '00000000',
      });
      expect(res.status).toBe(401);

      await post('/auth/login', {
        email: 'taken@example.com',
        password: PASSWORD,
      }).expect(200);
    });

    it('answers an unknown address exactly as it answers a wrong code', async () => {
      await requestReset();
      const wrongCode = await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code: '00000000',
      });
      const unknown = await post('/auth/reset-password', {
        email: 'ghost@example.com',
        newPassword: NEW_PASSWORD,
        code: mailedCode(),
      });
      expect(wrongCode.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(wrongCode.body);
    });

    it('sets the new password and kills every existing session', async () => {
      await users().create('taken@example.com', PASSWORD);
      const auth = app.get(AuthService);
      const { user } = await auth.login({
        email: 'taken@example.com',
        password: PASSWORD,
        deviceId: 'phone-a',
      });
      const issued = await auth.tokens(user._id, {
        deviceId: 'phone-a',
        email: 'taken@example.com',
        password: PASSWORD,
      });
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code: mailedCode(),
      }).expect(204);

      await post('/auth/login', {
        email: 'taken@example.com',
        password: NEW_PASSWORD,
      }).expect(200);
      await post('/auth/login', {
        email: 'taken@example.com',
        password: PASSWORD,
      }).expect(401);
      // A token stolen before the reset must not survive it, or the reset bought nothing.
      await post('/auth/refresh', { refreshToken: issued.refreshToken }).expect(
        401,
      );
    });

    it('will not spend the same code twice', async () => {
      const code = await requestReset();

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code,
      }).expect(204);
      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: 'yet another passphrase',
        code,
      }).expect(401);

      // The second attempt really did nothing.
      await post('/auth/login', {
        email: 'taken@example.com',
        password: NEW_PASSWORD,
      }).expect(200);
    });

    it('rejects a code that has expired', async () => {
      const code = await requestReset();
      await resets()
        .updateMany({}, { $set: { expiresAt: new Date(0) } })
        .exec();

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code,
      }).expect(401);
      await post('/auth/login', {
        email: 'taken@example.com',
        password: PASSWORD,
      }).expect(200);
    });

    it('rejects a code that has already been superseded by a newer one', async () => {
      const code = await requestReset();
      // Ages the live reset past the cooldown, so the next request mints a second code.
      // Straight to the collection: `timestamps: true` rewrites createdAt on every
      // update, which would undo the ageing that lifts the cooldown.
      await resets().collection.updateMany(
        {},
        { $set: { createdAt: new Date(Date.now() - 120_000) } },
      );
      await post('/auth/forgot-password', {
        email: 'taken@example.com',
      }).expect(200);
      expect(mailer.mock.calls).toHaveLength(2);

      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code,
      }).expect(401);
      await post('/auth/reset-password', {
        email: 'taken@example.com',
        newPassword: NEW_PASSWORD,
        code: mailedCode(),
      }).expect(204);
    });
  });
});
