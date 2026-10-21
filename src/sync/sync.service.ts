import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { SafeLogger } from '../logging/safe-logger';
import { Device, DeviceDocument } from '../devices/device.schema';
import { reconcilePushedBulk } from '../sms/bulk';
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
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
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

    // Clamped to now. A cursor the client somehow stored in the future would otherwise
    // match nothing at all and silently stop every update on that device, with no error
    // and no way back except clearing its data.
    const since = req.cursor
      ? new Date(Math.min(new Date(req.cursor).getTime(), Date.now()))
      : new Date(0);

    const [expensesPull, budgetsPull, exclusionsPull] = await Promise.all([
      this.pullExpenses(userId, since, pushed.expenses),
      this.pullBudgets(userId, since, pushed.budgets),
      this.pullExclusions(userId, since, pushed.exclusions),
    ]);

    const expenses = expensesPull.items;
    const budgets = budgetsPull.items;
    const exclusions = exclusionsPull.items;

    // Advance cursor safely: to prevent data loss when pagination cuts off some collections,
    // we take the minimum of the lastUpdatedAt of any truncated collection (length >= PAGE),
    // or the current start of the sync (cursor).
    const safeLimits = [
      expenses.length >= PAGE && expensesPull.lastUpdatedAt
        ? expensesPull.lastUpdatedAt
        : cursor,
      budgets.length >= PAGE && budgetsPull.lastUpdatedAt
        ? budgetsPull.lastUpdatedAt
        : cursor,
      exclusions.length >= PAGE && exclusionsPull.lastUpdatedAt
        ? exclusionsPull.lastUpdatedAt
        : cursor,
    ];
    const nextCursor = new Date(
      Math.min(...safeLimits.map((d) => d.getTime())),
    );

    this.log.log(
      `pushed ${pushed.expenses.length}/${pushed.budgets.length}/${pushed.exclusions.length}, ` +
        `pulled ${expenses.length}/${budgets.length}/${exclusions.length}, ` +
        `${Object.keys(duplicates).length} duplicate(s)`,
    );

    // The whole reason the devices collection exists. Fire and forget: one update against
    // a request that already made hundreds of database calls, and a device that has been
    // offline for a month should not fail its sync over it.
    void this.devices
      .updateOne(
        { userId, deviceId: req.deviceId },
        { $set: { lastSeenAt: new Date() } },
      )
      .catch(() => {});

    return {
      cursor: nextCursor.toISOString(),
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
    if (changes.length === 0) return [];

    // Every clash in one query rather than one per row. A first sync of a year of history
    // is a few hundred rows, and two awaited round trips each is a sync that takes seconds
    // for no reason.
    //
    // `deletedAt: null` mirrors the partial unique index exactly: tombstones share one
    // constant dedupeKey and must never be treated as owning it.
    const held = new Map<string, string>();
    const live = changes.filter((c) => !c.deleted);
    if (live.length > 0) {
      const rows = await this.expenses
        .find({
          userId,
          deletedAt: null,
          dedupeKey: { $in: live.map((c) => c.dedupeKey) },
        })
        .select('clientId dedupeKey')
        .lean()
        .exec();
      for (const r of rows)
        if (!held.has(r.dedupeKey)) held.set(r.dedupeKey, r.clientId);
    }

    // Bulk-statement SMS pushed by a phone running the older single-transaction parser:
    // piece 1 of each is repaired in place and the missing pieces are minted below, all
    // before the ops are built so neither needs a second write path.
    await reconcilePushedBulk(this.expenses, this.exclusions, userId, changes);

    const written: string[] = [];
    const ops: Parameters<typeof this.expenses.bulkWrite>[0] = [];

    for (const c of changes) {
      if (!c.deleted) {
        // Another row already holds this dedupeKey: the same SMS scanned on two phones.
        // Recording the clash lets the phone drop its copy rather than ending up with one
        // expense counted twice — which is exactly what the unique index would otherwise
        // turn into a 500.
        //
        // Skipped for tombstones. A tombstone carries no message text, so its dedupeKey is
        // a constant — checking it would make every delete after the first look like a
        // duplicate of the previous one, and those deletes would be dropped forever.
        const owner = held.get(c.dedupeKey);
        if (owner !== undefined && owner !== c.clientId) {
          duplicates[c.clientId] = owner;
          continue;
        }
        held.set(c.dedupeKey, c.clientId);
      }

      ops.push({
        updateOne: {
          filter: { userId, clientId: c.clientId },
          update: {
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
              isIncome: c.isIncome ?? false,
              // A delete is a tombstone, so the other phone learns about it and the row
              // stays addressable to the cursor.
              deletedAt: c.deleted ? new Date() : null,
            },
          },
          upsert: true,
        },
      });
      written.push(c.clientId);
    }

    // Unordered: one rejected row must not abandon the rest of the batch.
    if (ops.length > 0) {
      try {
        await this.expenses.bulkWrite(ops, { ordered: false });
      } catch (e) {
        const isDup =
          typeof e === 'object' &&
          e !== null &&
          (e as { code?: number }).code === 11000;
        if (!isDup) throw e;
      }
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
  ): Promise<{ items: ExpenseRow[]; lastUpdatedAt?: Date }> {
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

    const items = rows.map((r) => ({
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
      isIncome: r.isIncome ?? false,
      deletedAt: ms(r.deletedAt),
    }));

    return {
      items,
      lastUpdatedAt:
        rows.length > 0 ? rows[rows.length - 1].updatedAt : undefined,
    };
  }

  private async pullBudgets(
    userId: Types.ObjectId,
    since: Date,
    exclude: string[],
  ): Promise<{
    items: {
      category: string;
      monthlyPaise: number;
      deletedAt: number | null;
    }[];
    lastUpdatedAt?: Date;
  }> {
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
    const items = rows.map((r) => ({
      category: r.category,
      monthlyPaise: r.monthlyPaise,
      deletedAt: ms(r.deletedAt),
    }));
    return {
      items,
      lastUpdatedAt:
        rows.length > 0 ? rows[rows.length - 1].updatedAt : undefined,
    };
  }

  private async pullExclusions(
    userId: Types.ObjectId,
    since: Date,
    exclude: string[],
  ): Promise<{
    items: { merchant: string; deletedAt: number | null }[];
    lastUpdatedAt?: Date;
  }> {
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
    const items = rows.map((r) => ({
      merchant: r.merchant,
      deletedAt: ms(r.deletedAt),
    }));
    return {
      items,
      lastUpdatedAt:
        rows.length > 0 ? rows[rows.length - 1].updatedAt : undefined,
    };
  }

  /**
   * Pull-only variant for admin drill-down.
   * Same cursor logic as sync() but without push/echo-suppression.
   */
  async pull(
    userId: Types.ObjectId,
    cursor?: string | null,
  ): Promise<SyncResponse> {
    const since = cursor
      ? new Date(Math.min(new Date(cursor).getTime(), Date.now()))
      : new Date(0);

    const [expensesPull, budgetsPull, exclusionsPull] = await Promise.all([
      this.pullExpenses(userId, since, []),
      this.pullBudgets(userId, since, []),
      this.pullExclusions(userId, since, []),
    ]);

    const expenses = expensesPull.items;
    const budgets = budgetsPull.items;
    const exclusions = exclusionsPull.items;

    const cursorAnchor = new Date();
    const safeLimits = [
      expenses.length >= PAGE && expensesPull.lastUpdatedAt
        ? expensesPull.lastUpdatedAt
        : cursorAnchor,
      budgets.length >= PAGE && budgetsPull.lastUpdatedAt
        ? budgetsPull.lastUpdatedAt
        : cursorAnchor,
      exclusions.length >= PAGE && exclusionsPull.lastUpdatedAt
        ? exclusionsPull.lastUpdatedAt
        : cursorAnchor,
    ];
    const nextCursor = new Date(
      Math.min(...safeLimits.map((d) => d.getTime())),
    );

    return {
      cursor: nextCursor.toISOString(),
      hasMore:
        expenses.length >= PAGE ||
        budgets.length >= PAGE ||
        exclusions.length >= PAGE,
      expenses,
      budgets,
      exclusions,
      duplicates: {},
    };
  }
}
