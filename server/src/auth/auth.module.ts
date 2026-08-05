import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    JwtModule.register({
      // No fallback secret. A default here means a deployment missing the variable
      // silently signs tokens anyone can forge, which is worse than failing to boot.
      secret: requireEnv('JWT_ACCESS_SECRET'),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, JwtAuthGuard],
  // JwtModule is re-exported because JwtAuthGuard is registered as a global APP_GUARD
  // in AppModule, and a global guard is instantiated in the root injector - so its
  // dependencies must be resolvable there, not just inside this module.
  exports: [AuthService, TokenService, JwtAuthGuard, PasswordService, JwtModule],
})
export class AuthModule {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(
      `${name} is missing or shorter than 32 characters. Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }
  return value;
}
