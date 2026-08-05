import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { zodBody } from '../common/zod.pipe';
import { Errors } from '../common/errors';
import { AuthService, MeResponse } from './auth.service';
import { Public } from './jwt-auth.guard';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './cookie';
import {
  LoginSchema,
  RegisterCustomerSchema,
  RegisterVendorSchema,
  type LoginDto,
  type RegisterCustomerDto,
  type RegisterVendorDto,
} from './dto';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 10/minute per IP on the credential routes. Login is the brute-force target; the
  // register routes are the spam target.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/register/customer')
  @HttpCode(201)
  async registerCustomer(
    @Body(zodBody(RegisterCustomerSchema)) dto: RegisterCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, access, refresh } = await this.auth.registerCustomer(dto);
    setRefreshCookie(res, refresh);
    return { user, accessToken: access };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/register/vendor')
  @HttpCode(201)
  async registerVendor(
    @Body(zodBody(RegisterVendorSchema)) dto: RegisterVendorDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, vendorProfile, access, refresh } = await this.auth.registerVendor(dto);
    setRefreshCookie(res, refresh);
    return { user, vendorProfile, accessToken: access };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(zodBody(LoginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, access, refresh } = await this.auth.login(dto);
    setRefreshCookie(res, refresh);
    return { user, accessToken: access };
  }

  /**
   * Public because it authenticates with the cookie, not a bearer token - by the time a
   * client calls this, its access token has already expired.
   */
  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) throw Errors.refreshInvalid();

    try {
      const { access, refresh } = await this.auth.refresh(raw);
      setRefreshCookie(res, refresh);
      return { accessToken: access };
    } catch (e) {
      // Clear the cookie on any refresh failure. Leaving a dead cookie in place makes
      // the client retry forever against a token that can never work again.
      clearRefreshCookie(res);
      throw e;
    }
  }

  /** Idempotent: no cookie, already revoked, or unknown token all answer 204. */
  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    clearRefreshCookie(res);
  }

  /**
   * Requires a token but no permission - every authenticated user may ask who they are.
   * The client builds its entire navigation from this response.
   */
  @Get('me')
  me(@Req() req: Request): Promise<MeResponse> {
    if (!req.caller) throw Errors.unauthenticated();
    return this.auth.me(req.caller.userId);
  }
}
