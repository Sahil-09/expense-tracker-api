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

/**
 * Above this many tombstones in one push is a cleared local DB, not a user: a real delete
 * is one or two rows per sync. A wipe that slipped through once stamped `deletedAt` on
 * every stored row and blanked its fields, so the wipe is refused wholesale.
 */
const MAX_TOMBSTONES_PER_PUSH = 20;

const ms = (d?: Date | null) => (d ? d.getTime() : null);

/**
 * Cursor codec.
 *
 * Compound form "ISO|<rowId>" carries the page-boundary row that broke a tie: one bulk
 * import stamps thousands of rows with an identical updatedAt, so a plain date cursor
 * silently drops the remainder of the group once a page splits it. Everything before
 * the '|' is the date the old cursor carried, so a cursor stored by any earlier client
 * — phone or web — decodes exactly as before.
 */
function decodeCursor(cursor?: string | null): { at?: Date; rowId?: string } {
  if (!cursor) return {};
  const [datePart, idPart] = cursor.split('|');
  const at = new Date(datePart);
  if (Number.isNaN(at.getTime())) return {};
  // A client somehow storing the future would match nothing and silently stop every
  // update on that device, so clamp like the old code did.
  const clamped = new Date(Math.min(at.getTime(), Date.now()));
  return idPart && Types.ObjectId.isValid(idPart)
    ? { at: clamped, rowId: idPart }
    : { at: clamped };
}

function encodeCursor(row: { updatedAt: Date; _id: unknown }): string {
  return `${row.updatedAt.toISOString()}|${String(row._id)}`;
}

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

    // Budgets and exclusions page on the plain date; only expenses are numerous enough
    // to need the compound tie-break (see decodeCursor).
    const sinceDate = decodeCursor(req.cursor).at ?? new Date(0);

    const [expensesPull, budgetsPull, exclusionsPull] = await Promise.all([
      this.pullExpenses(userId, req.cursor ?? null, pushed.expenses),
      this.pullBudgets(userId, sinceDate, pushed.budgets),
      this.pullExclusions(userId, sinceDate, pushed.exclusions),
    ]);

    const expenses = expensesPull.items;
    const budgets = budgetsPull.items;
    const exclusions = exclusionsPull.items;

    // Advance the cursor to the earliest incomplete collection boundary. A full page
    // hands back its exact last row (compound, so the next call resumes inside a tie
    // group); a partial page means that collection is drained and the fallback is the
    // anchor above — anything written during this call stays after the cursor.
    const anchorEdge: { at: Date; compound?: string } = { at: cursor };
    const boundaryEdge = expensesPull.boundary
      ? { at: expensesPull.boundary.at, compound: expensesPull.boundary.id }
      : anchorEdge;
    const budgetEdge =
      budgetsPull.items.length >= PAGE && budgetsPull.lastUpdatedAt
        ? { at: budgetsPull.lastUpdatedAt }
        : anchorEdge;
    const exclEdge =
      exclusionsPull.items.length >= PAGE && exclusionsPull.lastUpdatedAt
        ? { at: exclusionsPull.lastUpdatedAt }
        : anchorEdge;
    // The expense boundary is listed first so it wins any exact tie: a tie between the
    // boundary and the anchor means the page broke inside a tie group, and only the
    // compound cursor resumes from the right row.
    const min = [boundaryEdge, budgetEdge, exclEdge, anchorEdge].reduce(
      (m, b) => (b.at.getTime() < m.at.getTime() ? b : m),
    );
    const nextCursor =
      min.compound !== undefined
        ? `${min.at.toISOString()}|${min.compound}`
        : min.at.toISOString();

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
      cursor: nextCursor,
      hasMore:
        expensesPull.count >= PAGE ||
        budgetsPull.items.length >= PAGE ||
        exclusionsPull.items.length >= PAGE,
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

    const tombstoneCount = changes.filter((c) => c.deleted).length;
    const wiping = tombstoneCount > MAX_TOMBSTONES_PER_PUSH;
    if (wiping) {
      this.log.warn(
        `${tombstoneCount} tombstones in one push exceeds ${MAX_TOMBSTONES_PER_PUSH}: ` +
          `looks like a local-data wipe, tombstones refused and stored rows left live`,
      );
    }

    for (const c of changes) {
      if (c.deleted) {
        if (wiping) continue; // refused: stays in the phone's backlog

        // A tombstone only stamps deletedAt. The phone sends blanks for the other
        // fields, and letting them through once overwrote a stored record with
        // amountPaise 0 and empty text — the delete must carry data loss with it.
        ops.push({
          updateOne: {
            filter: { userId, clientId: c.clientId },
            update: { $set: { deletedAt: new Date() } },
            upsert: true,
          },
        });
        written.push(c.clientId);
        continue;
      }

      // Another row already holds this dedupeKey: the same SMS scanned on two phones.
      // Recording the clash lets the phone drop its copy rather than ending up with one
      // expense counted twice — which is exactly what the unique index would otherwise
      // turn into a 500.
      const owner = held.get(c.dedupeKey);
      if (owner !== undefined && owner !== c.clientId) {
        duplicates[c.clientId] = owner;
        continue;
      }
      held.set(c.dedupeKey, c.clientId);

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
              deletedAt: null,
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
          // A delete only stamps deletedAt: a wipe must not blank the budget either.
          $set: c.deleted
            ? { deletedAt: new Date() }
            : { monthlyPaise: c.monthlyPaise, deletedAt: null },
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
        // Same rule as budgets: deletes stamp deletedAt, never erase anything else.
        { $set: c.deleted ? { deletedAt: new Date() } : { deletedAt: null } },
        { upsert: true },
      );
    }
  }

  /**
   * Tombstones included, the caller's own just-pushed rows excluded.
   *
   * The exclusion is what makes a cursor workable: without it a device would receive back
   * everything it just sent on every single sync and rewrite it locally forever.
   *
   * Pagination is keyset on (updatedAt, _id): rows read one bulk import at a time share
   * a single updatedAt stamp, so the date alone cannot resume a page that broke inside
   * the group — the boundary row's id can.
   */
  private async pullExpenses(
    userId: Types.ObjectId,
    cursor: string | null,
    exclude: string[],
  ): Promise<{
    items: ExpenseRow[];
    count: number;
    boundary?: { at: Date; id: string };
  }> {
    const dec = decodeCursor(cursor);
    const cursorFilter = !dec.at
      ? {}
      : dec.rowId
        ? {
            $or: [
              { updatedAt: { $gt: dec.at } },
              {
                updatedAt: dec.at,
                _id: { $gt: new Types.ObjectId(dec.rowId) },
              },
            ],
          }
        : { updatedAt: { $gt: dec.at } };

    const rows = await this.expenses
      .find({
        userId,
        ...cursorFilter,
        ...(exclude.length > 0 ? { clientId: { $nin: exclude } } : {}),
      })
      .sort({ updatedAt: 1, _id: 1 })
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

    const last = rows[rows.length - 1];
    return {
      items,
      count: rows.length,
      ...(last && last.updatedAt
        ? { boundary: { at: last.updatedAt, id: String(last._id) } }
        : {}),
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
    // Taken before the reads, like sync(): a row written during this call must fall
    // after the returned cursor, never inside it.
    const anchor = new Date();
    const sinceDate = decodeCursor(cursor).at ?? new Date(0);

    const [expensesPull, budgetsPull, exclusionsPull] = await Promise.all([
      this.pullExpenses(userId, cursor ?? null, []),
      this.pullBudgets(userId, sinceDate, []),
      this.pullExclusions(userId, sinceDate, []),
    ]);

    const expenses = expensesPull.items;
    const budgets = budgetsPull.items;
    const exclusions = exclusionsPull.items;

    // Identical boundary logic to sync(): a full page resumes from its last row,
    // a drained collection falls back to the anchor.
    const boundaryEdge = expensesPull.boundary
      ? { at: expensesPull.boundary.at, compound: expensesPull.boundary.id }
      : { at: anchor };
    const budgetEdge =
      budgetsPull.items.length >= PAGE && budgetsPull.lastUpdatedAt
        ? { at: budgetsPull.lastUpdatedAt }
        : { at: anchor };
    const exclEdge =
      exclusionsPull.items.length >= PAGE && exclusionsPull.lastUpdatedAt
        ? { at: exclusionsPull.lastUpdatedAt }
        : { at: anchor };
    const edges: { at: Date; compound?: string }[] = [
      boundaryEdge,
      budgetEdge,
      exclEdge,
    ];
    const min = edges.reduce((m, b) =>
      b.at.getTime() < m.at.getTime() ? b : m,
    );
    const nextCursor =
      min.compound !== undefined
        ? `${min.at.toISOString()}|${min.compound}`
        : min.at.toISOString();

    return {
      cursor: nextCursor,
      hasMore:
        expensesPull.count >= PAGE ||
        budgetsPull.items.length >= PAGE ||
        exclusionsPull.items.length >= PAGE,
      expenses,
      budgets,
      exclusions,
      duplicates: {},
    };
  }
}
