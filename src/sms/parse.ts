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
  /** True only when the body carried a full date-and-time stamp (BOB's "(2026:10:21 07:34:50)"). */
  txnExact?: boolean;
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
  [
    // Telecom service notices ("Due to no recharge, outgoing service has expired").
    // Their sender numbers have been read as rupee amounts — ₹9.77 crore "spends".
    /\bno recharge\b|outgoing service|service has expired\b/i,
    'telecom-alert',
  ],
  [
    // A payment prompt ("Swiggy is requesting payment of Rs.413") describes a
    // transaction that has not happened yet. The actual debit arrives as its own SMS.
    /\bis requesting payment\b|has requested money\b|requesting payment of\b/i,
    'payment-request',
  ],
] as const;

// No `g` flag: detectDirection tests these repeatedly, and a global regex carries
// lastIndex between calls, which would make the answer depend on call order.
const CREDIT =
  /\b(credited|received|remitted|refund(?:ed)?|salary|interest earned|cashback)|\bcr\.?\s+(?=₹|rs\.?|inr|\d)/i;

/**
 * Money demonstrably left the account. Beats CREDIT, so "debited ... cashback credited" stays a spend.
 *
 * "Dr." is Canara's shorthand for a debit, but the bare word is also a title, so it only
 * counts when an amount follows it: "Dr. INR 1,680.00" is a spend, "Dr. Smith's clinic" is not.
 * BOB writes the amount first — "Rs.69.00 Dr. from A/C ..." — so "Dr. from" (the account
 * it left) counts too, and the title use still never can.
 */
const DEBIT_STRONG =
  /\b(debited|spent|charged|paid|withdrawn|purchased)\b|\bdr\.?\s+(?=₹|rs\.?|inr|\d|from\b)/i;

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
  // A UPI counterparty — BOB writes a debit as "Dr. from A/C ... and Cr. to
  // <vpa>@<handle>". Anchored on the @ so ordinary payee names never match this.
  /\bto\s+([A-Za-z0-9][A-Za-z0-9.-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/i,
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
    // A VPA ("name@handle") is an identifier, not prose: the noise words below would
    // eat the bank handle ("iruts@sbi" → "@"), so "@" captures skip that step.
    const raw = m[1].includes('@')
      ? m[1]
      : m[1].replace(/[^\w .&'/@-]/g, '').replace(NOISE, ' ');
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 3) return cleaned;
  }
  return null;
}

/** The two readings of a meridiem-less stamp are this far apart. */
const HOUR_12 = 12 * 60 * 60 * 1000;

/**
 * How close the arrival must be to one reading before we trust it. The Shortcut fires as
 * the SMS lands, so seconds. A message forwarded more than this stays undecided rather
 * than guessed: the two readings are 12h apart, so a wrong pick needs the forward to be
 * ~10-14h late, which an arrival-triggered automation never is.
 */
const MERIDIEM_WINDOW = 2 * 60 * 60 * 1000;

/**
 * The body's own date stamps. Order matters: dd/mm, month names, then BOB's year-first
 * "(2026:10:21 07:34:50)" — whose bracket time replaces the noon when it parses.
 *
 * `anchor` is when the message arrived, and only decides one thing: which half of the day
 * BOB's meridiem-less clock meant. Null when the caller knows nothing about arrival.
 */
function parseBodyDate(
  body: string,
  anchor: number | null,
): { at: number; exact: boolean } | null {
  const at = (
    d: number | null,
    exact = false,
  ): { at: number; exact: boolean } | null =>
    d === null ? null : { at: d, exact };

  let m = body.match(new RegExp(`(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})`));
  if (m) return at(build(+m[3], +m[2], +m[1]));

  m = body.match(
    new RegExp(`(\\d{1,2})[ -](${MONTHS})[a-z]*[ -](\\d{2,4})`, 'i'),
  );
  if (m) {
    const month = MONTHS.split('|').indexOf(m[2].toLowerCase()) + 1;
    return at(build(+m[3], month, +m[1]));
  }

  // Year-first with colons — BOB stamps "(2026:10:21 10:14:57)". Requires the 4-digit
  // year so the trailing "10:14:57" time can never be misread as a date; the time is
  // captured when it trails the date and used exactly.
  m = body.match(/(\d{4}):(\d{1,2}):(\d{1,2})(?: (\d{1,2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const hasTime =
      m[4] !== undefined && +m[4] < 24 && +m[5] < 60 && +m[6] < 60;
    const stamped = build(
      +m[1],
      +m[2],
      +m[3],
      hasTime ? +m[4] : 12,
      hasTime ? +m[5] : 0,
      hasTime ? +m[6] : 0,
    );
    if (stamped === null || !hasTime) return at(stamped, false);
    const hour = +m[4];
    // 00 and 13..23 mean the sender used a 24-hour clock; there is nothing to resolve.
    if (hour === 0 || hour > 12) return at(stamped, true);
    const other = hour === 12 ? stamped - HOUR_12 : stamped + HOUR_12;
    if (anchor !== null) {
      const near =
        Math.abs(other - anchor) < Math.abs(stamped - anchor) ? other : stamped;
      if (Math.abs(near - anchor) <= MERIDIEM_WINDOW) return at(near, true);
    }
    // No arrival close enough to decide: keep the reading we have always produced (the
    // hour taken as written), but never claim it is exact.
    return at(stamped, false);
  }

  return null;
}

/** Local noon avoids DST shifting a midnight timestamp into the previous day. */
function build(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): number | null {
  const y = year < 100 ? (year < 70 ? 2000 + year : 1900 + year) : year;
  const t = new Date(y, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * `receivedAt` is when the message was received, the transaction time of record when the
 * caller has it. `anchor` is only used to decide the half of the day a meridiem-less body
 * stamp meant; it defaults to `receivedAt` because, when both exist, they are the same
 * moment. Callers that pass a body date as the transaction time but do know when the
 * message arrived (a pasted block) pass the two separately.
 */
export function parseSms(
  body: string,
  receivedAt: number | null,
  anchor: number | null = receivedAt,
): ParseResult {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };

  for (const [re, reason] of REJECT) {
    if (re.test(text)) return { ok: false, reason };
  }

  const direction = detectDirection(text);
  if (direction === null) return { ok: false, reason: 'no-direction' };

  const amountPaise = extractAmount(text);
  if (!amountPaise) return { ok: false, reason: 'no-amount' };

  const bodyDate = parseBodyDate(text, anchor);
  // receivedAt stays the single-message contract (an inbox row's receive time); the body
  // date is the fallback, and the exact flag rides along only for the bracket-time case.
  const txnAt = receivedAt ?? bodyDate?.at ?? null;
  if (txnAt === null) return { ok: false, reason: 'no-date' };

  const merchant = detectKnownMerchant(text) ?? extractMerchant(text);

  return {
    ok: true,
    parsed: {
      amountPaise,
      merchant,
      txnAt,
      direction,
      kind: classify(text),
      txnExact:
        receivedAt === null && bodyDate?.exact === true ? true : undefined,
    },
  };
}

/** A statement-style SMS should not become a novel; 20 transactions covers any real bank. */
const MAX_BULK_TXNS = 20;

/**
 * Separators banks use between transactions in one message, after whitespace is
 * collapsed. Also splits before an amount that a Dr./Cr. shorthand follows — how BOB
 * statements concatenate ("…5000-BOB Rs.1250.00 Dr. from …") with no separator at all.
 * Canara's amount-after order ("Dr. INR 1,680.00") cannot match this, and a trailing
 * balance ("AvlBal:Rs4303.95(2026:…") owns no shorthand after its amount.
 */
const SEGMENT_SPLIT =
  /[;|]\s*|\s+(?=(?:₹|rs\.?|inr)\s?[\d,]+(?:\.\d{1,2})?\s+(?:dr|cr)\.)/i;

/**
 * One transaction of a bulk message: its parse plus the exact text it was parsed from.
 * `text` is what dedupe keys are built from — a piece stored as its own row must carry
 * the key a standalone message of the same text would, so a re-scan of one message of a
 * pasted block collapses into the piece instead of doubling it.
 */
export type PieceTxn = Parsed & { text: string };

export type BulkResult =
  { ok: true; txns: PieceTxn[] } | { ok: false; reason: string };

/**
 * One body, every transaction it holds. A bulk/statement SMS ("Rs 500 debited at A;
 * Rs 250 debited at B") arrives as ONE body, and the single-body read produces one wrong
 * row — the first amount on its own. Splitting only counts when at least two pieces each
 * parse completely, so a single-transaction message with a stray separator (Canara writes
 * "to Famous Chick; UPI: ...") cannot be torn in two.
 */
export function extractTransactions(
  body: string,
  receivedAt: number | null,
  anchor: number | null = receivedAt,
): BulkResult {
  const whole = parseSms(body, receivedAt, anchor);
  if (!whole.ok) return whole;

  const text = body.replace(/\s+/g, ' ').trim();
  const pieces = text.split(SEGMENT_SPLIT).filter((p) => p.trim() !== '');
  if (pieces.length < 2) return { ok: true, txns: [{ ...whole.parsed, text }] };

  const txns: PieceTxn[] = [];
  for (const piece of pieces) {
    // A piece carries its own in-body date when it has one; the caller's receive-time
    // anchor only fills the gap. Key days must not depend on when the block arrived, but
    // the anchor still settles which half of the day a meridiem-less stamp meant.
    let r = parseSms(piece, null, anchor);
    if (!r.ok && r.reason === 'no-date' && receivedAt !== null)
      r = parseSms(piece, receivedAt, anchor);
    if (r.ok) txns.push({ ...r.parsed, text: piece });
    if (txns.length >= MAX_BULK_TXNS) break;
  }
  if (txns.length >= 2) return { ok: true, txns };
  return { ok: true, txns: [{ ...whole.parsed, text }] };
}
