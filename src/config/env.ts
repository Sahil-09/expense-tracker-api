/**
 * Environment, validated once at boot.
 *
 * Hand-rolled rather than pulled from a validation library: there are nine values, and a
 * missing or malformed one must stop the process rather than surface as a confusing
 * runtime error later. JWT secrets are the reason this is not just `process.env.x ?? ''`.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function requiredInt(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value))
    throw new Error(`Env var ${name} must be an integer`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value))
    throw new Error(`Env var ${name} must be an integer`);
  return value;
}

function optionalList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * An optional secret that gates a route, or null when the route is closed.
 *
 * `null` rather than '' on purpose: an unset code must disable the endpoint entirely, not
 * enable it behind an empty string that anyone posting no field at all would match.
 *
 * The length floor is the point. A four-character code is guessable by anyone who finds
 * the URL, and nothing about that failure is visible until it matters, so a short value
 * is rejected at boot rather than left to be discovered later.
 */
function optionalSecret(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  if (!value) return null;
  if (value.length < 12) {
    throw new Error(
      `${name} must be at least 12 characters. Generate one with: openssl rand -hex 24`,
    );
  }
  return value;
}

function optionalString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === '') return null;
  return value;
}

/** Widened so the literal stays in the type; `ms` is what @nestjs/jwt's type wants. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;

export const env = {
  port: requiredInt('PORT'),
  mongoUri: required('MONGO_URI'),
  /** Signs 15-minute access tokens. */
  jwtSecret: required('JWT_SECRET'),
  /** Signs 30-day refresh tokens. Separate key so a leaked access secret cannot mint one. */
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  accessTtl: ACCESS_TTL_MS,
  refreshTtlDays: optionalInt('REFRESH_TTL_DAYS', 30),
  /** Mobile clients send no Origin header, so this only constrains browser origins. */
  corsOrigins: optionalList('CORS_ORIGINS'),
  /** Unset means POST /auth/register does not exist. */
  signupCode: optionalSecret('SIGNUP_CODE'),
  /** Unset means password-reset email is not sent; the request still answers 200. */
  resendApiKey: optionalSecret('RESEND_API_KEY'),
  /** Verified sender, `name <address>`. Unset means password-reset email is not sent. */
  mailFrom: optionalString('MAIL_FROM'),
};

export type Env = typeof env;
