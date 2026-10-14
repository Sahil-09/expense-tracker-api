import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { Device, DeviceSchema } from '../devices/device.schema';
import { PasswordResetsModule } from '../password-resets/password-resets.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    PasswordResetsModule,
    MongooseModule.forFeature([{ name: Device.name, schema: DeviceSchema }]),
    // No secret here: access and refresh tokens are signed with two different keys, set
    // per-call in AuthService, so there is no single place to get them backwards.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
