import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { ExpenseChange } from '../sync/dto';
import { ExclusionDocument } from '../sync/exclusion.schema';
import { ExpenseDocument } from '../sync/expense.schema';
import { categorize } from './categories';
import { extractTransactions, Parsed } from './parse';

/** Same normalisation as the phone's `exclusionKey`. Both sides must agree. */
export const exclusionKey = (merchant: string) =>
  merchant.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Matches the phone's `dedupeKey` exactly: normalised body plus the day the expense
 * landed on. A server-ingested SMS and a later device re-scan therefore collapse into
 * one row instead of two.
 */
export const dedupeKey = (body: string, at: number) =>
  `${body.replace(/\s+/g, ' ').trim().toLowerCase()}|${new Date(at).toDateString()}`;

/**
 * Pieces 2..n of one bulk SMS need keys of their own — they are the same body and day as
 * piece 1, so the plain key would collide on the unique index.
 *
 * shortcut: the `|n` suffix and the index order (parse order, 1-based) are a cross-repo
 * contract. The phone's copy of parse.ts must mint identical keys when it learns to
 * split, or a re-scan of a split body double-counts.
 */
export const subDedupeKey = (body: string, at: number, n: number) =>
  `${dedupeKey(body, at)}|${n}`;

/** Same call the ingest path makes today: a transfer is named over the merchant scrape. */
export const categoryFor = (
  kind: string,
  merchant: string | null,
  body: string,
) => (kind === 'transfer' ? 'Transfer' : categorize(merchant ?? body));

export async function merchantExcluded(
  exclusions: Model<ExclusionDocument>,
  userId: Types.ObjectId,
  merchant: string,
): Promise<boolean> {
  const row = await exclusions
    .findOne({
      userId,
      merchant: exclusionKey(merchant),
      deletedAt: null,
    })
    .select('_id')
    .lean()
    .exec();
  return row !== null;
}

/** A create() payload for one transaction of a bulk SMS. */
export type PieceRow = {
  userId: Types.ObjectId;
  clientId: string;
  amountPaise: number;
  merchant: string | null;
  category: string;
  txnAt: Date;
  note: string | null;
  rawSms: string;
  dedupeKey: string;
  source: string;
  isExpense: boolean;
  isDue: boolean;
  isIncome: boolean;
  deletedAt: null;
};

/**
 * Maps the parsed transactions of one body to rows. The first piece (`firstIndex`-based
 * position in the whole body) keeps the plain (body, day) key so an old phone's
 * single-row scan still collapses into it; later pieces take the indexed sub-key.
 * Excluded merchants and income are per piece, same rule as a single-transaction ingest.
 */
export async function bulkRows(
  exclusions: Model<ExclusionDocument>,
  userId: Types.ObjectId,
  body: string,
  txns: Parsed[],
  source: string,
  firstIndex = 0,
): Promise<PieceRow[]> {
  const rows: PieceRow[] = [];
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];
    const key =
      firstIndex + i === 0
        ? dedupeKey(body, t.txnAt)
        : subDedupeKey(body, t.txnAt, firstIndex + i + 1);
    if (
      t.kind !== 'income' &&
      t.merchant &&
      (await merchantExcluded(exclusions, userId, t.merchant))
    )
      continue;
    rows.push({
      userId,
      clientId: randomUUID(),
      amountPaise: t.amountPaise,
      merchant: t.merchant ?? null,
      category: categoryFor(t.kind, t.merchant, body),
      txnAt: new Date(t.txnAt),
      note: null,
      rawSms: body,
      source,
      isExpense: t.kind === 'spend',
      isDue: t.kind === 'due',
      isIncome: t.kind === 'income',
      deletedAt: null,
      dedupeKey: key,
    });
  }
  return rows;
}

/**
 * Writes the pieces the account does not hold yet. The unique partial index backstops a
 * race; the loser is counted as already held rather than failing the batch.
 */
export async function mintMissingRows(
  expenses: Model<ExpenseDocument>,
  userId: Types.ObjectId,
  pieces: PieceRow[],
): Promise<number> {
  if (pieces.length === 0) return 0;
  const held = new Set(
    (
      await expenses
        .find({ userId, dedupeKey: { $in: pieces.map((p) => p.dedupeKey) } })
        .select('dedupeKey')
        .lean()
        .exec()
    ).map((r) => r.dedupeKey),
  );

  let created = 0;
  for (const piece of pieces) {
    if (held.has(piece.dedupeKey)) continue;
    try {
      await expenses.create(piece);
      created++;
    } catch (e) {
      if (
        typeof e !== 'object' ||
        e === null ||
        (e as { code?: number }).code !== 11000
      )
        throw e;
    }
  }
  return created;
}

/** The stored fields a piece-1 repair may overwrite, one row of the reconcile below. */
export type Piece1Fix = Pick<
  ExpenseChange,
  'amountPaise' | 'merchant' | 'category' | 'isExpense' | 'isDue' | 'isIncome'
>;

export const fieldsOf = (t: Parsed, body: string): Piece1Fix => ({
  amountPaise: t.amountPaise,
  merchant: t.merchant ?? null,
  category: categoryFor(t.kind, t.merchant, body),
  isExpense: t.kind === 'spend',
  isDue: t.kind === 'due',
  isIncome: t.kind === 'income',
});

export type StoredFields = {
  clientId: string;
  amountPaise: number;
  merchant: string | null;
  category: string;
  isExpense: boolean;
  isDue: boolean;
  isIncome: boolean;
};

export const drifts = (stored: StoredFields, want: Piece1Fix): boolean =>
  stored.amountPaise !== want.amountPaise ||
  stored.merchant !== want.merchant ||
  stored.category !== want.category ||
  stored.isExpense !== want.isExpense ||
  stored.isDue !== want.isDue ||
  stored.isIncome !== want.isIncome;

/**
 * Bulk-SMS repair for rows arriving through a /sync push.
 *
 * A phone carrying the older single-transaction parser pushes each statement-style SMS as
 * one wrong row. This re-reads every rawSms, rewrites piece 1's parsed fields on the pushed
 * change (the upsert then writes them), and mints the missing pieces 2..n. dedupeKey and
 * txnAt of the pushed row are never touched — they are the phone's dedupe contract and the
 * cursor's day, and leaving them makes the repair identical on every re-push, so it cannot
 * churn other devices' pulls.
 */
export async function reconcilePushedBulk(
  expenses: Model<ExpenseDocument>,
  exclusions: Model<ExclusionDocument>,
  userId: Types.ObjectId,
  changes: ExpenseChange[],
): Promise<void> {
  const bulk: { c: ExpenseChange; txns: Parsed[] }[] = [];
  for (const c of changes) {
    if (c.deleted || c.rawSms.trim() === '') continue;
    const m = extractTransactions(c.rawSms, c.txnAt);
    if (m.ok && m.txns.length > 1) bulk.push({ c, txns: m.txns });
  }

  if (bulk.length === 0) return;

  // One read for every bulk-looking change. A row the account has never seen still gets
  // the piece-1 fields — that is the first push of a backlog row from a phone running the
  // old parser, and the only chance to fix it before the phone stores its own copy.
  const stored = await expenses
    .find({ userId, clientId: { $in: bulk.map((b) => b.c.clientId) } })
    .select('clientId amountPaise merchant category isExpense isDue isIncome')
    .lean()
    .exec();
  const byId = new Map(stored.map((r) => [r.clientId, r]));

  for (const { c, txns } of bulk) {
    const want = fieldsOf(txns[0], c.rawSms);
    const row = byId.get(c.clientId);
    if (!row) {
      Object.assign(c, want);
      continue;
    }
    // A live row always has these fields required by the schema; lean() types them loose.
    if (
      drifts(
        {
          clientId: row.clientId,
          amountPaise: row.amountPaise,
          merchant: row.merchant ?? null,
          category: row.category,
          isExpense: row.isExpense,
          isDue: row.isDue,
          isIncome: row.isIncome ?? false,
        },
        want,
      )
    ) {
      Object.assign(c, want);
      // Bump nothing: the re-push below already writes the mended values and the server
      // stamps updatedAt on it, so other devices pick the repair up on the next pull.
    }
  }

  await Promise.all(
    bulk.map(async ({ c, txns }) => {
      const pieces = await bulkRows(
        exclusions,
        userId,
        c.rawSms,
        txns.slice(1),
        c.source,
        1,
      );
      await mintMissingRows(expenses, userId, pieces);
    }),
  );
}
