import { ExpenseRow } from './dto';
import { classify } from '../sms/parse';

/**
 * Read-time quality filter for expense rows.
 *
 * The SMS inbox has produced three classes of bad rows: telecom service notices whose
 * twelve-digit sender number was read as a rupee amount, bank payment *request* prompts
 * (which describe no completed transfer), and the same transaction scanned or templated
 * twice. They are filtered where a complete row set is in hand — the admin aggregate and
 * the dashboard store, which holds a user's whole ledger per session — so every total the
 * user sees comes from one cleaned set. Stored rows are left untouched; a dry-run report
 * for a permanent cleanup can diff against exactly these rules.
 *
 * This must run on a COMPLETE row set, never on one pull page: a prompt and the transfer
 * it demanded, or the two copies of one SMS, can sit either side of a page boundary.
 */

/** Telecom service notices. Never a transaction. */
const TELECOM_ALERT = /\bno recharge\b|outgoing service|service has expired/i;

/** A payment prompt ("Swiggy is requesting payment of Rs.413"), not the transfer itself. */
const PAYMENT_REQUEST =
  /\bis requesting payment\b|has requested money\b|requesting payment of\b/i;

/** Above this the "amount" is an identifier, not money. The real ledger tops out far below. */
export const MAX_PLAUSIBLE_PAISE = 100_000_000; // ₹10,00,000

/** Two reports of one event sit this close together; two real transactions usually don't. */
const DUPLICATE_WINDOW_MS = 5 * 60_000;

/** Copies of one text arrive twice (live push + inbox rescan) with the inbox copy
 *  tail-truncated, so exact-text equality misses them. Same amount, ≤5 min apart,
 *  and one message a prefix of the other (≥40 normalized chars) is still one event. */
const HEAD_MIN_CHARS = 40;

const sameSms = (a: string | null, b: string | null): boolean => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= HEAD_MIN_CHARS && (x.startsWith(y) || y.startsWith(x)));
};

/** How long after a prompt we await its matching transfer when checking whether one exists. */
const REQUEST_PAIR_WINDOW_MS = 30 * 60_000;

const norm = (s: string | null): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const sameLocalDay = (a: number, b: number): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString();

export type SanitizeStats = {
  telecom: number;
  requests: number;
  overCap: number;
  duplicates: number;
  reclassified: number;
};

export function sanitizeExpenses(input: ExpenseRow[]): {
  rows: ExpenseRow[];
  stats: SanitizeStats;
} {
  const stats: SanitizeStats = {
    telecom: 0,
    requests: 0,
    overCap: 0,
    duplicates: 0,
    reclassified: 0,
  };

  // Hard drops: telecom notices, and amounts no real transaction can carry.
  let rows = input.filter((r) => {
    if (TELECOM_ALERT.test(r.rawSms)) {
      stats.telecom++;
      return false;
    }
    if (r.amountPaise > MAX_PLAUSIBLE_PAISE) {
      stats.overCap++;
      return false;
    }
    return true;
  });

  // Payment prompts: drop one only when the transfer it demanded actually arrived. An
  // unpaired prompt is kept — without it the transfer would have no record at all.
  const isPrompt = (r: ExpenseRow): boolean => PAYMENT_REQUEST.test(r.rawSms);
  const real = rows.filter((r) => !isPrompt(r));
  const unpairedPrompts = rows.filter(
    (r) =>
      isPrompt(r) &&
      !real.some(
        (o) =>
          o.amountPaise === r.amountPaise &&
          Math.abs(o.txnAt - r.txnAt) <= REQUEST_PAIR_WINDOW_MS,
      ),
  );
  stats.requests = rows.length - real.length - unpairedPrompts.length;
  rows = [...real, ...unpairedPrompts];

  // Direction: trust the message over the stored flag. A "Credited" row the import
  // misfiled as an expense stops inflating spend. One-way: a bank's own "-Debited"
  // suffix already wins inside classify(), and income is never downgraded.
  rows = rows.map((r) => {
    if (r.isExpense && !r.isIncome && classify(r.rawSms) === 'income') {
      stats.reclassified++;
      return { ...r, isIncome: true };
    }
    return r;
  });

  // Duplicates: the same scan re-filed, or one event reported twice by two ingestion
  // channels (live push + inbox rescan, where the inbox copy is tail-truncated).
  // Only unambiguous pairs merge — same amount inside the window and one message equal
  // to the other or a head-prefix of it, or two credit messages for the same amount on
  // the same day. Amount+time alone is NOT a merge key: two real ₹5,000 withdrawals a
  // minute apart have different reference numbers and different balances.
  rows = [...rows].sort((a, b) => a.txnAt - b.txnAt);
  const kept: ExpenseRow[] = [];
  for (const r of rows) {
    const dup = kept.find(
      (o) =>
        o.amountPaise === r.amountPaise &&
        Math.abs(o.txnAt - r.txnAt) <= DUPLICATE_WINDOW_MS &&
        (sameSms(o.rawSms, r.rawSms) ||
          (classify(o.rawSms) === 'income' &&
            classify(r.rawSms) === 'income' &&
            sameLocalDay(o.txnAt, r.txnAt))),
    );
    if (dup) stats.duplicates++;
    else {
      kept.push(r);
      continue;
    }
    if ((r.rawSms ?? '').length > (dup.rawSms ?? '').length && Math.abs(dup.txnAt - r.txnAt) <= 30_000) {
      // Keep the fuller copy: its tail carries the parsed category/merchant, the
      // truncated one often classifies as "Other". Amount is identical, so no money moves.
      kept[kept.indexOf(dup)] = r;
    }
  }
  return { rows: kept, stats };
}
