import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/jwt-auth.guard';
import { Errors } from '../common/errors';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequireApprovedVendor } from '../vendors/require-approved-vendor.decorator';
import { AvailabilityService } from './availability.service';
import {
  CreateExceptionSchema,
  ExceptionQuerySchema,
  NextAvailableQuerySchema,
  ReplaceRulesSchema,
  SlotQuerySchema,
  type CreateExceptionDto,
  type ExceptionQuery,
  type NextAvailableQuery,
  type ReplaceRulesDto,
  type SlotQuery,
} from './availability.dto';

/**
 * Availability and derived slots, all nested under the service they belong to.
 *
 * The reads are `@Public()` per route rather than at class level, because the writes live in
 * the same controller - a class-level @Public() would make them public too, and the
 * route-coverage test would be satisfied by it. Each write states its own permission.
 *
 * The reads still resolve visibility inside the service: public for a published service of
 * an approved vendor, otherwise 404 unless the caller owns it or holds `service.read_all`.
 * Availability must not become a side channel for discovering a draft.
 */
@Controller('services/:id')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  // ---------------------------------------------------------------- rules

  @Get('availability/rules')
  @Public()
  listRules(@Req() req: Request, @Param('id') id: string) {
    return this.availability.listRules(id, req.caller);
  }

  @Put('availability/rules')
  @RequirePermissions('availability.manage')
  @RequireApprovedVendor()
  replaceRules(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(ReplaceRulesSchema)) dto: ReplaceRulesDto,
  ) {
    return this.availability.replaceRules(vendorId(req), id, dto);
  }

  // ---------------------------------------------------------------- exceptions

  @Get('availability/exceptions')
  @Public()
  listExceptions(
    @Req() req: Request,
    @Param('id') id: string,
    @Query(zodBody(ExceptionQuerySchema)) query: ExceptionQuery,
  ) {
    return this.availability.listExceptions(id, req.caller, query);
  }

  @Post('availability/exceptions')
  @RequirePermissions('availability.manage')
  @RequireApprovedVendor()
  @HttpCode(201)
  addException(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(CreateExceptionSchema)) dto: CreateExceptionDto,
  ) {
    return this.availability.addException(vendorId(req), id, dto);
  }

  @Delete('availability/exceptions/:exceptionId')
  @RequirePermissions('availability.manage')
  @RequireApprovedVendor()
  @HttpCode(204)
  async removeException(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('exceptionId') exceptionId: string,
  ): Promise<void> {
    await this.availability.removeException(vendorId(req), id, exceptionId);
  }

  // ---------------------------------------------------------------- slots

  /**
   * Declared BEFORE `slots`, because Express matches in registration order and
   * `slots/next-available` would otherwise never be reached - `:id/slots` does not collide,
   * but keeping the more specific path first makes that independent of Nest's ordering.
   */
  @Get('slots/next-available')
  @Public()
  nextAvailable(
    @Req() req: Request,
    @Param('id') id: string,
    @Query(zodBody(NextAvailableQuerySchema)) query: NextAvailableQuery,
  ) {
    return this.availability.nextAvailable(id, req.caller, query.offeringId);
  }

  @Get('slots')
  @Public()
  slots(
    @Req() req: Request,
    @Param('id') id: string,
    @Query(zodBody(SlotQuerySchema)) query: SlotQuery,
  ) {
    return this.availability.slots(id, req.caller, query);
  }
}

function vendorId(req: Request): string {
  if (!req.vendorProfileId) throw Errors.notAVendor();
  return req.vendorProfileId;
}
