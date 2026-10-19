import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { SafeLogger } from '../logging/safe-logger';
import { Exclusion, ExclusionDocument } from '../sync/exclusion.schema';
import { Expense, ExpenseDocument } from '../sync/expense.schema';
import { categorize } from './categories';
import { SmsRequest, SmsResponse } from './dto';
import { parseSms } from './parse';

/** Same normalisation as the phone's `exclusionKey`. Both sides must agree. */
const exclusionKey = (merchant: string) =>
  merchant.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Matches the phone's `dedupeKey` exactly: normalised body plus the day the expense
 * landed on. A server-ingested SMS and a later device re-scan therefore collapse into
 * one row instead of two.
 */
const dedupeKey = (body: string, at: number) =>
  `${body.replace(/\s+/g, ' ').trim().toLowerCase()}|${new Date(at).toDateString()}`;

@Injectable()
export class SmsService {
  private readonly log = new SafeLogger(SmsService.name);

  constructor(
    @InjectModel(Expense.name)
    private readonly expenses: Model<ExpenseDocument>,
    @InjectModel(Exclusion.name)
    private readonly exclusions: Model<ExclusionDocument>,
  ) {}

  /**
   * Turns one raw SMS into an expense, or explains why it is not one.
   *
   * The user id always comes from the access token, never the request body: a Shortcut
   * holds one token and must not be able to write into another account.
   */
  async ingest(userId: Types.ObjectId, req: SmsRequest): Promise<SmsResponse> {
    const parsed = parseSms(req.body, req.receivedAt ?? null);
    if (!parsed.ok) {
      this.log.log(`skipped (${parsed.reason}), ${req.body.length} chars`);
      return { status: 'skipped', reason: parsed.reason };
    }

    const { amountPaise, merchant, txnAt, kind } = parsed.parsed;
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
      (await this.isExcluded(userId, merchant))
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
        // A transfer is never a spend, and naming it beats the merchant scrape, which
        // reads "Suryoday Small Finance Ba" and cannot match a category rule.
        category:
          kind === 'transfer' ? 'Transfer' : categorize(merchant ?? req.body),
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

  private async isExcluded(
    userId: Types.ObjectId,
    merchant: string,
  ): Promise<boolean> {
    const row = await this.exclusions
      .findOne({ userId, merchant: exclusionKey(merchant), deletedAt: null })
      .select('_id')
      .lean()
      .exec();
    return row !== null;
  }
}
