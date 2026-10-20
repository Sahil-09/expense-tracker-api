import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Device, DeviceDocument } from '../devices/device.schema';
import { Expense, ExpenseDocument } from '../sync/expense.schema';
import { User, UserDocument } from '../users/user.schema';
import { SyncService } from '../sync/sync.service';
import { env } from '../config/env';

export interface AdminUserSummary {
  id: string;
  email: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  spendPaise: number;
  incomePaise: number;
  txnCount: number;
  lastTxnAt: number | null;
}

interface AdminPullParams {
  userId: Types.ObjectId;
  cursor?: string | null;
}

interface AdminPullResult {
  cursor: string;
  hasMore: boolean;
  expenses: AdminExpenseRow[];
  budgets: AdminBudgetRow[];
  exclusions: AdminExclusionRow[];
  duplicates: Record<string, string>;
}

export interface AdminExpenseRow {
  clientId: string;
  amountPaise: number;
  merchant: string | null;
  category: string;
  txnAt: number;
  note: string | null;
  rawSms: string;
  dedupeKey: string;
  source: string;
  isExpense: boolean;
  isDue: boolean;
  isIncome: boolean;
  deletedAt: number | null;
}

export interface AdminBudgetRow {
  category: string;
  monthlyPaise: number;
  deletedAt: number | null;
}

export interface AdminExclusionRow {
  merchant: string;
  deletedAt: number | null;
}

/**
 * Read-only admin service for cross-user expense data.
 *
 * Spend predicate mirrors the phone: isExpense && !isIncome && deletedAt === null
 * Income predicate: isIncome === true
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectModel(Expense.name) private readonly expenses: Model<ExpenseDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
    private readonly sync: SyncService,
  ) {}

  /**
   * Get all users with their aggregate spend/income for an optional date range.
   * Date range uses epoch milliseconds (browser-local month boundaries).
   */
  async getAllUsers(
    fromMs?: number,
    toMs?: number,
  ): Promise<AdminUserSummary[]> {
    const match: Record<string, unknown> = {};

    if (fromMs !== undefined || toMs !== undefined) {
      match.txnAt = {};
      if (fromMs !== undefined) (match.txnAt as Record<string, number>).$gte = fromMs;
      if (toMs !== undefined) (match.txnAt as Record<string, number>).$lt = toMs;
    }

    // Aggregate spend and income per user
    const spendAgg = await this.expenses.aggregate<{
      _id: Types.ObjectId;
      spendPaise: number;
      incomePaise: number;
      txnCount: number;
      lastTxnAt: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: '$userId',
          spendPaise: {
            $sum: {
              $cond: [
                { $and: ['$isExpense', { $not: '$isIncome' }, { $eq: ['$deletedAt', null] }] },
                '$amountPaise',
                0,
              ],
            },
          },
          incomePaise: {
            $sum: { $cond: ['$isIncome', '$amountPaise', 0] },
          },
          txnCount: {
            $sum: {
              $cond: [
                { $and: ['$isExpense', { $not: '$isIncome' }, { $eq: ['$deletedAt', null] }] },
                1,
                0,
              ],
            },
          },
          lastTxnAt: { $max: '$txnAt' },
        },
      },
    ]).exec();

    const byUser = new Map<string, number>();
    const incomeByUser = new Map<string, number>();
    const countByUser = new Map<string, number>();
    const lastTxnByUser = new Map<string, number>();

    for (const row of spendAgg) {
      byUser.set(row._id.toString(), row.spendPaise);
      incomeByUser.set(row._id.toString(), row.incomePaise);
      countByUser.set(row._id.toString(), row.txnCount);
      lastTxnByUser.set(row._id.toString(), row.lastTxnAt);
    }

    // Get all users that have expenses (from the aggregation)
    const userIds = [...new Set(spendAgg.map((r) => r._id.toString()))];
    const userDocs = await this.users
      .find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } })
      .select('email createdAt')
      .lean()
      .exec();

    // Also get lastSeenAt from devices
    const deviceDocs = await this.devices
      .find({ userId: { $in: userIds.map((id) => new Types.ObjectId(id)) }, revokedAt: null })
      .select('userId lastSeenAt')
      .lean()
      .exec();

    const lastSeenByUser = new Map<string, Date | null>();
    for (const d of deviceDocs) {
      const uid = d.userId.toString();
      const seen = d.lastSeenAt;
      if (!seen) continue;
      const existing = lastSeenByUser.get(uid);
      if (!existing || seen > existing) {
        lastSeenByUser.set(uid, seen);
      }
    }

    return userDocs.map((u) => ({
      id: u._id.toString(),
      email: u.email,
      createdAt: u.createdAt!,
      lastSeenAt: lastSeenByUser.get(u._id.toString()) ?? null,
      spendPaise: byUser.get(u._id.toString()) ?? 0,
      incomePaise: incomeByUser.get(u._id.toString()) ?? 0,
      txnCount: countByUser.get(u._id.toString()) ?? 0,
      lastTxnAt: lastTxnByUser.get(u._id.toString()) ?? null,
    }));
  }

  /**
   * Pull expenses, budgets, exclusions for a specific user (admin drill-down).
   * Uses SyncService.pull() to avoid duplicating cursor logic.
   */
  async pullUserData(params: AdminPullParams): Promise<AdminPullResult> {
    const result = await this.sync.pull(params.userId, params.cursor);
    return {
      cursor: result.cursor,
      hasMore: result.hasMore,
      expenses: result.expenses,
      budgets: result.budgets,
      exclusions: result.exclusions,
      duplicates: result.duplicates,
    };
  }
}