import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { env } from './config/env';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

@Module({
  // env is validated on import, so a missing JWT secret or an unreachable-looking Mongo URI
  // stops the process at boot rather than at the first login.
  imports: [
    MongooseModule.forRoot(env.mongoUri),
    UsersModule,
    AuthModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
