import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { Device, DeviceSchema } from '../devices/device.schema';
import { AuthService } from '../auth/auth.service';
import { Budget, BudgetDocument, BudgetSchema } from './budget.schema';
import { SyncResponse } from './dto';
import { Exclusion, ExclusionSchema } from './exclusion.schema';
import { Expense, ExpenseDocument, ExpenseSchema } from './expense.schema';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { User, UserSchema } from '../users/user.schema';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

const PASSWORD = 'correct horse battery staple';

describe('POST /sync', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let tokenFor: (email: string, deviceId: string) => Promise<string>;
  let a: string;
  let b: string;
  let z: string;

  const expense = (over: Record<string, unknown> = {}) => ({
    clientId: 'c1',
    amountPaise: 14900,
    merchant: 'Zepto',
    category: 'Groceries',
    txnAt: 1760000000000,
    note: null,
    rawSms: 'Zepto Rs.149.00 debited',
    dedupeKey: 'zepto rs.149.00 debited|oct 10 2026',
    source: 'android-live',
    isExpense: true,
    isDue: false,
    ...over,
  });

  const post = (body: Record<string, unknown>, token: string) =>
    request(app.getHttpServer())
      .post('/sync')
      .set('authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Expense.name, schema: ExpenseSchema },
          { name: Budget.name, schema: BudgetSchema },
          { name: Exclusion.name, schema: ExclusionSchema },
          { name: Device.name, schema: DeviceSchema },
        ]),
        UsersModule,
        AuthModule,
      ],
      controllers: [SyncController],
      providers: [SyncService],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const auth = app.get(AuthService);
    const account = app.get(UsersService);
    tokenFor = async (email, deviceId) => {
      const existing = await account.findByEmail(email);
      const user = existing ?? (await account.create(email, PASSWORD));
      if (!user) throw new Error(`could not set up ${email}`);
      return (
        await auth.tokens(user._id, { email, password: PASSWORD, deviceId })
      ).accessToken;
    };

    a = await tokenFor('me@example.com', 'phone-a');
    b = await tokenFor('me@example.com', 'phone-b');
    z = await tokenFor('other@example.com', 'phone-z');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    for (const m of ['Expense', 'Budget', 'Exclusion']) {
      await app
        .get<Model<{ deleteMany(q: unknown): Promise<unknown> }>>(
          getModelToken(m),
        )
        .deleteMany({});
    }
  });

  const expenses = () =>
    app.get<Model<ExpenseDocument>>(getModelToken(Expense.name));

  it('rejects a request with no valid token', async () => {
    await post({ deviceId: 'phone-a' }, 'garbage').expect(401);
  });

  it('pushes a new expense and echoes nothing back to the pusher', async () => {
    const out = await post(
      { deviceId: 'phone-a', expenses: [expense()] },
      a,
    ).expect(201);
    expect((out.body as SyncResponse).expenses).toHaveLength(0);
    expect(await expenses().findOne({ clientId: 'c1' })).toBeTruthy();
  });

  it("refuses a phone-supplied updatedAt, so the clock is never the phone's", async () => {
    const before = Date.now();
    await post(
      { deviceId: 'phone-a', expenses: [expense({ updatedAt: 1 })] },
      a,
    ).expect(400);

    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    const stored = await expenses().findOne({ clientId: 'c1' }).lean();
    expect(stored?.updatedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before);
  });

  it('does not echo back what this request just pushed', async () => {
    const out = await post(
      { deviceId: 'phone-a', expenses: [expense()] },
      a,
    ).expect(201);
    expect(out.body.expenses).toHaveLength(0);
  });

  it('delivers a pushed expense to the other device', async () => {
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);

    const other = await post({ deviceId: 'phone-b', cursor: null }, b).expect(
      201,
    );
    expect(other.body.expenses).toHaveLength(1);
    expect(other.body.expenses[0].clientId).toBe('c1');
  });

  it('sends a device its own history back when it has no cursor', async () => {
    // A reinstall loses the cursor, and the only way it can get its history back is by
    // asking for everything — including the rows it pushed before.
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    const out = await post({ deviceId: 'phone-a', cursor: null }, a).expect(
      201,
    );
    expect(out.body.expenses).toHaveLength(1);
  });

  it('returns nothing once the cursor is past the row', async () => {
    const first = await post(
      { deviceId: 'phone-a', expenses: [expense()] },
      a,
    ).expect(201);
    const next = await post(
      { deviceId: 'phone-b', cursor: first.body.cursor },
      b,
    ).expect(201);
    expect(next.body.expenses).toHaveLength(0);
  });

  it('re-pushing the same expense is idempotent, not a second row', async () => {
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    await post(
      { deviceId: 'phone-a', expenses: [expense({ amountPaise: 16000 })] },
      a,
    ).expect(201);
    expect(await expenses().countDocuments()).toBe(1);
  });

  it('keeps two phones from storing the same SMS twice', async () => {
    await post(
      { deviceId: 'phone-a', expenses: [expense({ clientId: 'from-a' })] },
      a,
    ).expect(201);
    const out = await post(
      { deviceId: 'phone-b', expenses: [expense({ clientId: 'from-b' })] },
      b,
    ).expect(201);

    // Reported as a duplicate rather than 500-ing on the unique index, and the phone is
    // told which row already holds the text.
    expect(out.body.duplicates).toEqual({ 'from-b': 'from-a' });
    expect(await expenses().countDocuments()).toBe(1);
  });

  it('propagates a delete as a tombstone rather than removing the row', async () => {
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    await post(
      { deviceId: 'phone-a', expenses: [expense({ deleted: true })] },
      a,
    ).expect(201);

    const out = await post({ deviceId: 'phone-b', cursor: null }, b).expect(
      201,
    );
    expect(out.body.expenses[0].deletedAt).toEqual(expect.any(Number));
    expect(await expenses().countDocuments()).toBe(1);
  });

  // The regression this guards: every tombstone carries the same empty dedupeKey, so the
  // duplicate check used to match the *previous* tombstone and drop every delete after
  // the first — on every device, on every sync, forever.
  it('propagates a second delete instead of calling it a duplicate', async () => {
    await post(
      {
        deviceId: 'phone-a',
        expenses: [
          expense({ clientId: 'gone-1', dedupeKey: 'k1' }),
          expense({ clientId: 'gone-2', dedupeKey: 'k2' }),
        ],
      },
      a,
    ).expect(201);

    const out = await post(
      {
        deviceId: 'phone-a',
        expenses: [
          expense({ clientId: 'gone-1', dedupeKey: '', deleted: true }),
          expense({ clientId: 'gone-2', dedupeKey: '', deleted: true }),
        ],
      },
      a,
    ).expect(201);

    expect(out.body.duplicates).toEqual({});
    expect(await expenses().countDocuments({ deletedAt: { $ne: null } })).toBe(
      2,
    );

    const other = await post({ deviceId: 'phone-b', cursor: null }, b).expect(
      201,
    );
    const tombstoned = other.body.expenses as {
      clientId: string;
      deletedAt: number | null;
    }[];
    expect(tombstoned.filter((e) => e.deletedAt !== null)).toHaveLength(2);
  });

  it('still collapses two phones capturing the same SMS', async () => {
    await post(
      { deviceId: 'phone-a', expenses: [expense({ clientId: 'from-a' })] },
      a,
    ).expect(201);
    await post(
      { deviceId: 'phone-b', expenses: [expense({ clientId: 'from-b' })] },
      b,
    ).expect(201);
    expect(await expenses().countDocuments()).toBe(1);
  });

  it('last write wins', async () => {
    await post(
      { deviceId: 'phone-a', expenses: [expense({ amountPaise: 100 })] },
      a,
    ).expect(201);
    await post(
      { deviceId: 'phone-b', expenses: [expense({ amountPaise: 200 })] },
      b,
    ).expect(201);
    expect(
      (await expenses().findOne({ clientId: 'c1' }).lean())?.amountPaise,
    ).toBe(200);
  });

  it('syncs budgets and exclusions, tombstones included', async () => {
    await post(
      {
        deviceId: 'phone-a',
        budgets: [{ category: 'Groceries', monthlyPaise: 500000 }],
        exclusions: [{ merchant: 'swiggy' }],
      },
      a,
    ).expect(201);

    const out = await post({ deviceId: 'phone-b', cursor: null }, b).expect(
      201,
    );
    expect(out.body.budgets).toEqual([
      expect.objectContaining({
        category: 'Groceries',
        monthlyPaise: 500000,
        deletedAt: null,
      }),
    ]);
    expect(out.body.exclusions).toEqual([
      expect.objectContaining({ merchant: 'swiggy' }),
    ]);

    await post(
      {
        deviceId: 'phone-b',
        budgets: [{ category: 'Groceries', monthlyPaise: 1, deleted: true }],
      },
      b,
    ).expect(201);
    const budgets = app.get<Model<BudgetDocument>>(getModelToken(Budget.name));
    expect(
      (await budgets.findOne({ category: 'Groceries' }).lean())?.deletedAt,
    ).toEqual(expect.any(Date));
  });

  it('never lets one account read another account data', async () => {
    await post({ deviceId: 'phone-a', expenses: [expense()] }, a).expect(201);
    const out = await post({ deviceId: 'phone-z', cursor: null }, z).expect(
      201,
    );
    expect(out.body.expenses).toHaveLength(0);
  });

  it('rejects a change carrying someone else userId', async () => {
    await post(
      {
        deviceId: 'phone-a',
        expenses: [expense({ userId: new Types.ObjectId().toString() })],
      },
      a,
    ).expect(400);
  });

  it('has the three indexes the protocol depends on, and they are unique where it matters', async () => {
    const model = expenses();
    await model.syncIndexes();
    const keys = (await model.collection.indexes()).map((i) =>
      JSON.stringify(i.key),
    );
    expect(keys).toContain(JSON.stringify({ userId: 1, clientId: 1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1, dedupeKey: 1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1, updatedAt: 1 }));

    const list = await model.collection.indexes();
    expect(
      list.find(
        (i) =>
          JSON.stringify(i.key) === JSON.stringify({ userId: 1, dedupeKey: 1 }),
      ),
    ).toMatchObject({ unique: true });
  });
});
