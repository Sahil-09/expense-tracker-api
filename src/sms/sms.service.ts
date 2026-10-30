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
import { SmsRequest, SmsResponse } from './dto';
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
    // The arrival is the only evidence of which half of the day a meridiem-less bank
    // stamp meant. The Shortcut fires as the SMS lands, so the server clock serves when
    // the payload carries no timestamp of its own.
    const anchor = req.receivedAt ?? Date.now();
    const batch = extractTransactions(req.body, req.receivedAt ?? null, anchor);
    if (!batch.ok) {
      this.log.log(`skipped (${batch.reason}), ${req.body.length} chars`);
      return { status: 'skipped', reason: batch.reason };
    }
    if (batch.txns.length > 1)
      return this.ingestBulk(userId, req.body, batch.txns);

    const { amountPaise, merchant, txnAt, kind } = batch.txns[0];
    const key = dedupeKey(req.body, txnAt);

    // Checked before the insert so the common case is a cheap read. The unique partial
    // index still backstops a race; see the catch below.
    const held = await this.expenses
      .findOne({ userId, dedupeKey: key, deletedAt: null })
      .select('clientId')
      .lean()
      .exec();
    if (held) return { status: 'duplicate' };

    // A payment the user once flagged as personal must never come back as a spend. Income
    // is exempt: that verdict was about spending, and applying it to a refund would hide
    // money coming back in.
    if (
      kind !== 'income' &&
      merchant &&
      (await merchantExcluded(this.exclusions, userId, merchant))
    ) {
      return { status: 'skipped', reason: 'not-expense' };
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
      // Two Shortcut runs (or a phone scan) can race past the read above. The unique
      // partial index settles it; report the loser as a duplicate rather than a 500.
      if (
        typeof e === 'object' &&
        e !== null &&
        (e as { code?: number }).code === 11000
      ) {
        return { status: 'duplicate' };
      }
      throw e;
    }

    this.log.log(`added ${clientId} (${kind}), ${amountPaise} paise`);
    return { status: 'added', clientId };
  }

  /**
   * A bulk statement SMS becomes one row per transaction. Piece 1 keeps the plain
   * (body, day) dedupe key — an old phone's single-row scan of the same message
   * collapses into it — and pieces 2..n take the indexed sub-key.
   */
  private async ingestBulk(
    userId: Types.ObjectId,
    body: string,
    txns: PieceTxn[],
  ): Promise<SmsResponse> {
    const pieces = await bulkRows(
      this.exclusions,
      userId,
      body,
      txns,
      'ios-shortcut',
    );
    const created = await mintMissingRows(this.expenses, userId, pieces);
    if (created === 0) return { status: 'duplicate' };
    this.log.log(`bulk ${body.length} chars -> ${created} rows`);
    return { status: 'added-multi', clientIds: pieces.map((p) => p.clientId) };
  }
}
