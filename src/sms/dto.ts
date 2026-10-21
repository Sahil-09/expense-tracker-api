import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * One SMS forwarded by an iOS Shortcut. No app is installed, so the raw body is all
 * the server gets; parsing happens on this side (src/sms/parse.ts).
 *
 * `receivedAt` is the message timestamp in epoch ms. Optional: a Shortcut may not have
 * it, in which case the date written inside the message is used.
 */
export class SmsRequest {
  @IsString()
  @IsNotEmpty()
  body: string;

  @IsOptional()
  @IsInt()
  receivedAt?: number;
}

export type SmsResponse =
  | { status: 'added'; clientId: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string };
