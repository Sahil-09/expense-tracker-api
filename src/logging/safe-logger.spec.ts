import { redact } from './safe-logger';

describe('redact', () => {
  it('never lets rawSms through, however deeply nested', () => {
    const sms = 'HDFC Rs.4200 debited a/c x123';
    const line = redact({ expenses: [{ rawSms: sms }] });
    expect(JSON.stringify(line)).not.toContain(sms);
  });

  it('covers the other sensitive keys a sync payload or login can carry', () => {
    const line = redact({
      password: 'hunter2',
      accessToken: 'a.b.c',
      refreshToken: 'r-e-f',
      raw_sms: 'x',
      authorization: 'Bearer y',
      amountPaise: 100,
    });
    expect(line).toEqual({
      password: '[redacted]',
      accessToken: '[redacted]',
      refreshToken: '[redacted]',
      raw_sms: '[redacted]',
      authorization: '[redacted]',
      amountPaise: 100,
    });
  });

  it('truncates rather than recursing forever', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i++) {
      node.next = {};
      node = node.next as Record<string, unknown>;
    }
    expect(() => redact(deep)).not.toThrow();
  });
});
