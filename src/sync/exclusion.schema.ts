import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Merchants the user has flagged as personal, so the same payment is never logged again.
 *
 * Keyed on the normalised merchant — the phone lowercases and collapses whitespace before
 * storing, and does the same here so both sides agree on what "Swiggy " means.
 */
@Schema({ collection: 'exclusions', timestamps: true })
export class Exclusion {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  merchant: string;

  @Prop({ type: Date })
  deletedAt?: Date | null;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export type ExclusionDocument = HydratedDocument<Exclusion>;
export const ExclusionSchema = SchemaFactory.createForClass(Exclusion);

ExclusionSchema.index({ userId: 1, merchant: 1 }, { unique: true });
ExclusionSchema.index({ userId: 1, updatedAt: 1 });
