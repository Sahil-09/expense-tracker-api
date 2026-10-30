import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { SafeLogger } from '../logging/safe-logger';
import { Exclusion, ExclusionDocument } from '../sync/exclusion.schema';
import { Expense, ExpenseDocument } from '../sync/expense.schema';
import { SmsLog, SmsLogDocument } from './sms-log.schema';
import {
  bulkRows,
  categoryFor,
  dedupeKey,
  merchantExcluded,
  mintMissingRows,
} from './bulk';
import { SmsRequest, SmsResponse, PieceOutcome } from './dto';
import { extractTransactions, PieceTxn } from './parse';

@Injectable()
export class SmsService {
  private readonly log = new SafeLogger(SmsService.name);

  async logSms(
    userId: Types.ObjectId,
    body: string,
    response: unknown,
    error?: string,
  ): Promise<void> {
    await this.smsLogs.create({
      userId,
      body,
      response,
      error,
    });
  }

  constructor(
    @InjectModel(Expense.name)
    private readonly expenses: Model<ExpenseDocument>,
    @InjectModel(Exclusion.name)
    private readonly exclusions: Model<ExclusionDocument>,
    @InjectModel(SmsLog.name)
    private readonly smsLogs: Model<SmsLogDocument>,
  ) {}

  /**
   * Turns one raw SMS into an expense — or, for a statement-style message carrying
   * several transactions, into one expense each.
   *
   * The user id always comes from the access token, never the request body: a Shortcut
   * holds one token and must not be able to write into another account.
   */
  async ingest(userId: Types.ObjectId, req: SmsRequest): Promise<SmsResponse> {
    let result: SmsResponse | undefined;
    let error: string | undefined;
    try {
      result = await this.ingestInternal(userId, req);
      return result;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      try {
        await this.logSms(userId, req.body, result ?? {}, error);
      } catch {
        // Logging failure must not suppress the SMS result or error.
      }
    }
  }

  private async ingestInternal(userId: Types.ObjectId, req: SmsRequest): Promise<SmsResponse> {
    const anchor = req.receivedAt ?? Date.now();
    const batch = extractTransactions(req.body, req.receivedAt ?? null, anchor);

    // One piece per parsed transaction; skipped / duplicate outcomes carry reasons.
    if (!batch.ok) {
      this.log.log(`skipped (${batch.reason}), ${req.body.length} chars`);
      return {
        status: 'skipped',
        reason: batch.reason,
        pieces: [{ index: 0, outcome: 'skipped', reason: batch.reason }],
      };
    }
    if (batch.txns.length > 1)
      return this.ingestBulk(userId, req.body, batch.txns);

    const { amountPaise, merchant, txnAt, kind } = batch.txns[0];
    const key = dedupeKey(req.body, txnAt);

    const held = await this.expenses
      .findOne({ userId, dedupeKey: key, deletedAt: null })
      .select('clientId')
      .lean()
      .exec();
    if (held) {
      return {
        status: 'duplicate',
        pieces: [
          { index: 0, outcome: 'duplicate' },
          ...(() => {
            // where else? top-level parse failed scenarios expand pieces from 0
            return [];
          })(),
        ],
      };
    }

    if (
      kind !== 'income' &&
      merchant &&
      (await merchantExcluded(this.exclusions, userId, merchant))
    ) {
      this.log.log('skipped (not-expense), merchant flagged');
      return {
        status: 'skipped',
        reason: 'not-expense',
        pieces: [{ index: 0, outcome: 'skipped', reason: 'not-expense' }],
      };
    }

    const clientId = randomUUID();
    try {
      await this.expenses.create({
        userId,
        clientId,
        amountPaise,
        merchant: merchant ?? null,
        category: categoryFor(kind, merchant, req.body),
        txnAt: new Date(txnAt),
        note: null,
        rawSms: req.body,
        dedupeKey: key,
        source: 'ios-shortcut',
        isExpense: kind === 'spend',
        isDue: kind === 'due',
        isIncome: kind === 'income',
        deletedAt: null,
      });
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        (e as { code?: number }).code === 11000
      ) {
        return { status: 'duplicate', pieces: [{ index: 0, outcome: 'duplicate' }] };
      }
      throw e;
    }

    this.log.log(`added ${clientId} (${kind}), ${amountPaise} paise`);
    return {
      status: 'added',
      clientId,
      pieces: [{ index: 0, outcome: 'added', clientId }],
    };
  }

  /**
   * A bulk statement SMS becomes one row per transaction. Piece 1 keeps the plain
   * (body, day) dedupe key — an old phone's single-row scan of the same message
   * collapses into it — and pieces 2..n take the indexed sub-key. Excluded merchants
   * are reported as skipped rather than dropped, so every piece shows its outcome.
   */
  private async ingestBulk(
    userId: Types.ObjectId,
    body: string,
    txns: PieceTxn[],
  ): Promise<SmsResponse> {
    const rows = await bulkRows(
      this.exclusions,
      userId,
      body,
      txns,
      'ios-shortcut',
    );
    const fresh = await mintMissingRows(this.expenses, userId, rows);

    // Build a lookup from dedupeKey to result for included pieces.
    const resultByDedupe = new Map<string, { created: boolean; clientId: string }>();
    for (const d of fresh.details) {
      resultByDedupe.set(d.dedupeKey, { created: d.created, clientId: d.clientId });
    }

    const pieces: PieceOutcome[] = [];
    const createdIds: string[] = [];

    // Included pieces: match by clientId / dedupeKey order preserved by mint details.
    for (const row of rows) {
      const res = resultByDedupe.get(row.dedupeKey);
      const outcome = res && res.created ? 'added' : 'duplicate';
      const clientId = row.clientId; // present regardless
      pieces.push({ index: pieces.length + 1, outcome, ...(res && res.created ? { clientId } : {}) });
      if (res && res.created) createdIds.push(clientId);
    }

    // Excluded pieces: anything in txns whose text isn't represented in rows.
    const includedTexts = new Set(rows.map((r) => r.rawSms.trim()));
    let excludedIndex = 0; // index starts at 1 for each excluded text in order
    for (const t of txns) {
      if (!includedTexts.has(t.text.trim())) {
        excludedIndex++;
        pieces.push({ index: rows.length + excludedIndex, outcome: 'skipped', reason: 'not-expense' });
      }
    }

    const createdCount = fresh.created;
    const anyAdded = createdCount > 0;
    const allDuplicates = createdCount === 0 && rows.length > 0;
    if (allDuplicates && fresh.details.every((d) => !d.created)) {
      return { status: 'duplicate', pieces };
    }
    if (anyAdded) {
      return { status: 'added-multi', clientIds: createdIds, pieces };
    }
    return { status: 'duplicate', pieces };
  }
}
