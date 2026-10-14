/**
 * Creates the single account. Run once:
 *
 *   npm run bootstrap-user -- --email you@example.com --password '...'
 *
 * A standalone script rather than a seeded env value, so the password never sits in a file
 * that gets committed, and so re-running it is a deliberate act. Exists because there is no
 * signup route — see ADR-004.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model } from 'mongoose';

import { AppModule } from '../app.module';
import { User, UserDocument } from './user.schema';
import { ARGON_OPTIONS, UsersService } from './users.service';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function main() {
  const email = arg('email');
  const password = arg('password');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const users = app.get(UsersService);
  const model = app.get<Model<UserDocument>>(getModelToken(User.name));

  try {
    const existing = await users.findByEmail(email);
    if (existing) {
      // Replace rather than fail: the common case is re-running this after a password
      // change, and refusing would just mean hand-editing the database instead.
      existing.passwordHash = await argon2.hash(password, ARGON_OPTIONS);
      await existing.save();
      console.log(`Reset the password for ${email}.`);
      return;
    }

    await users.create(email, password);
    console.log(`Created ${email}.`);

    // Index creation is lazy in Mongo, so create them now rather than letting the first
    // duplicate silently succeed because the unique index was not built yet.
    await model.syncIndexes();
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
