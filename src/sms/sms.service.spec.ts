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

    // Each piece carries the key a standalone message of its text would — piece 2's key
    // is plain piece text, not an indexed sub-key the index would refuse to collapse.
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
    expect(String(second.dedupeKey).endsWith('|2')).toBe(false);
    // Piece keys are built from the piece's own text now, not the whole body.
    expect(String(first.dedupeKey)).toContain('swiggy');
    expect(String(second.dedupeKey)).toContain('uber on 19/10/2026');
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
    const [only] = create.mock.calls.map((c) => c[0] ?? {});
    expect(only).toMatchObject({
      amountPaise: 25000,
      merchant: 'UBER',
    });
  });

  // Verbatim from the user's inbox: a Shortcut run once pasted EIGHT separate BOB
  // messages into one body, run together with no separator at all — that is how the
  // current live rows ended up holding one amount for a whole block.
  const PASTED_BLOCK = [
    'Rs.69.00 Dr. from A/C XXXXXX0674 and Cr. to amzn-ds2pfucrpz4@apl. Ref:499438792179. AvlBal:Rs4303.95(2026:10:21 10:14:57). Not you? Call 18005700/5000-BOB',
    'Rs.4.85 Dr. from A/C XXXXXX0674 and Cr. to bdpg.iruts@sbi. Ref:772720502456. AvlBal:Rs4372.95(2026:10:21 09:44:47). Not you? Call 18005700/5000-BOB',
    'Rs.1000.00 Dr. from A/C XXXXXX0674 and Cr. to 8828924662@ibl. Ref:842857565217. AvlBal:Rs3861.13(2025:07:20 12:58:47). Not you? Call 18005700/5000-BOB',
    'Rs.5.00 Dr. from A/C XXXXXX0674 and Cr. to irctctourism1paytm@hdfcbank. Ref:101884042531. AvlBal:Rs2028.40(2025:11:04 05:47:00). Not you? Call 18005700/5000-BOB',
    'Rs.300.00 Dr. from A/C XXXXXX0674 and Cr. to kshoaib783-2@oksbi. Ref:958400636271. AvlBal:Rs2036.40(2025:11:05 07:59:21). Not you? Call 18005700/5000-BOB',
    'Rs.20.00 Dr. from A/C XXXXXX0674 and Cr. to mahadiksimran8@okhdfcbank. Ref:675218450238. AvlBal:Rs118.13(2025:08:01 09:02:43). Not you? Call 18005700/5000-BOB',
    'Rs.1.00 Dr. from A/C XXXXXX0674 and Cr. to vilposmum@ptybl. Ref:567607935042. AvlBal:Rs1306.40(2025:11:06 02:41:14). Not you? Call 18005700/5000-BOB',
    'Rs.20.00 Dr. from A/C XXXXXX0674 and Cr. to Q867016778@ybl. Ref:144949896915. AvlBal:Rs138.13(2025:07:31 09:48:20). Not you? Call 18005700/5000-BOB',
  ].join(' ');

  it('stores one row per message of a pasted block with no separator', async () => {
    const { service, create } = makeService();
    const out = await service.ingest(userId, {
      body: PASTED_BLOCK,
      receivedAt: at,
    });
    expect(out.status).toBe('added-multi');
    if (out.status !== 'added-multi') return;
    expect(out.clientIds).toHaveLength(8);
    expect(create).toHaveBeenCalledTimes(8);

    const calls = create.mock.calls.map((c) => c[0] ?? {});
    // Piece keys carry the piece's own text, so piece 2 of the block lands on the same
    // key a standalone scan of that message mints — the unique index does the dedupe.
    const bdpg = calls.find((r) => r.amountPaise === 485);
    expect(String(bdpg?.dedupeKey)).toContain(
      'rs.4.85 dr. from a/c xxxxxx0674 and cr. to bdpg.iruts@sbi',
    );
    expect(String(bdpg?.dedupeKey)).toContain(
      'bdpg.iruts@sbi. ref:772720502456',
    );
    // The 4.85 message appears once in the block, so its key is the plain piece key —
    // the same one a standalone scan of that message mints and the index collapses on.
    expect(String(bdpg?.dedupeKey).endsWith('|2')).toBe(false);
    // The piece's own in-body date beats the receive-time anchor, or its key day could
    // never collapse into a standalone row scanned with the real day.
    expect(bdpg?.txnAt instanceof Date && bdpg.txnAt.getTime()).toBe(
      new Date(2026, 9, 21, 9, 44, 47).getTime(),
    );
  });

  it('a message the account holds standalone is refused by the index, not doubled', async () => {
    // The unique-index winner: minting a piece that already exists as a row throws
    // code 11000, and the piece is counted held instead of failing the batch. This is
    // the exact behaviour the pasted-block repair relies on.
    const dup = Object.assign(new Error('dup'), { code: 11000 });
    const { service, create } = makeService({ createError: dup });
    const out = await service.ingest(userId, {
      body: PASTED_BLOCK,
      receivedAt: at,
    });
    expect(out).toEqual({ status: 'duplicate' });
    expect(create).toHaveBeenCalledTimes(8);
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

  // Verbatim from the user's inbox: BOB writes the amount FIRST — "Rs.69.00 Dr. from
  // A/C ... and Cr. to <vpa>@" — with a colon-stamped date at the end.
  it('reads a BOB "amount Dr." debit, names Amazon for its amzn VPA', () => {
    const out = parseSms(
      'Rs.69.00 Dr. from A/C XXXXXX0674 and Cr. to amzn-ds2pfucrpz4@apl. Ref:499438792179. ' +
        'AvlBal:Rs4303.95(2026:10:21 10:14:57). Not you? Call 18005700/5000-BOB',
      at,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.amountPaise).toBe(6900);
    expect(out.parsed.direction).toBe('debit');
    expect(out.parsed.kind).toBe('spend');
    expect(out.parsed.merchant).toBe('Amazon');
  });

  it('keeps an unknown VPA as the merchant, bank handle intact', () => {
    const out = parseSms(
      'Rs.4.85 Dr. from A/C XXXXXX0674 and Cr. to bdpg.iruts@sbi. Ref:772720502456. ' +
        'AvlBal:Rs4372.95(2026:10:21 09:44:47). Not you? Call 18005700/5000-BOB',
      at,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.amountPaise).toBe(485);
    // Not "bdpg.iruts@" — the noise-word scrub would drop the @sbi handle.
    expect(out.parsed.merchant).toBe('bdpg.iruts@sbi');
  });

  it('reads the BOB colon date when no receivedAt exists', () => {
    const out = parseSms(
      'Rs.1000.00 Dr. from A/C XXXXXX0674 and Cr. to 8828924662@ibl. Ref:842857565217. ' +
        'AvlBal:Rs3861.13(2025:07:20 12:58:47). Not you? Call 18005700/5000-BOB',
      null,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The bracket stamp is the transaction time, hour and minute included.
    expect(out.parsed.txnAt).toBe(new Date(2025, 6, 20, 12, 58, 47).getTime());
    expect(out.parsed.txnExact).toBe(true);
    expect(out.parsed.merchant).toBe('8828924662@ibl');
  });

  it('falls back to noon when the BOB stamp carries no time', () => {
    const out = parseSms(
      'Rs.1000.00 Dr. from A/C XXXXXX0674 and Cr. to 8828924662@ibl. Ref:842857565217. ' +
        'AvlBal:Rs3861.13(2025:07:20). Not you? Call 18005700/5000-BOB',
      null,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.txnAt).toBe(new Date(2025, 6, 20, 12).getTime());
    expect(out.parsed.txnExact).toBeUndefined();
  });

  it('ignores a garbage time and still lands the BOB date at noon', () => {
    const out = parseSms(
      'Rs.1000.00 Dr. from A/C XXXXXX0674 and Cr. to 8828924662@ibl. Ref:842857565217. ' +
        'AvlBal:Rs3861.13(2025:07:20 99:99:99). Not you? Call 18005700/5000-BOB',
      null,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.txnAt).toBe(new Date(2025, 6, 20, 12).getTime());
    expect(out.parsed.txnExact).toBeUndefined();
  });
});
