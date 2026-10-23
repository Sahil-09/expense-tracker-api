import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { Expense, ExpenseSchema } from '../sync/expense.schema';
import { SyncModule } from '../sync/sync.module';
import { User, UserSchema } from '../users/user.schema';
import { UsersModule } from '../users/users.module';
import { Device, DeviceSchema } from '../devices/device.schema';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
    ]),
    SyncModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
