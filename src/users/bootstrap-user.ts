/**
 * Creates the single account. Run once:
 *
 *   npm run bootstrap-user -- --email you@example.com
 *
 * The password is read from stdin, not from `--password`, because an argument shows up in
 * `ps` output and in shell history on the VPS — which is the same leak as committing it.
 * Passing it twice on a terminal is not supported; a pipe or a heredoc is:
 *
 *   npm run bootstrap-user -- --email you@example.com <<< 'the password'
 *
 * A standalone script rather than a seeded env value, so the password never sits in a
 * file that gets committed, and so re-running it is a deliberate act. There is no signup
 * route — see ADR-004.
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

/** No readline: stdin is a pipe, not a TTY, so one read is the whole thing. */
async function readPassword(): Promise<string> {
  let out = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) out += chunk;
  const trimmed = out.trim();
  if (!trimmed) throw new Error('No password on stdin');
  return trimmed;
}

async function main() {
  const email = arg('email');
  const password = await readPassword();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const users = app.get(UsersService);
  const model = app.get<Model<UserDocument>>(getModelToken(User.name));

  try {
    // Index creation is lazy in Mongo, so build them on every run rather than only when
    // the account is new — otherwise re-running after adding an index does nothing.
    await model.syncIndexes();

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
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
