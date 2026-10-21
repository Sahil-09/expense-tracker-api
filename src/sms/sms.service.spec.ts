import { Types } from 'mongoose';

import { parseSms } from './parse';
import { SmsService } from './sms.service';

/**
 * Unit tests with tiny model stubs rather than mongodb-memory-server: the service's
 * job is parse → dedupe → insert, and each branch is cheaper to pin here than to seed
 * a database for.
 */
function makeService(
  opts: {
    held?: unknown;
    /**
     * Whole collection counts as excluded (true), one merchant string does ('swiggy'),
     * or nothing does.
     */
    excluded?: boolean | string;
    createError?: Error;
    /**
     * The bulk path's `$in` dedupe lookup reports every key it is asked about as held —
     * "this body was ingested once before".
     */
    everythingHeld?: boolean;
  } = {},
) {
  const create = jest.fn((row?: Record<string, unknown>) =>
    opts.createError ? Promise.reject(opts.createError) : Promise.resolve(row),
  );
  const excludedOf = (q: { merchant?: string }) =>
    opts.excluded === undefined
      ? false
      : opts.excluded === true || q.merchant === opts.excluded;
  const expenses = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve(opts.held ?? null) }),
      }),
    })),
    find: jest.fn((q: { dedupeKey?: { $in?: string[] } }) => ({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve(
              opts.everythingHeld
                ? (q.dedupeKey?.$in ?? []).map((dedupeKey) => ({ dedupeKey }))
                : [],
            ),
        }),
      }),
    })),
    create,
  };
  const exclusions = {
    findOne: jest.fn((q: { merchant?: string }) => ({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve(excludedOf(q) ? { _id: 1 } : null),
        }),
      }),
    })),
  };
  const service = new SmsService(expenses as never, exclusions as never);
  return { service, create, expenses, exclusions };
}

const userId = new Types.ObjectId();
const at = new Date(2026, 9, 19, 12).getTime();

describe('SmsService.ingest', () => {
  it('adds a spend with the fields a phone would have stored', async () => {
    const { service, create } = makeService();
    const out = await service.ingest(userId, {
      body: 'Rs.500 debited at SWIGGY on 19/10/2026 Avl Bal Rs.5000',
      receivedAt: at,
    });

    expect(out.status).toBe('added');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        amountPaise: 50000,
        merchant: 'Swiggy',
        category: 'Food',
        source: 'ios-shortcut',
        isExpense: true,
        isDue: false,
      }),
    );
  });

  it('reports a duplicate when the phone dedupe key is already held', async () => {
    const { service, create } = makeService({ held: { clientId: 'existing' } });
    const out = await service.ingest(userId, {
      body: 'Rs.500 debited at SWIGGY on 19/10/2026',
    });
    expect(out).toEqual({ status: 'duplicate' });
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a duplicate when the unique index wins a race', async () => {
    const { service } = makeService({
      createError: Object.assign(new Error('duplicate'), { code: 11000 }),
    });
    const out = await service.ingest(userId, {
      body: 'Rs.500 debited at SWIGGY on 19/10/2026',
      receivedAt: at,
    });
    expect(out).toEqual({ status: 'duplicate' });
  });

  it('skips a message that is not a spend', async () => {
    const { service, create } = makeService();
    const out = await service.ingest(userId, {
      body: 'Your OTP is 123456. Do not share it with anyone.',
    });
    expect(out).toEqual({ status: 'skipped', reason: 'otp' });
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a transfer out of the totals', async () => {
    const { service, create } = makeService();
    await service.ingest(userId, {
      body: 'Sent Rs.50000 From HDFC Bank A/C *5391 To Suryoday Small Finance Bank on 19/10/2026',
      receivedAt: at,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Transfer', isExpense: false }),
    );
  });

  it('stores a reminder as a due, not a spend', async () => {
    const { service, create } = makeService();
    await service.ingest(userId, {
      body: 'Your payment of INR 149 is due on 21/10/2026',
      receivedAt: at,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ isDue: true, isExpense: false }),
    );
  });

  it('stores a credit as income, never as a spend', async () => {
    const { service, create } = makeService();
    await service.ingest(userId, {
      body: 'Rs.5000.00 credited to A/c X1234 on 19/10/2026',
      receivedAt: at,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ isIncome: true, isExpense: false }),
    );
  });

  it('honours a merchant the user excluded', async () => {
    const { service, create } = makeService({ excluded: true });
    const out = await service.ingest(userId, {
      body: 'Rs.500 debited at SWIGGY on 19/10/2026',
      receivedAt: at,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'not-expense' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('SmsService.ingest — bulk statement SMS', () => {
  // Two transactions in one body, separated the way banks separate them.
  const BULK =
    'Rs.500.00 debited at SWIGGY on 19/10/2026; Rs.250.00 debited at UBER on 19/10/2026';

  it('stores one row per transaction instead of one wrong row', async () => {
    const { service, create } = makeService();
    const out = await service.ingest(userId, { body: BULK, receivedAt: at });
    expect(out.status).toBe('added-multi');
    if (out.status !== 'added-multi') return;
    expect(out.clientIds).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);

    const [first, second] = create.mock.calls.map((c) => c[0] ?? {});

    // Piece 1 keeps the plain key; piece 2 takes the indexed sub-key the phone's
    // parser must adopt when it learns to split.
    expect(first).toMatchObject({
      amountPaise: 50000,
      merchant: 'Swiggy',
      category: 'Food',
      isExpense: true,
    });
    expect(second).toMatchObject({
      amountPaise: 25000,
      merchant: 'UBER',
      category: 'Transport',
    });
    expect(String(first.dedupeKey).endsWith('|2')).toBe(false);
    expect(String(second.dedupeKey).endsWith('|2')).toBe(true);
    expect(String(second.dedupeKey).startsWith(String(first.dedupeKey))).toBe(
      true,
    );
  });

  it('replays a bulk body as duplicate, not a second set of rows', async () => {
    const { service, create } = makeService({ everythingHeld: true });
    const out = await service.ingest(userId, { body: BULK, receivedAt: at });
    expect(out).toEqual({ status: 'duplicate' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps an excluded merchant out of the split but lets the rest in', async () => {
    const { service, create } = makeService({ excluded: 'swiggy' });
    const out = await service.ingest(userId, { body: BULK, receivedAt: at });
    expect(out.status).toBe('added-multi');
    if (out.status !== 'added-multi') return;
    expect(out.clientIds).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const [only] = create.mock.calls.map((c) => c[0] ?? {});
    expect(only).toMatchObject({
      amountPaise: 25000,
      merchant: 'UBER',
    });
  });
});

describe('parseSms (server copy)', () => {
  it('uses the in-body date when no receivedAt is given', () => {
    const out = parseSms('Rs.320 debited at UBER on 19/10/2026', null);
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.parsed.txnAt).toBe(new Date(2026, 9, 19, 12).getTime());
  });

  it('reads a credit as income', () => {
    const out = parseSms('Rs.500 credited to your account', at);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.parsed.kind).toBe('income');
  });

  // Verbatim from the app's parse.test.ts, ported so the server copy of the parser can
  // never drift back from the phone's rules again. Canara writes the debit as "Dr." and
  // the credit as "Cr." with the amount after the shorthand.
  const CANARA_DR =
    '[AD-CANBNK-S] Dear Customer, Acct XXXX9649 Dr. INR 1,680.00 on 11/10/26 to Famous Chick; ' +
    'UPI: 131090294863; Bal INR 1,86,417.20.Not you?SMS BLOCKUPI to 9901771222-CanaraBank';

  it('reads the Canara "Dr." debit and the merchant behind the semicolon', () => {
    const out = parseSms(CANARA_DR, at);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.amountPaise).toBe(168000);
    expect(out.parsed.direction).toBe('debit');
    expect(out.parsed.merchant).toBe('Famous Chick');
    expect(out.parsed.kind).toBe('spend');
  });

  it('reads a Canara credit as income, not a spend', () => {
    const out = parseSms(
      'Dear Customer, Acct XXXX9649 Cr. INR 500.00 on 11/10/26 from Rahul Sharma; UPI: 131090294863',
      at,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.parsed.kind).toBe('income');
      expect(out.parsed.direction).toBe('credit');
    }
  });

  it('does not read a doctor as a debit', () => {
    // "Dr." is also a title, and only "Dr." followed by an amount is a bank debit.
    expect(parseSms("Dr. Smith's clinic confirmed for 11/10/2026", at)).toEqual(
      {
        ok: false,
        reason: 'no-direction',
      },
    );
  });
});
