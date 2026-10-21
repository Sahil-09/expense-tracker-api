/**
 * One-off repair for stored rows that came from a bulk/statement SMS. Run:
 *
 *   pnpm exec ts-node src/sms/repair-bulk.ts --email you@example.com [--apply]
 *
 * Dry-run by default: it reports how many rows the current parser would fix without
 * writing anything. `--apply` performs the fix in place. Idempotent — a second run finds
 * nothing — because a mend computes its own values from the stored `rawSms` and the same
 * parser rules every time.
 *
 * The philosophy is the app's `reclassifyPending()`: a repair only ever moves a row OUT
 * of being a spend (into due / transfer / income beside the split), never back in, so a
 * row the user cleared by hand stays cleared — those rows are not touched at all.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AppModule } from '../app.module';
import { Exclusion, ExclusionDocument } from '../sync/exclusion.schema';
import { Expense, ExpenseDocument } from '../sync/expense.schema';
import { User } from '../users/user.schema';
import { bulkRows, fieldsOf, type StoredFields, drifts } from './bulk';
import { extractTransactions } from './parse';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function main() {
  const email = arg('email');
  const apply = process.argv.includes('--apply');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const expenses = app.get<Model<ExpenseDocument>>(getModelToken(Expense.name));
  const exclusions = app.get<Model<ExclusionDocument>>(
    getModelToken(Exclusion.name),
  );

  try {
    const user = await app
      .get<Model<{ _id: unknown; email: string }>>(getModelToken(User.name))
      .findOne({ email })
      .select('_id')
      .lean()
      .exec();
    if (!user?._id) throw new Error(`No account for ${email}`);
    const userId = user._id as unknown as Types.ObjectId;

    // isExpense: false rows are the user's hand or already-out-of-totals rows; leave both.
    const rows = await expenses.find({ userId, deletedAt: null }).lean().exec();

    let scanned = 0;
    let bulkMessages = 0;
    let mendedRow1 = 0;
    let missingPieces = 0;

    for (const row of rows) {
      if (!row.rawSms || row.rawSms.trim() === '') continue;
      const m = extractTransactions(row.rawSms, row.txnAt.getTime());
      scanned++;
      if (!m.ok || m.txns.length < 2) continue;
      bulkMessages++;

      const want = fieldsOf(m.txns[0], row.rawSms);
      const stored: StoredFields = {
        clientId: row.clientId,
        amountPaise: row.amountPaise,
        merchant: row.merchant ?? null,
        category: row.category,
        isExpense: row.isExpense,
        isDue: row.isDue,
        isIncome: row.isIncome,
      };
      if (row.isExpense && drifts(stored, want)) {
        mendedRow1++;
        if (apply) await expenses.updateOne({ _id: row._id }, { $set: want });
      }

      // Pieces 2..n mint on the same sub-key scheme ingestion uses, so a later re-scan
      // and this script cannot disagree about what already exists.
      const slices = await bulkRows(
        exclusions,
        userId,
        row.rawSms,
        m.txns.slice(1),
        row.source,
        1,
      );
      if (slices.length === 0) continue;
      const held = new Set(
        (
          await expenses
            .find({
              userId,
              dedupeKey: { $in: slices.map((p) => p.dedupeKey) },
            })
            .select('dedupeKey')
            .lean()
            .exec()
        ).map((r) => r.dedupeKey),
      );
      for (const piece of slices) {
        if (held.has(piece.dedupeKey)) continue;
        missingPieces++;
        if (apply) {
          try {
            await expenses.create(piece);
          } catch (e) {
            // Another device or a second run owns the piece; not an error.
            if (
              typeof e === 'object' &&
              e !== null &&
              (e as { code?: number }).code === 11000
            )
              continue;
            throw e;
          }
        }
      }
    }

    // rawSms is never printed — counts only, as everywhere in this codebase.
    console.log(
      `${scanned} row(s) re-parsed, ${bulkMessages} bulk message(s): ` +
        `${mendedRow1} drifted row(s), ${missingPieces} missing piece(s).` +
        (apply ? ' Written.' : ' Dry run — pass --apply to write.'),
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
