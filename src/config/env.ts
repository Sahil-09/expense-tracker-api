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
};

export type Env = typeof env;
