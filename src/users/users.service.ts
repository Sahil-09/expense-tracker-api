import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model } from 'mongoose';

import { User, UserDocument } from './user.schema';

/**
 * argon2id, the memory-hard variant. One account, so the cost is paid once per login.
 *
 * 19 MiB / 2 passes is the OWASP baseline rather than the argon2 defaults (64 MiB / 4),
 * which on a small VPS is a slow login for no extra protection against a single attacker.
 */
export const ARGON_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async create(email: string, password: string): Promise<UserDocument> {
    return this.users.create({
      email: email.trim().toLowerCase(),
      passwordHash: await argon2.hash(password, ARGON_OPTIONS),
    });
  }

  /** Case-insensitive, matching the lowercase unique index. Null rather than a throw so login cannot enumerate accounts. */
  findByEmail(email: string): Promise<UserDocument | null> {
    return this.users.findOne({ email: email.trim().toLowerCase() }).exec();
  }

  findById(id: string): Promise<UserDocument | null> {
    return this.users.findById(id).exec();
  }

  verify(user: UserDocument, password: string): Promise<boolean> {
    return argon2.verify(user.passwordHash, password).catch(() => false);
  }
}
