import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { SafeLogger } from '../logging/safe-logger';
import { Budget, BudgetDocument } from './budget.schema';
import {
  BudgetChange,
  ExclusionChange,
  ExpenseChange,
  ExpenseRow,
  SyncRequest,
  SyncResponse,
} from './dto';
import { Exclusion, ExclusionDocument } from './exclusion.schema';
import { Expense, ExpenseDocument } from './expense.schema';

/** Rows per pull per collection. Enough that a phone never loops on a normal sync. */
const PAGE = 500;

const ms = (d?: Date | null) => (d ? d.getTime() : null);

@Injectable()
export class SyncService {
  private readonly log = new SafeLogger(SyncService.name);

  constructor(
    @InjectModel(Expense.name)
    private readonly expenses: Model<ExpenseDocument>,
    @InjectModel(Budget.name) private readonly budgets: Model<BudgetDocument>,
    @InjectModel(Exclusion.name)
    private readonly exclusions: Model<ExclusionDocument>,
  ) {}

  /**
   * Push what changed, pull what changed. One endpoint for all three collections because
   * the local DB stores them the same way and the cursor logic is identical.
   *
   * Push is idempotent and pull is cursor-based, so the phone can fire this after every
   * scan without tracking what it already sent.
   */
  async sync(userId: Types.ObjectId, req: SyncRequest): Promise<SyncResponse> {
    const duplicates: Record<string, string> = {};
    const pushed = {
      expenses: await this.pushExpenses(userId, req.expenses ?? [], duplicates),
      budgets: (req.budgets ?? []).map((c) => c.category),
      exclusions: (req.exclusions ?? []).map((c) => c.merchant),
    };
    await this.pushBudgets(userId, req.budgets ?? []);
    await this.pushExclusions(userId, req.exclusions ?? []);

    // Taken after the writes and before the reads, so a row written by anyone during this
    // call falls after the cursor and is delivered next time rather than being lost
    // between the two.
    const cursor = new Date();
    const since = req.cursor ? new Date(req.cursor) : new Date(0);

    const [expenses, budgets, exclusions] = await Promise.all([
      this.pullExpenses(userId, since, pushed.expenses),
      this.pullBudgets(userId, since, pushed.budgets),
      this.pullExclusions(userId, since, pushed.exclusions),
    ]);

    this.log.log(
      `pushed ${pushed.expenses.length}/${pushed.budgets.length}/${pushed.exclusions.length}, ` +
        `pulled ${expenses.length}/${budgets.length}/${exclusions.length}, ` +
        `${Object.keys(duplicates).length} duplicate(s)`,
    );

    return {
      cursor: cursor.toISOString(),
      hasMore:
        expenses.length >= PAGE ||
        budgets.length >= PAGE ||
        exclusions.length >= PAGE,
      expenses,
      budgets,
      exclusions,
      duplicates,
    };
  }

  /**
   * Upsert on (userId, clientId), the server-side twin of the local autoincrement id.
   *
   * A phone re-pushing a row it already sent lands on the same document and rewrites it
   * with identical values. That is the cheapest way to be idempotent, and it removes any
   * state where a half-failed request leaves the server believing it holds something it
   * does not.
   *
   * Last-write-wins falls out of this rather than being checked: the server stamps
   * `updatedAt` from its own clock on every write and the pull cursor reads that field, so
   * whichever push lands last both wins and is the one the other device pulls next. No
   * timestamp comparison, and therefore no way for a phone with a wrong clock to win.
   */
  private async pushExpenses(
    userId: Types.ObjectId,
    changes: ExpenseChange[],
    duplicates: Record<string, string>,
  ): Promise<string[]> {
    const written: string[] = [];

    for (const c of changes) {
      // Another row already holds this dedupeKey: the same SMS scanned on two phones.
      // Recording the clash lets the phone drop its copy rather than ending up with one
      // expense counted twice — which is exactly what the unique index would otherwise
      // turn into a 500.
      const clash = await this.expenses
        .findOne({
          userId,
          dedupeKey: c.dedupeKey,
          clientId: { $ne: c.clientId },
        })
        .select('clientId')
        .lean()
        .exec();
      if (clash) {
        duplicates[c.clientId] = clash.clientId;
        continue;
      }

      await this.expenses.updateOne(
        { userId, clientId: c.clientId },
        {
          $set: {
            amountPaise: c.amountPaise,
            merchant: c.merchant ?? null,
            category: c.category,
            txnAt: new Date(c.txnAt),
            note: c.note ?? null,
            rawSms: c.rawSms,
            dedupeKey: c.dedupeKey,
            source: c.source,
            isExpense: c.isExpense,
            isDue: c.isDue,
            // A delete is a tombstone, so the other phone learns about it and the row
            // stays addressable to the cursor.
            deletedAt: c.deleted ? new Date() : null,
          },
        },
        { upsert: true },
      );
      written.push(c.clientId);
    }

    return written;
  }

  private async pushBudgets(
    userId: Types.ObjectId,
    changes: BudgetChange[],
  ): Promise<void> {
    for (const c of changes) {
      await this.budgets.updateOne(
        { userId, category: c.category },
        {
          $set: {
            monthlyPaise: c.monthlyPaise,
            deletedAt: c.deleted ? new Date() : null,
          },
        },
        { upsert: true },
      );
    }
  }

  private async pushExclusions(
    userId: Types.ObjectId,
    changes: ExclusionChange[],
  ): Promise<void> {
    for (const c of changes) {
      await this.exclusions.updateOne(
        { userId, merchant: c.merchant },
        { $set: { deletedAt: c.deleted ? new Date() : null } },
        { upsert: true },
      );
    }
  }

  /**
   * Tombstones included, the caller's own just-pushed rows excluded.
   *
   * The exclusion is what makes a cursor workable: without it a device would receive back
   * everything it just sent on every single sync and rewrite it locally forever.
   */
  private async pullExpenses(
    userId: Types.ObjectId,
    since: Date,
    exclude: string[],
  ): Promise<ExpenseRow[]> {
    const rows = await this.expenses
      .find({
        userId,
        updatedAt: { $gt: since },
        ...(exclude.length > 0 ? { clientId: { $nin: exclude } } : {}),
      })
      .sort({ updatedAt: 1 })
      .limit(PAGE)
      .lean()
      .exec();

    return rows.map((r) => ({
      clientId: r.clientId,
      amountPaise: r.amountPaise,
      merchant: r.merchant ?? null,
      category: r.category,
      txnAt: r.txnAt.getTime(),
      note: r.note ?? null,
      rawSms: r.rawSms,
      dedupeKey: r.dedupeKey,
      source: r.source,
      isExpense: r.isExpense,
      isDue: r.isDue,
      deletedAt: ms(r.deletedAt),
    }));
  }

  private async pullBudgets(
    userId: Types.ObjectId,
    since: Date,
    exclude: string[],
  ) {
    const rows = await this.budgets
      .find({
        userId,
        updatedAt: { $gt: since },
        ...(exclude.length > 0 ? { category: { $nin: exclude } } : {}),
      })
      .sort({ updatedAt: 1 })
      .limit(PAGE)
      .lean()
      .exec();
    return rows.map((r) => ({
      category: r.category,
      monthlyPaise: r.monthlyPaise,
      deletedAt: ms(r.deletedAt),
    }));
  }

  private async pullExclusions(
    userId: Types.ObjectId,
    since: Date,
    exclude: string[],
  ) {
    const rows = await this.exclusions
      .find({
        userId,
        updatedAt: { $gt: since },
        ...(exclude.length > 0 ? { merchant: { $nin: exclude } } : {}),
      })
      .sort({ updatedAt: 1 })
      .limit(PAGE)
      .lean()
      .exec();
    return rows.map((r) => ({
      merchant: r.merchant,
      deletedAt: ms(r.deletedAt),
    }));
  }
}
