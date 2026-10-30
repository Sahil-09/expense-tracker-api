import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { ExpenseChange } from '../sync/dto';
import { ExclusionDocument } from '../sync/exclusion.schema';
import { ExpenseDocument } from '../sync/expense.schema';
import { categorize } from './categories';
import { extractTransactions, Parsed, PieceTxn } from './parse';

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
 * Every piece is keyed on its OWN text — the same key a standalone row of that message
 * carries — so a message already stored collapses into that row by the unique index
 * instead of being minted twice. The `|n` suffix exists only when one block contains the
 * identical message more than once: there the two pieces would draw the same key, and
 * the suffix (the piece's 1-based position) keeps the index unique between them.
 *
 * shortcut: this keying is a cross-repo contract. The phone's copy of parse.ts must mint
 * identical keys when it learns to split, or a re-scan of a pasted block double-counts.
 */
export const subDedupeKey = (pieceText: string, at: number, n: number) =>
  `${dedupeKey(pieceText, at)}|${n}`;

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
  /** Not a schema field: Mongoose strips it on create; the repair script reads it. */
  txnExact?: boolean;
};

/**
 * Maps the parsed transactions of one body to rows. Every piece is keyed on its own
 * text (piece 1 plain, later ones with the `|n` index), so each carries the key a
 * standalone row of the same message carries and old rows collapse by the unique index.
 * Excluded merchants and income are per piece, same rule as a single-transaction ingest.
 */
export async function bulkRows(
  exclusions: Model<ExclusionDocument>,
  userId: Types.ObjectId,
  body: string,
  txns: PieceTxn[],
  source: string,
  firstIndex = 0,
): Promise<PieceRow[]> {
  const rows: PieceRow[] = [];
  // How often each piece text appears in the block: a repeated identical message draws
  // the same key twice, and only there the position is appended to the key.
  const seen = new Map<string, number>();
  for (const t of txns) {
    const base = dedupeKey(t.text, t.txnAt);
    seen.set(base, (seen.get(base) ?? 0) + 1);
  }
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];
    const base = dedupeKey(t.text, t.txnAt);
    const key =
      firstIndex + i === 0
        ? base
        : seen.get(base)! > 1
          ? subDedupeKey(t.text, t.txnAt, firstIndex + i + 1)
          : base;
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
      category: categoryFor(t.kind, t.merchant, t.text),
      txnAt: new Date(t.txnAt),
      note: null,
      // The row is one transaction, so its SMS is the piece's own text — not the whole
      // block, which would re-read as a bulk body on every later parse.
      rawSms: t.text,
      source,
      isExpense: t.kind === 'spend',
      isDue: t.kind === 'due',
      isIncome: t.kind === 'income',
      deletedAt: null,
      dedupeKey: key,
      txnExact: t.txnExact === true ? true : undefined,
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
): Promise<{ created: number; details: { dedupeKey: string; clientId: string; created: boolean }[] }> {
  if (pieces.length === 0) return { created: 0, details: [] };
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
  const details: { dedupeKey: string; clientId: string; created: boolean }[] = [];
  for (const piece of pieces) {
    const wasHeld = held.has(piece.dedupeKey);
    if (wasHeld) {
      details.push({ dedupeKey: piece.dedupeKey, clientId: piece.clientId, created: false });
      continue;
    }
    try {
      await expenses.create(piece);
      created++;
      details.push({ dedupeKey: piece.dedupeKey, clientId: piece.clientId, created: true });
    } catch (e) {
      if (
        typeof e !== 'object' ||
        e === null ||
        (e as { code?: number }).code !== 11000
      )
        throw e;
      details.push({ dedupeKey: piece.dedupeKey, clientId: piece.clientId, created: false });
    }
  }
  return { created, details };
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
 * A pasted block pushed by an old phone can carry txnAt = epoch 0 — its dedupe key ends
 * "|Thu Jan 01 1970". A repair may fix such a hopeless date from the message text, but
 * never a real one: moving a genuine timestamp would rewrite history by day.
 */
export const txnHopeless = (stored: Date | number): boolean =>
  new Date(stored).getTime() < 946684800000;

const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/**
 * When a repair may rewrite a stored txnAt: it is hopeless (epoch 0), or the new value
 * comes from a full body timestamp (BOB's bracket time) and only moves WITHIN the stored
 * day — same-day moves cannot change a dedupe key or a cursor day. Never crosses days,
 * and never rewrites an equal value, so a mend stays idempotent.
 */
export const txnAtFixable = (
  stored: Date | number,
  want: number,
  wantExact: boolean,
): boolean => {
  const s = new Date(stored).getTime();
  return s !== want && (txnHopeless(s) || (wantExact && sameDay(s, want)));
};

/**
 * Bulk-SMS repair for rows arriving through a /sync push.
 *
 * A phone carrying the older single-transaction parser pushes each statement-style SMS as
 * rows, rewrites piece 1's parsed fields on the pushed change (the upsert then writes
 * them), and mints the missing pieces 2..n. dedupeKey of the pushed row is never touched
 * — it is the phone's dedupe contract, and leaving it makes the repair identical on every
 * re-push, so it cannot churn other devices' pulls. txnAt is left alone too except when
 * it is hopeless (epoch 0 from an old push) — the message text knows the real day.
 */
export async function reconcilePushedBulk(
  expenses: Model<ExpenseDocument>,
  exclusions: Model<ExclusionDocument>,
  userId: Types.ObjectId,
  changes: ExpenseChange[],
): Promise<void> {
  const bulk: { c: ExpenseChange; txns: PieceTxn[] }[] = [];
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
    .select(
      'clientId amountPaise merchant category isExpense isDue isIncome txnAt',
    )
    .lean()
    .exec();
  const byId = new Map(stored.map((r) => [r.clientId, r]));

  for (const { c, txns } of bulk) {
    const want = fieldsOf(txns[0], c.rawSms);
    const row = byId.get(c.clientId);
    // The one allowed txnAt correction: an epoch-0 date is an old push's bug, and the
    // message text knows the truth; a same-day body-stamped time is a truer minute of
    // the same day. A real date is never moved across days.
    if (
      row &&
      txnAtFixable(row.txnAt, txns[0].txnAt, txns[0].txnExact === true)
    )
      c.txnAt = txns[0].txnAt;
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
