import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Types } from 'mongoose';

import { AccessPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SyncRequest, SyncResponse } from './dto';
import { SyncService } from './sync.service';

/**
 * The only write path for a phone's data. There is no per-resource CRUD: one cursor-based
 * call is a smaller surface to get right, and it is the shape the local DB already has.
 */
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post()
  run(
    @Req() req: Request & { user: AccessPayload },
    @Body() body: SyncRequest,
  ): Promise<SyncResponse> {
    // The token's own userId, never anything in the body, so one account's data cannot be
    // read or written by holding another account's token against a crafted id.
    return this.sync.sync(new Types.ObjectId(req.user.sub), body);
  }
}
