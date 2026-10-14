import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto } from './dto';

/**
 * Login, refresh, logout. No register — the account is created by
 * `npm run bootstrap-user`, per ADR-004. Adding it later is the one route that would be
 * needed to open this up publicly.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const { user } = await this.auth.login(dto);
    return this.auth.tokens(user._id, dto);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
