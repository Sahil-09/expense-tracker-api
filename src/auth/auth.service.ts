import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';

import { env } from '../config/env';
import { Device, DeviceDocument } from '../devices/device.schema';
import { UserDocument } from '../users/user.schema';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto';

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

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
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

  async tokens(userId: Types.ObjectId, dto: LoginDto) {
    const device = dto.deviceId
      ? await this.touchDevice(userId, dto)
      : await this.createDevice(userId, dto);
    return this.issue(userId, device);
  }

  /** Rotating: the presented token is replaced as the new one is minted. */
  async refresh(refreshToken: string) {
    const device = await this.devices
      .findOne({ refreshTokenHash: tokenHash(refreshToken) })
      .exec();

    const expired =
      !device?.refreshTokenExpiresAt ||
      device.refreshTokenExpiresAt.getTime() <= Date.now();
    if (!device || device.revokedAt || expired) {
      throw new UnauthorizedException('Refresh token is not valid');
    }

    return this.issue(device.userId, device);
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

  private async issue(userId: Types.ObjectId, device: DeviceDocument) {
    const payload: AccessPayload = {
      sub: userId.toString(),
      deviceId: device.deviceId,
    };
    const accessToken = this.jwt.sign(payload, {
      secret: env.jwtSecret,
      expiresIn: env.accessTtl,
    });

    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + env.refreshTtlDays * 86_400_000);
    device.refreshTokenHash = tokenHash(refreshToken);
    device.refreshTokenExpiresAt = expiresAt;
    device.lastSeenAt = new Date();
    await device.save();

    return {
      accessToken,
      refreshToken,
      expiresIn: env.accessTtl,
      deviceId: device.deviceId,
    };
  }

  private createDevice(
    userId: Types.ObjectId,
    dto: LoginDto,
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
    dto: LoginDto,
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
