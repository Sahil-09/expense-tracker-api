import { Types } from 'mongoose';

import { parseSms } from './parse';
import { SmsService } from './sms.service';

/**
 * Unit tests with tiny model stubs rather than mongodb-memory-server: the service's
 * job is parse → dedupe → insert, and each branch is cheaper to pin here than to seed
 * a database for.
 */
function makeService(
  opts: { held?: unknown; excluded?: boolean; createError?: Error } = {},
) {
  const create = jest.fn(() =>
    opts.createError ? Promise.reject(opts.createError) : Promise.resolve(),
  );
  const expenses = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve(opts.held ?? null) }),
      }),
    })),
    create,
  };
  const exclusions = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve(opts.excluded ? { _id: 1 } : null),
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
});
