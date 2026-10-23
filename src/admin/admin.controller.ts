import { Controller, Get, Post, Query, Param, UseGuards } from '@nestjs/common';
import { Types } from 'mongoose';

import { AdminGuard } from './admin.guard';
import { AdminService, AdminUserSummary } from './admin.service';
import { SyncResponse } from '../sync/dto';

/**
 * Read-only admin endpoints for cross-user expense visibility.
 *
 * - Guarded by AdminGuard (JWT + ADMIN_EMAILS allowlist).
 * - No write/mutation endpoints. Only aggregated overview and pull for drill-down.
 * - Date ranges use epoch milliseconds so the browser computes its own month boundaries.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * GET /admin/users?from=<epochMs>&to=<epochMs>
   *
   * Returns all users with spend/income totals for the optional date range.
   * If from/to omitted, returns all-time totals.
   */
  @Get('users')
  async getUsers(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ users: AdminUserSummary[] }> {
    const fromMs = from ? parseInt(from, 10) : undefined;
    const toMs = to ? parseInt(to, 10) : undefined;

    if (from && Number.isNaN(fromMs)) throw new Error('Invalid from parameter');
    if (to && Number.isNaN(toMs)) throw new Error('Invalid to parameter');

    const users = await this.admin.getAllUsers(fromMs, toMs);
    return { users };
  }

  /**
   * POST /admin/users/:userId/sync
   *
   * Pulls raw expense/budget/exclusion rows for a specific user (admin drill-down).
   * Mirrors the phone's /sync pull shape but without push/echo suppression.
   * Body: { cursor?: string|null }
   * Response: { cursor, hasMore, expenses[], budgets[], exclusions[] }
   */
  @Post('users/:userId/sync')
  async pullUser(
    @Param('userId') userId: string,
    @Query('cursor') cursor?: string,
  ): Promise<SyncResponse> {
    const objectId = new Types.ObjectId(userId);
    return this.admin.pullUserData({
      userId: objectId,
      cursor: cursor ?? null,
    });
  }
}
