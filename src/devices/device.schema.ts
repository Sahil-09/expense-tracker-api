import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * One phone. Exists for three reasons: it bounds the blast radius of a leaked token, it
 * gives a "last synced" per phone, and it is the id the sync protocol uses to suppress
 * echoing a device's own pushes back at it.
 *
 * The rotating refresh token lives here rather than in its own collection — it is
 * one-per-device, and a logout or revocation is then a single document update.
 */
@Schema({ collection: 'devices', timestamps: true })
export class Device {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Client-minted UUID, stable for the life of the install. */
  @Prop({ required: true })
  deviceId: string;

  @Prop({ required: true, default: 'Phone' })
  name: string;

  @Prop({ required: true, default: 'unknown' })
  platform: string;

  /** SHA-256 of the refresh token. The token itself is never stored. */
  @Prop({ type: String })
  refreshTokenHash?: string;

  @Prop({ type: Date })
  refreshTokenExpiresAt?: Date;

  @Prop({ type: Date })
  lastSeenAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DeviceDocument = HydratedDocument<Device>;
export const DeviceSchema = SchemaFactory.createForClass(Device);

// One physical install, one device row. A reinstall that reuses its stored id must not
// create a second one, or revocation would silently stop covering the phone.
DeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
