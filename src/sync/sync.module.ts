import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { Device, DeviceSchema } from '../devices/device.schema';
import { Budget, BudgetSchema } from './budget.schema';
import { Exclusion, ExclusionSchema } from './exclusion.schema';
import { Expense, ExpenseSchema } from './expense.schema';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
      { name: Budget.name, schema: BudgetSchema },
      { name: Exclusion.name, schema: ExclusionSchema },
      { name: Device.name, schema: DeviceSchema },
    ]),
  ],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
