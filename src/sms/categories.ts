/**
 * Category rules, copied from the phone's `src/lib/categories.ts`.
 *
 * The server needs the same answer as a device so a server-ingested SMS lands in the
 * same bucket. Keep this file and the phone's copy in sync when a rule changes.
 */
export const CATEGORIES = [
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Bills',
  'Health',
  'Entertainment',
  'Transfer',
  'Rent',
  'Date',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const UNCATEGORIZED: Category = 'Other';

const KNOWN_MERCHANDS: readonly (readonly [RegExp, string])[] = [
  [/\bblinkit\b/i, 'Blinkit'],
  [/\binstamart\b/i, 'Instamart'],
  [/\bzepto\b/i, 'Zepto'],
  [/\bzomato\b/i, 'Zomato'],
  [/\bswiggy\b/i, 'Swiggy'],
];

export function detectKnownMerchant(text: string): string | null {
  for (const [re, name] of KNOWN_MERCHANDS) if (re.test(text)) return name;
  return null;
}

// Order matters: first match wins, so put specific merchants above broad words.
// 'store' is deliberately broad because Indian bank SMS name local shops "KARTIK STORE".
// shortcut: that also files APPLE STORE / STARBUCKS as groceries. Add a negative lookahead
// here if a branded store ever shows up often enough to be worth the noise.
const RULES: readonly (readonly [Category, RegExp])[] = [
  [
    'Groceries',
    /\b(blinkit|instamart|zepto|bigbasket|dmart|reliance fresh|grocer|kirana|vegetable|mart|store)\b/i,
  ],
  [
    'Food',
    /\b(zomato|swiggy|restaurant|cafe|food|pizza|burger|domino|mcdonald|starbucks|chai|zaika|table|dining|bar &|bakery)\b/i,
  ],
  [
    'Transport',
    /\b(uber|ola|rapido|metro|irctc|train|petrol|diesel|fuel|parking|toll|flight|airline|indigo|goair|taxi|auto|bus)\b/i,
  ],
  [
    'Shopping',
    /\b(amazon|flipkart|myntra|ajio|meesho|shopping|clothing|apparel|decathlon|ikea)\b/i,
  ],
  [
    'Bills',
    /\b(electric|bijli|water bill|gas bill|airtel|jio|recharge|postpaid| broadband|rent|subscription|netflix|hotstar|spotify|youtube ?premium|tax|gst|invoice|emi|loan)\b/i,
  ],
  [
    'Health',
    /\b(pharmacy|medical|hospital|doctor|clinic|apollo|medplus|health|test|lab)\b/i,
  ],
  [
    'Entertainment',
    /\b(cinema|movie|bookmyshow|game|steam|ticket|concert|club|bar)\b/i,
  ],
];

/** `text` should be the merchant, falling back to the raw SMS. Returns Other when nothing matches. */
export function categorize(text: string): Category {
  for (const [category, re] of RULES) {
    if (re.test(text)) return category;
  }
  return UNCATEGORIZED;
}
