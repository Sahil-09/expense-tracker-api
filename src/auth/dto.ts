import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;

  /** Client-minted UUID identifying this install. Optional so an old build can still log in. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class LogoutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password: string;

  /** The owner's SIGNUP_CODE. Checked before the password is ever hashed. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  code: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  newPassword: string;

  /** The owner's RESET_CODE, which is deliberately not the signup code: leaking one
   * should not also let someone take over an account that already exists. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  code: string;
}
