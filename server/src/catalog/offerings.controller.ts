import { Body, Controller, Delete, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequireApprovedVendor } from '../vendors/require-approved-vendor.decorator';
import { OfferingsService } from './offerings.service';
import {
  CreateOfferingSchema,
  UpdateOfferingSchema,
  type CreateOfferingDto,
  type UpdateOfferingDto,
} from './catalog.dto';

/**
 * Offering writes. Reads live on the public services controller, because whether an
 * offering is visible is a question about its service.
 *
 * No controller prefix: creation nests under its service, while update and delete address
 * the offering directly by an id that is already globally unique.
 */
@Controller()
export class OfferingsController {
  constructor(private readonly offerings: OfferingsService) {}

  @Post('services/:id/offerings')
  @RequirePermissions('offering.create')
  @RequireApprovedVendor()
  @HttpCode(201)
  create(
    @Req() req: Request,
    @Param('id') serviceId: string,
    @Body(zodBody(CreateOfferingSchema)) dto: CreateOfferingDto,
  ) {
    return this.offerings.create(vendorId(req), serviceId, dto);
  }

  @Patch('offerings/:id')
  @RequirePermissions('offering.update')
  @RequireApprovedVendor()
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(UpdateOfferingSchema)) dto: UpdateOfferingDto,
  ) {
    return this.offerings.update(vendorId(req), id, dto);
  }

  @Delete('offerings/:id')
  @RequirePermissions('offering.delete')
  @RequireApprovedVendor()
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.offerings.remove(vendorId(req), id);
  }
}

function vendorId(req: Request): string {
  if (!req.vendorProfileId) throw Errors.notAVendor();
  return req.vendorProfileId;
}
