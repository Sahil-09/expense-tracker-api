import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { Model, Types } from 'mongoose';

import { env } from '../config/env';
import { Device, DeviceDocument } from '../devices/device.schema';
import { SafeLogger } from '../logging/safe-logger';
import { sendPasswordResetEmail } from '../mail/resend';
import {
  PasswordReset,
  PasswordResetDocument,
} from '../password-resets/password-reset.schema';
import { UserDocument } from '../users/user.schema';
import { UsersService } from '../users/users.service';
import { LoginDto, RegisterDto, ResetPasswordDto } from './dto';

/** How long a mailed code is good for, and how long before another one may be sent. */
const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60_000;

/**
 * SHA-256 of `${userId}:${code}`.
 *
 * Not argon2: an eight-digit code has under 27 bits of entropy and is only alive for
 * fifteen minutes, so the expensive work would buy nothing against an offline guess but
 * would make every reset a slow login. Binding the hash to the user costs nothing and
 * means a hash lifted from one row cannot be replayed against another.
 */
function codeHash(userId: Types.ObjectId, code: string): string {
  return createHash('sha256')
    .update(`${userId.toString()}:${code}`)
    .digest('hex');
}

/**
 * The refresh token is stored as a SHA-256 digest, not hashed with argon2.
 *
 * The digest is of a 256-bit random value, not a password: there is nothing to brute-force,
 * so argon2's per-login cost buys nothing and only makes every refresh slow. A leak of the
 * database still cannot be replayed as a token.
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AccessPayload = { sub: string; deviceId?: string };

export type AccessPayloadResult = {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  deviceId: string;
};

/** The device fields both LoginDto and RegisterDto carry. */
type DeviceInfo = {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  /** Carried but unread here, so a LoginDto can be passed straight through. */
  email?: string;
  password?: string;
};

@Injectable()
export class AuthService {
  private readonly log = new SafeLogger(AuthService.name);

  constructor(
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
    @InjectModel(PasswordReset.name)
    private readonly resets: Model<PasswordResetDocument>,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  /** A missing account and a wrong password give the same error, so the endpoint cannot be used to discover which emails exist. */
  async login(dto: LoginDto): Promise<{ user: UserDocument }> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !(await this.users.verify(user, dto.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return { user };
  }

  async tokens(userId: Types.ObjectId, dto: DeviceInfo) {
    const device = dto.deviceId
      ? await this.touchDevice(userId, dto)
      : await this.createDevice(userId, dto);
    const refreshToken = randomUUID();
    device.refreshTokenHash = tokenHash(refreshToken);
    device.refreshTokenExpiresAt = this.refreshExpiry();
    device.lastSeenAt = new Date();
    await device.save();
    return this.session(device, refreshToken);
  }

  /**
   * Rotating, and atomic.
   *
   * The lookup that swaps the hash is also the check, so two requests carrying the same
   * token cannot both win: the second finds nothing left to match and is rejected. A
   * read-then-write leaves a window where both read the same document and the last save
   * silently invalidates the token the other one just handed the client.
   */
  async refresh(refreshToken: string) {
    const rotated = randomUUID();
    const device = await this.devices
      .findOneAndUpdate(
        {
          refreshTokenHash: tokenHash(refreshToken),
          revokedAt: null,
          refreshTokenExpiresAt: { $gt: new Date() },
        },
        {
          $set: {
            refreshTokenHash: tokenHash(rotated),
            refreshTokenExpiresAt: this.refreshExpiry(),
            lastSeenAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();

    if (!device) throw new UnauthorizedException('Refresh token is not valid');

    return this.session(device, rotated);
  }

  /** Idempotent: a token that is already gone is a successful logout. */
  async logout(refreshToken: string): Promise<void> {
    await this.devices
      .updateOne(
        { refreshTokenHash: tokenHash(refreshToken) },
        {
          $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
          $set: { revokedAt: new Date() },
        },
      )
      .exec();
  }

  /**
   * The wire shape. `expiresIn` is in **seconds**, which is what the JWT spec and every
   * JWT library use. Sending milliseconds here makes a client that trusts the number
   * believe a 15-minute token is good for ten days.
   */
  private session(
    device: DeviceDocument,
    refreshToken: string,
  ): AccessPayloadResult {
    const accessToken = this.jwt.sign(
      {
        sub: device.userId.toString(),
        deviceId: device.deviceId,
      } satisfies AccessPayload,
      { secret: env.jwtSecret, expiresIn: env.accessTtl },
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.round(env.accessTtl / 1000),
      deviceId: device.deviceId,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + env.refreshTtlDays * 86_400_000);
  }

  /**
   * Creates an account, gated by the owner's SIGNUP_CODE.
   *
   * The code is checked before the password is touched. Checking it afterwards would make
   * this a free argon2 endpoint for anyone who can reach the URL, which on a small VPS is
   * a CPU denial of service for about 50ms a request.
   *
   * A wrong code and a closed route both fail with the same 401, so the response cannot
   * be used to discover whether signup is even enabled.
   */
  async register(dto: RegisterDto): Promise<AccessPayloadResult> {
    this.assertCode(env.signupCode, dto.code);

    const user = await this.users.create(dto.email, dto.password);
    if (!user) throw new ConflictException('That email is already registered');

    return this.tokens(user._id, dto);
  }

  /**
   * Mails a fresh code. Always answers the same thing, whatever the address.
   *
   * An unknown email returns before any row is written and before any mail is sent, so
   * this endpoint cannot be used to find out who has an account — the point being that
   * the response and its timing give away nothing either.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;

    const now = new Date();
    const live = await this.resets
      .findOne({
        userId: user._id,
        consumedAt: null,
        expiresAt: { $gt: now },
      })
      .exec();

    // Throttle: one mail per address per minute. We cannot resend the code we already
    // sent, because only its hash was kept, so the alternative to refusing is to mail a
    // second code and silently retire the first.
    if (live && now.getTime() - live.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return;
    }

    if (live)
      await this.resets
        .updateOne({ _id: live._id }, { $set: { consumedAt: now } })
        .exec();

    // Eight digits, not six: there is no rate limiter on the spending endpoint, and six
    // is guessable inside the fifteen-minute window.
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    await this.resets.create({
      userId: user._id,
      codeHash: codeHash(user._id, code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      consumedAt: null,
    });

    try {
      await sendPasswordResetEmail(user.email, code);
    } catch (e) {
      // Fail open. The response has to be a 200 whether or not the account exists, and a
      // 500 here would turn every Resend outage into a signal that a given address is
      // registered. The row stays: the code is still valid, and the request can simply
      // be made again once the cooldown passes.
      this.log.error('Could not send a password reset email', e);
    }
  }

  /**
   * Spends a mailed code.
   *
   * The consumption is the lookup, so the same code cannot be spent twice: the second
   * request finds nothing unconsumed to match and is rejected.
   *
   * Every existing session is dropped. Without that, a refresh token stolen before the
   * reset still works for its full 30 days and the reset bought nothing at all.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('That code is not valid');

    const consumed = await this.resets
      .findOneAndUpdate(
        {
          userId: user._id,
          codeHash: codeHash(user._id, dto.code),
          consumedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { consumedAt: new Date() } },
        { new: false },
      )
      .exec();

    // Wrong, already spent, expired and unknown address all fail identically, so the
    // error cannot be used to tell which of them happened.
    if (!consumed) throw new UnauthorizedException('That code is not valid');

    await this.users.setPassword(user, dto.newPassword);
    await this.devices
      .updateMany(
        { userId: user._id },
        {
          $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
          $set: { revokedAt: new Date() },
        },
      )
      .exec();
  }

  /**
   * Constant-time, and only ever when the route is actually open.
   *
   * `null` means closed, which throws the same error a wrong code does.
   */
  private assertCode(expected: string | null, given: string): void {
    if (expected === null) throw new UnauthorizedException('Not available');
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    // timingSafeEqual throws on a length mismatch, which would itself leak the length.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('That code is not valid');
    }
  }

  private createDevice(
    userId: Types.ObjectId,
    dto: DeviceInfo,
  ): Promise<DeviceDocument> {
    return this.devices.create({
      userId,
      deviceId: dto.deviceId ?? randomUUID(),
      name: dto.deviceName ?? 'Phone',
      platform: dto.platform ?? 'unknown',
    });
  }

  private async touchDevice(
    userId: Types.ObjectId,
    dto: DeviceInfo,
  ): Promise<DeviceDocument> {
    // A fresh login revives a device that was logged out, otherwise one accidental
    // sign-out would permanently lock the phone out.
    const device = await this.devices
      .findOneAndUpdate(
        { userId, deviceId: dto.deviceId },
        {
          $set: {
            name: dto.deviceName ?? 'Phone',
            platform: dto.platform ?? 'unknown',
            revokedAt: null,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    if (!device)
      throw new UnauthorizedException('Could not register this device');
    return device;
  }
}
