import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Types } from 'mongoose';

import { AccessPayload } from '../auth/auth.service';
import { SmsAuthGuard } from './sms-auth.guard';
import { SmsRequest, SmsResponse } from './dto';
import { SmsService } from './sms.service';

/**
 * The no-app path: an iOS Shortcut forwards a bank SMS here because iOS gives no app
 * access to the inbox. Authenticated with either the ordinary access token or the
 * long-lived `SMS_INGEST_TOKEN`.
 */
@Controller('sms')
@UseGuards(SmsAuthGuard)
export class SmsController {
  constructor(private readonly sms: SmsService) {}

  @Post()
  ingest(
    @Req() req: Request & { user: AccessPayload },
    @Body() body: SmsRequest,
  ): Promise<SmsResponse> {
    // The token's own userId, never anything in the body.
    return this.sms.ingest(new Types.ObjectId(req.user.sub), body);
  }
}
