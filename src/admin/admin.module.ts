import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Expense, ExpenseSchema } from '../sync/expense.schema';
import { SyncModule } from '../sync/sync.module';
import { User, UserSchema } from '../users/user.schema';
import { Device, DeviceSchema } from '../devices/device.schema';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
    ]),
    SyncModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}