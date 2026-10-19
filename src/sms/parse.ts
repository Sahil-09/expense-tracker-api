/**
 * SMS parser, copied from the phone's `src/lib/parse.ts`.
 *
 * The server parses so an iOS Shortcut can push a raw SMS with no app installed.
 * Keep this file and the phone's copy in sync; `sms.service.spec.ts` pins the
 * behaviours that matter to both.
 */
import { detectKnownMerchant } from './categories';
import { toPaise } from './money';

export type Direction = 'debit' | 'credit';

export type SpendKind = 'spend' | 'due' | 'transfer' | 'income';

export type Parsed = {
  amountPaise: number;
  merchant: string | null;
  txnAt: number;
  direction: Direction;
  kind: SpendKind;
};

export type ParseResult =
  { ok: true; parsed: Parsed } | { ok: false; reason: string };

// Checked before anything else. Anything matching is not a spend.
const REJECT = [
  [
    /\b(otp|one[\s-]?time (password|code)|verification code|security code|do not share)\b/i,
    'otp',
  ],
  [
    /\b(avail(able)? bal|available balance|your balance is|balance due)\b/i,
    'balance-enquiry',
  ],
  [
    /\b(failed|declined|reversed|unsuccessful|could not be)\b/i,
    'failed-transaction',
  ],
  [
    /\b(pre[\s-]?approved|apply now|offer|voucher|lucky draw|click here|limited period|% ?off)\b/i,
    'promotion',
  ],
] as const;

// No `g` flag: detectDirection tests these repeatedly, and a global regex carries
// lastIndex between calls, which would make the answer depend on call order.
const CREDIT =
  /\b(credited|received|remitted|refund(?:ed)?|salary|interest earned|cashback|cr\.?\b)/i;

/** Money demonstrably left the account. Beats CREDIT, so "debited ... cashback credited" stays a spend. */
const DEBIT_STRONG =
  /\b(debited|spent|charged|paid|withdrawn|purchased|dr\.?)\b/i;

/**
 * Names a payment without saying one left. Loses to CREDIT, so "Payment of Rs 500 has
 * been received" and "Rs 50 cashback sent" are both income, while a bare "Sent Rs.40" or
 * an "EMI ... is due" reminder is a spend you owe.
 */
const DEBIT_WEAK = /\b(payment of|purchase of|paid to|sent|due)\b/i;

/**
 * Announces a charge that has not happened yet, rather than reporting one that did.
 *
 * Anchored on reminder phrasing and never on a bare "due", so a real debit that happens
 * to mention a due date still parses as a spend.
 */
const REMINDER =
  /\b(is due (on|by)|has been generated|bill (for|generated)|will be processed|will be debited|will be charged|upcoming mandate)\b/i;

export function isDueMessage(body: string): boolean {
  return REMINDER.test(body);
}

const BANK_DEST =
  /\b(bank|small finance|hdfc|sbi|icici|axis|kotak|idfc|indusind|canara|punjab national|union bank|federal bank|equitas|standard chartered|hsbc|citi)\b/i;

/** The payee of a "Sent/Transferred ... To <X>" message, stopping at the trailing date/ref. */
const TO_DEST =
  /\bto\s+([A-Za-z][A-Za-z .&'-]{1,28}?)(?:\s+on\b|\s+ref\b|\s{2,}|$)/i;

export function isTransferMessage(body: string): boolean {
  const m = body.match(TO_DEST);
  return m !== null && BANK_DEST.test(m[1]);
}

/** What kind of row a raw message should become. Also used to re-check stored rows. */
export function classify(body: string): SpendKind {
  if (isDueMessage(body)) return 'due';
  if (isTransferMessage(body)) return 'transfer';
  // A credit is money in, not a spend. Stored so a month can show net, never counted.
  if (detectDirection(body) === 'credit') return 'income';
  return 'spend';
}

const AMOUNT_PATTERNS = [
  /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/i,
  /([\d,]+(?:\.\d{1,2})?)\s*(?:inr|rs\.?|₹)/i,
  /\b(?:debited|spent|charged|paid|purchased|of|for|towards)\s+(?:by\s+)?(?:₹|rs\.?|inr)?\s?([\d,]{3,}(?:\.\d{1,2})?|\d{1,2}\.\d{1,2})/i,
];

const MERCHANT_PATTERNS = [
  /\b(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]{1,38}?)\s+on\s+\d/i,
  /\b(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]{1,38}?)\s+(?:avail|ref(?:no)?\b|txn|transaction)/i,
  /\b(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]{1,38}?)\s*[;,]\s*(?:upi|ref|txn|transaction|avail)/i,
  /\btowards\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]{1,38}?)(?:\s+on|\s*,|$)/i,
  /\bfor\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]{1,38}?)(?:\s+on\s|\s+using|\s*$)/i,
];

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

function detectDirection(body: string): Direction | null {
  if (DEBIT_STRONG.test(body)) return 'debit';
  if (CREDIT.test(body)) return 'credit';
  if (DEBIT_WEAK.test(body)) return 'debit';
  return null;
}

function extractAmount(body: string): number | null {
  for (const re of AMOUNT_PATTERNS) {
    const m = body.match(re);
    const paise = m && toPaise(m[1]);
    if (paise) return paise;
  }
  return null;
}

const NOISE =
  /\b(hdfc|icici|axis|sbi|kotak|idfc|yes ?bank|kotak mahindra|pnb|bob|canara|union bank|indusind|kotak|account|a\/c|upi|imps|neft|rtgs|credit card|debit card|card|ref)\b/gi;

function extractMerchant(body: string): string | null {
  for (const re of MERCHANT_PATTERNS) {
    const m = body.match(re);
    if (!m) continue;
    const cleaned = m[1]
      .replace(/[^\w .&'/-]/g, '')
      .replace(NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 3) return cleaned;
  }
  return null;
}

/** Local noon avoids DST shifting a midnight timestamp into the previous day. */
function parseBodyDate(body: string): number | null {
  let m = body.match(new RegExp(`(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})`));
  if (m) return build(+m[3], +m[2], +m[1]);

  m = body.match(
    new RegExp(`(\\d{1,2})[ -](${MONTHS})[a-z]*[ -](\\d{2,4})`, 'i'),
  );
  if (m) {
    const month = MONTHS.split('|').indexOf(m[2].toLowerCase()) + 1;
    return build(+m[3], month, +m[1]);
  }
  return null;
}

function build(year: number, month: number, day: number): number | null {
  const y = year < 100 ? (year < 70 ? 2000 + year : 1900 + year) : year;
  const t = new Date(y, month - 1, day, 12).getTime();
  return Number.isFinite(t) ? t : null;
}

export function parseSms(body: string, receivedAt: number | null): ParseResult {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };

  for (const [re, reason] of REJECT) {
    if (re.test(text)) return { ok: false, reason };
  }

  const direction = detectDirection(text);
  if (direction === null) return { ok: false, reason: 'no-direction' };

  const amountPaise = extractAmount(text);
  if (!amountPaise) return { ok: false, reason: 'no-amount' };

  const txnAt = receivedAt ?? parseBodyDate(text) ?? null;
  if (txnAt === null) return { ok: false, reason: 'no-date' };

  const merchant = detectKnownMerchant(text) ?? extractMerchant(text);

  return {
    ok: true,
    parsed: { amountPaise, merchant, txnAt, direction, kind: classify(text) },
  };
}
