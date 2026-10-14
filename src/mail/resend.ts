import { Resend } from 'resend';

import { env } from '../config/env';

/**
 * Sends the reset code over email. Throws on any failure; the caller decides whether that
 * matters.
 *
 * The code is passed in the request body and never handed to a logger — SafeLogger
 * redacts by key name, so the only way to keep the code out of the logs is to never give
 * it to one.
 */
export async function sendPasswordResetEmail(
  to: string,
  code: string,
): Promise<void> {
  if (!env.resendApiKey) throw new Error('RESEND_API_KEY is not set');
  if (!env.mailFrom) throw new Error('MAIL_FROM is not set');

  const resend = new Resend(env.resendApiKey);
  const { error } = await resend.emails.send({
    from: env.mailFrom,
    to,
    subject: 'Your Expense Tracker reset code',
    text: [
      'Someone asked to reset the password on this Expense Tracker account.',
      '',
      `Your code is ${code}`,
      '',
      'It expires in 15 minutes and can only be used once.',
      '',
      'If this was not you, nothing has changed and you can ignore this message.',
    ].join('\n'),
  });

  if (error) {
    // The payload is Resend's, not ours, and can carry the key back in an echo. Status only.
    throw new Error(
      `Resend rejected the email${error.statusCode ? `: ${error.statusCode}` : ''}`,
    );
  }
}