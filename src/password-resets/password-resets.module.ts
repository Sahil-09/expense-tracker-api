import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PasswordReset, PasswordResetSchema } from './password-reset.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PasswordReset.name, schema: PasswordResetSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class PasswordResetsModule {}
