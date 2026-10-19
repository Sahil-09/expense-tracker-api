/**
 * "1,23,456.78" -> 12345678. Integer maths only; floats lose paise.
 *
 * Copied from the phone's `src/lib/money.ts`. Keep the two in sync: a server-parsed
 * amount must land on exactly the same paise as a device-parsed one.
 */
export function toPaise(input: string): number | null {
  const clean = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}
