import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'smsLogs', timestamps: true })
export class SmsLog {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  body: string;

  @Prop({ type: Object })
  response?: Record<string, unknown>;

  @Prop({ type: String })
  error?: string;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export type SmsLogDocument = HydratedDocument<SmsLog>;
export const SmsLogSchema = SchemaFactory.createForClass(SmsLog);
