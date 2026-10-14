import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * The row that matters.
 *
 * `clientId` is the identity: the phone's local `id` is an autoincrement integer and two
 * devices each mint id 5 for different expenses, so syncing on it would silently write one
 * phone's merchant over the other's row. `dedupeKey` is the phone's own exact-match text
 * key, carried across so a re-scanned SMS stays idempotent server-side too.
 *
 * Deletes are tombstones (`deletedAt`), not removals, so a delete on one phone propagates.
 */
@Schema({ collection: 'expenses', timestamps: true })
export class Expense {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  clientId: string;

  @Prop({ required: true })
  amountPaise: number;

  @Prop({ type: String })
  merchant?: string | null;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true, type: Date })
  txnAt: Date;

  @Prop({ type: String })
  note?: string | null;

  @Prop({ required: true })
  rawSms: string;

  @Prop({ required: true })
  dedupeKey: string;

  @Prop({ required: true })
  source: string;

  @Prop({ required: true, default: true })
  isExpense: boolean;

  @Prop({ required: true, default: false })
  isDue: boolean;

  @Prop({ type: Date })
  deletedAt?: Date | null;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export type ExpenseDocument = HydratedDocument<Expense>;
export const ExpenseSchema = SchemaFactory.createForClass(Expense);

// Cross-device identity: the same row, whatever each phone calls it locally.
ExpenseSchema.index({ userId: 1, clientId: 1 }, { unique: true });

// Idempotent re-push. Mirrors the local INSERT OR IGNORE in ADR-003 so re-scanning the
// same inbox cannot double-post on the server either.
//
// Partial, and that is load-bearing rather than cosmetic. A tombstone carries no message
// text, so every one of them has the same empty dedupeKey — under a full unique index the
// second delete on a device is rejected as a duplicate key and the whole sync 500s.
ExpenseSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// Cursor pulls.
ExpenseSchema.index({ userId: 1, updatedAt: 1 });
