import { sanitizeExpenses, MAX_PLAUSIBLE_PAISE } from './sanitize';
import { ExpenseRow } from './dto';

const row = (
  over: Partial<ExpenseRow> & {
    rawSms: string;
    amountPaise: number;
    txnAt: number;
  },
): ExpenseRow => ({
  clientId: 'c' + Math.random().toString(36).slice(2),
  merchant: null,
  category: 'Other',
  note: null,
  dedupeKey: 'k',
  source: 'test',
  isExpense: true,
  isDue: false,
  isIncome: false,
  deletedAt: null,
  ...over,
});

describe('sanitizeExpenses', () => {
  it('drops telecom alerts whose sender number read as an amount', () => {
    const res = sanitizeExpenses([
      row({
        rawSms:
          'Alert! Due to no recharge, outgoing service has expired for 9768957932',
        amountPaise: 976895793200,
        txnAt: 1000,
      }),
      row({
        rawSms: 'Spent INR 100 using Axis Bank Card',
        amountPaise: 10000,
        txnAt: 2000,
      }),
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.stats.telecom).toBe(1);
  });

  it('drops implausible amounts above the cap', () => {
    const res = sanitizeExpenses([
      row({
        rawSms: 'debited INR 123456789',
        amountPaise: MAX_PLAUSIBLE_PAISE + 1,
        txnAt: 1000,
      }),
    ]);
    expect(res.rows).toHaveLength(0);
    expect(res.stats.overCap).toBe(1);
  });

  it('drops a payment prompt only when its transfer actually arrived', () => {
    const prompt = row({
      rawSms:
        'Swiggy is requesting payment of Rs.413. Pay from your Bank Account',
      amountPaise: 41300,
      txnAt: 1000,
    });
    const debit = row({
      rawSms: 'BOI UPI debited for Rs.413.00 and credited to swiggyupi',
      amountPaise: 41300,
      txnAt: 30000,
    });
    const paired = sanitizeExpenses([prompt, debit]);
    expect(paired.rows.map((r) => r.rawSms)).toEqual([debit.rawSms]);
    expect(paired.stats.requests).toBe(1);

    const unpaired = sanitizeExpenses([prompt]);
    expect(unpaired.rows.map((r) => r.rawSms)).toEqual([prompt.rawSms]);
    expect(unpaired.stats.requests).toBe(0);
  });

  it('merges an identical re-scan but not two real withdrawals a minute apart', () => {
    const scan =
      'Rs.5000.00 withdrawn at FAISAL MANZIL on 03-09-2021 using Debit Card. RefNo.';
    const res = sanitizeExpenses([
      row({ rawSms: scan, amountPaise: 500000, txnAt: 1000 }),
      row({ rawSms: scan, amountPaise: 500000, txnAt: 4000 }),
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.stats.duplicates).toBe(1);

    const a =
      'Rs.5000.00 withdrawn at FAISAL MANZIL on 03-09-2021 using Debit Card. Avl Bal:Rs.8146.63. RefNo. 124619028047.';
    const b =
      'Rs.5000.00 withdrawn at FAISAL MANZIL on 03-09-2021 using Debit Card. Avl Bal:Rs.3146.63. RefNo. 124619010363.';
    const two = sanitizeExpenses([
      row({ rawSms: a, amountPaise: 500000, txnAt: 1000 }),
      row({ rawSms: b, amountPaise: 500000, txnAt: 101_000 }),
    ]);
    expect(two.rows).toHaveLength(2);
  });

  it('merges two receipt templates for one credit, never a credit plus a debit', () => {
    const credit = row({
      rawSms:
        'Your A/C XXXXX092656 Credited INR 1,000.00 on 10/05/24 -Deposit by transfer from Mr. Sahil Sadik Patel.',
      amountPaise: 100000,
      txnAt: 1000,
    });
    const credit2 = row({
      rawSms:
        'Dear Customer, Your A/C XXXXX092656 Credited. INR 1,000.00 on 10/05/24 on account of Closure of TD A/c XXXXX970905.-SBI',
      amountPaise: 100000,
      txnAt: 3400,
    });
    expect(sanitizeExpenses([credit, credit2]).rows).toHaveLength(1);

    const debit = row({
      rawSms:
        'Your A/C XXXXX092656 Debited INR 1,000.00 on 10/05/24 -Transferred to Mr. Sahil Sadik Patel.',
      amountPaise: 100000,
      txnAt: 1000,
    });
    expect(sanitizeExpenses([credit, debit]).rows).toHaveLength(2);
  });

  it('reclassifies a credit the import misfiled as an expense', () => {
    const res = sanitizeExpenses([
      row({
        rawSms: 'Your A/C XXXXX092656 Credited INR 3,50,316.00 on 21/05/24',
        amountPaise: 35031600,
        txnAt: 1000,
      }),
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].isIncome).toBe(true);
    expect(res.stats.reclassified).toBe(1);
  });
});
