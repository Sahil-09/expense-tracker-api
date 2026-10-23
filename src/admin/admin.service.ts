import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Device, DeviceDocument } from '../devices/device.schema';
import { Expense, ExpenseDocument } from '../sync/expense.schema';
import { ExpenseRow } from '../sync/dto';
import { sanitizeExpenses } from '../sync/sanitize';
import { User, UserDocument } from '../users/user.schema';
import { SyncService } from '../sync/sync.service';
import { env } from '../config/env';

const msOf = (d?: Date | null) => (d ? d.getTime() : null);

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
    @InjectModel(Expense.name)
    private readonly expenses: Model<ExpenseDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
    private readonly sync: SyncService,
  ) {}

  /**
   * Get all users with their aggregate spend/income for an optional date range.
   * Date range uses epoch milliseconds (browser-local month boundaries).
   *
   * Totals are computed in JS over each user's complete sanitized ledger — the same
   * rules and spend predicate the phone and the dashboard apply — instead of a Mongo
   * aggregate whose raw row set knows nothing about telecom junk, payment prompts or
   * duplicate scans. The ledger is a few thousand rows; one code path beats a pipeline
   * that quietly answers with different numbers than the app shows.
   */
  async getAllUsers(
    fromMs?: number,
    toMs?: number,
  ): Promise<AdminUserSummary[]> {
    const docRows = await this.expenses
      .find({})
      .select(
        'userId clientId amountPaise merchant category txnAt note rawSms dedupeKey source isExpense isDue isIncome deletedAt',
      )
      .lean()
      .exec();

    const rawByUser = new Map<string, ExpenseRow[]>();
    for (const d of docRows) {
      const row: ExpenseRow = {
        clientId: d.clientId,
        amountPaise: d.amountPaise,
        merchant: d.merchant ?? null,
        category: d.category,
        txnAt: d.txnAt.getTime(),
        note: d.note ?? null,
        rawSms: d.rawSms,
        dedupeKey: d.dedupeKey,
        source: d.source,
        isExpense: d.isExpense,
        isDue: d.isDue,
        isIncome: d.isIncome ?? false,
        deletedAt: msOf(d.deletedAt),
      };
      const key = String(d.userId);
      const list = rawByUser.get(key);
      if (list) list.push(row);
      else rawByUser.set(key, [row]);
    }

    // Every registered account, not just those with rows in the window — a month
    // with no activity must still list the user with zeroed totals.
    const userDocs = await this.users
      .find({})
      .select('email createdAt')
      .lean()
      .exec();
    const allUserIds = userDocs.map((u) => u._id);

    // Also get lastSeenAt from devices
    const deviceDocs = await this.devices
      .find({ userId: { $in: allUserIds }, revokedAt: null })
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

    return userDocs.map((u) => {
      // Sanitize on the user's COMPLETE ledger, then filter the window: a prompt and
      // its transfer can sit either side of a month boundary.
      const { rows: clean } = sanitizeExpenses(
        rawByUser.get(u._id.toString()) ?? [],
      );
      const inRange = clean.filter(
        (r) =>
          (fromMs === undefined || r.txnAt >= fromMs) &&
          (toMs === undefined || r.txnAt < toMs),
      );
      let spendPaise = 0;
      let incomePaise = 0;
      let txnCount = 0;
      let lastTxnAt: number | null = null;
      for (const r of inRange) {
        if (r.deletedAt !== null) continue;
        if (lastTxnAt === null || r.txnAt > lastTxnAt) lastTxnAt = r.txnAt;
        if (r.isExpense && !r.isIncome) {
          spendPaise += r.amountPaise;
          txnCount++;
        } else if (r.isIncome) {
          incomePaise += r.amountPaise;
        }
      }
      return {
        id: u._id.toString(),
        email: u.email,
        createdAt: u.createdAt!,
        lastSeenAt: lastSeenByUser.get(u._id.toString()) ?? null,
        spendPaise,
        incomePaise,
        txnCount,
        lastTxnAt,
      };
    });
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
