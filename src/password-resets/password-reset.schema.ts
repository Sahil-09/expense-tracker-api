import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * One emailed reset code, for one user, at one time.
 *
 * Only the hash of the code is kept. The plaintext exists for the length of one request
 * — long enough to hand to Resend, never long enough to be sitting in a database dump,
 * which is what "somebody mailed themselves a password reset" would look like.
 */
@Schema({ collection: 'password_resets', timestamps: true })
export class PasswordReset {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** SHA-256 of `${userId}:${code}`. Binding it to the user means a stolen hash is not usable elsewhere. */
  @Prop({ required: true })
  codeHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  /** Set the moment the code is spent. A null here is what makes a code single-use. */
  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;

  createdAt: Date;
  updatedAt?: Date;
}

export type PasswordResetDocument = HydratedDocument<PasswordReset>;
export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

// The spend path: find this user's unconsumed code with this hash and take it. One index
// covers the whole predicate, so a correct code costs a single indexed lookup.
PasswordResetSchema.index({ userId: 1, codeHash: 1 });

// The throttle: "does this user have a live reset, and when was it made". Also the query
// that retires the old code when a fresh one is issued.
PasswordResetSchema.index({ userId: 1, consumedAt: 1, expiresAt: 1 });
