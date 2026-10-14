import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** A monthly cap per category. Same tombstone rules as expenses. */
@Schema({ collection: 'budgets', timestamps: true })
export class Budget {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true })
  monthlyPaise: number;

  @Prop({ type: Date })
  deletedAt?: Date | null;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export type BudgetDocument = HydratedDocument<Budget>;
export const BudgetSchema = SchemaFactory.createForClass(Budget);

// The phone keys budgets by category too (category TEXT PRIMARY KEY), so the pair is the
// identity on both sides and there is no separate clientId to mint.
BudgetSchema.index({ userId: 1, category: 1 }, { unique: true });
BudgetSchema.index({ userId: 1, updatedAt: 1 });
