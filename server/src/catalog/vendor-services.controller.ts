import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequireApprovedVendor } from '../vendors/require-approved-vendor.decorator';
import { ServicesService } from './services.service';
import {
  CreateServiceSchema,
  UpdateServiceSchema,
  VendorServiceQuerySchema,
  type CreateServiceDto,
  type UpdateServiceDto,
  type VendorServiceQuery,
} from './catalog.dto';

/**
 * A vendor managing their own services.
 *
 * No controller-level prefix, because these routes live under two different roots -
 * `/vendors/me/services` for the owner's list and `/services` for the mutations, which is
 * where the resource actually lives. Splitting them into two classes purely to satisfy a
 * prefix would put the same five dependencies in two files.
 *
 * Every route carries @RequireApprovedVendor, including delete and unpublish which the
 * plan left open. A rejected vendor has nothing to withdraw - VendorsService.reject
 * already suspended their published services - and "you may not edit but you may delete"
 * is a distinction with no use case behind it.
 */
@Controller()
export class VendorServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get('vendors/me/services')
  @RequirePermissions('service.read')
  @RequireApprovedVendor()
  listOwn(@Req() req: Request, @Query(zodBody(VendorServiceQuerySchema)) query: VendorServiceQuery) {
    return this.services.listOwn(vendorId(req), query);
  }

  @Post('services')
  @RequirePermissions('service.create')
  @RequireApprovedVendor()
  @HttpCode(201)
  create(@Req() req: Request, @Body(zodBody(CreateServiceSchema)) dto: CreateServiceDto) {
    return this.services.create(vendorId(req), dto);
  }

  @Patch('services/:id')
  @RequirePermissions('service.update')
  @RequireApprovedVendor()
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(UpdateServiceSchema)) dto: UpdateServiceDto,
  ) {
    return this.services.update(vendorId(req), id, dto);
  }

  // 200, not Nest's default 201 for POST. These are transitions on a service that already
  // exists and keeps its URI - 201 would tell a client something was created and, per the
  // spec, that a Location header points at it.
  @Post('services/:id/publish')
  @RequirePermissions('service.publish')
  @RequireApprovedVendor()
  @HttpCode(200)
  publish(@Req() req: Request, @Param('id') id: string) {
    return this.services.publish(vendorId(req), id);
  }

  @Post('services/:id/unpublish')
  @RequirePermissions('service.publish')
  @RequireApprovedVendor()
  @HttpCode(200)
  unpublish(@Req() req: Request, @Param('id') id: string) {
    return this.services.unpublish(vendorId(req), id);
  }

  @Delete('services/:id')
  @RequirePermissions('service.delete')
  @RequireApprovedVendor()
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.services.remove(vendorId(req), id);
  }
}

/**
 * Set by ApprovedVendorGuard, which has already refused anyone without an approved
 * profile. Throwing rather than asserting non-null keeps a future route that forgets
 * @RequireApprovedVendor from silently reading `undefined` into a scoped query - which
 * would match nothing rather than everything, but would be a confusing 404 instead of a
 * clear failure.
 */
function vendorId(req: Request): string {
  if (!req.vendorProfileId) throw Errors.notAVendor();
  return req.vendorProfileId;
}
