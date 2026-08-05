import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/jwt-auth.guard';
import { zodBody } from '../common/zod.pipe';
import { ServicesService } from './services.service';
import { OfferingsService } from './offerings.service';
import { PublicServiceQuerySchema, type PublicServiceQuery } from './catalog.dto';

/**
 * The public catalogue. `@Public()` at class level, so nothing here can be reached by
 * forgetting a decorator on a new method.
 *
 * JwtAuthGuard still attaches `req.caller` when a token happens to be present, which is
 * what lets the detail route below answer 200 to an owner looking at their own draft
 * without a second route existing for it.
 */
@Controller('services')
@Public()
export class ServicesController {
  constructor(
    private readonly services: ServicesService,
    private readonly offerings: OfferingsService,
  ) {}

  @Get()
  list(@Query(zodBody(PublicServiceQuerySchema)) query: PublicServiceQuery) {
    return this.services.listPublic(query);
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.services.getOneVisibleTo(id, req.caller);
  }

  @Get(':id/offerings')
  listOfferings(@Req() req: Request, @Param('id') id: string) {
    return this.offerings.listForService(id, req.caller);
  }
}
