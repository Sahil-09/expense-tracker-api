import { ConsoleLogger } from '@nestjs/common';

/**
 * Key names whose values are replaced before anything reaches a log sink.
 *
 * `rawSms` is the important one: bank notification text is the single most sensitive thing
 * this service holds, and it rides inside every sync payload. Matching is on the key name
 * alone so a new call site cannot accidentally log a message body under a different name.
 */
const SENSITIVE = new Set([
  'rawSms',
  'raw_sms',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
]);

const REDACTED = '[redacted]';

/**
 * Deep copy with sensitive values replaced.
 *
 * Depth-limited so a cycle or a very deep object cannot wedge the logger — the log line
 * is diagnostics, not a business path, so truncating is always preferable to throwing.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * Nest's logger with the redaction layer bolted on.
 *
 * Injected rather than used directly so every log call goes through `redact` without each
 * call site remembering to. Use this instead of `ConsoleLogger` everywhere in this
 * service.
 */
export class SafeLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    super.log(redact(message), ...rest.map((r) => redact(r) as string));
  }

  override error(message: unknown, ...rest: unknown[]): void {
    super.error(redact(message), ...rest.map((r) => redact(r) as string));
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(redact(message), ...rest.map((r) => redact(r) as string));
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(redact(message), ...rest.map((r) => redact(r) as string));
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(redact(message), ...rest.map((r) => redact(r) as string));
  }
}
