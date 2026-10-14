import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { env } from './config/env';
import { SafeLogger } from './logging/safe-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // The whole service logs through this, so redaction is not something each call site
    // has to remember.
    logger: new SafeLogger(),
  });

  // Bank SMS rides in every sync body, so the default 100kb limit is too small for a
  // full-history push. Capped well below anything a real client would send.
  app.use(json({ limit: '4mb' }));
  app.use(helmet());

  // Native clients send no Origin. An explicit list (even empty) rather than a wildcard,
  // so adding a browser client later is a deliberate act instead of an accident.
  app.enableCors({ origin: env.corsOrigins, methods: ['GET', 'POST'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(env.port, '0.0.0.0');
  new SafeLogger('bootstrap').log(`Expense Tracker API on :${env.port}`);
}

bootstrap().catch((e) => {
  // Validation already throws inside env.ts, so reaching here means the process could
  // not start. Without this it would be an unhandled rejection and a bare exit code.
  new SafeLogger('bootstrap').error(e instanceof Error ? e.message : e);
  process.exit(1);
});
