import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { Exclusion, ExclusionSchema } from '../sync/exclusion.schema';
import { Expense, ExpenseSchema } from '../sync/expense.schema';
import { UsersModule } from '../users/users.module';
import { SmsAuthGuard } from './sms-auth.guard';
import { SmsController } from './sms.controller';
import { SmsService } from './sms.service';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
      { name: Exclusion.name, schema: ExclusionSchema },
    ]),
  ],
  controllers: [SmsController],
  providers: [SmsService, SmsAuthGuard],
})
export class SmsModule {}
