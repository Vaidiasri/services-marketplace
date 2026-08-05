import { Body, Controller, Get, Param, Patch, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { zodBody } from '../common/zod.pipe';
import { Errors } from '../common/errors';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { VendorsService } from './vendors.service';
import { streamAttachment } from './vendors.controller';
import {
  AdminVendorQuerySchema,
  RejectVendorSchema,
  type AdminVendorQuery,
  type RejectVendorDto,
} from './vendors.dto';

/**
 * The approval queue. Split from VendorsController rather than merged, because the two
 * have opposite ownership rules - everything here reads across all vendors and so is
 * gated on the `*_all` permissions, which only admin roles hold.
 *
 * Note `vendor.approve` and `vendor.reject` are not in the VENDOR role, so a vendor
 * calling approve on their own id is refused by the permission gate before the vendor
 * status gate is even consulted.
 */
@Controller('admin/vendors')
export class AdminVendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @RequirePermissions('vendor.read_all')
  list(@Query(zodBody(AdminVendorQuerySchema)) query: AdminVendorQuery) {
    return this.vendors.listForAdmin(query);
  }

  @Get(':id')
  @RequirePermissions('vendor.read_all')
  get(@Param('id') id: string) {
    return this.vendors.getForAdmin(id);
  }

  @Get(':id/documents/:docId/download')
  @RequirePermissions('vendor.read_all')
  async download(@Param('docId') docId: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.vendors.resolveDocumentPath(caller(req), docId, { readAll: true });
    streamAttachment(res, file);
  }

  @Patch(':id/approve')
  @RequirePermissions('vendor.approve')
  approve(@Param('id') id: string, @Req() req: Request) {
    return this.vendors.approve(id, caller(req));
  }

  @Patch(':id/reject')
  @RequirePermissions('vendor.reject')
  reject(
    @Param('id') id: string,
    @Body(zodBody(RejectVendorSchema)) dto: RejectVendorDto,
    @Req() req: Request,
  ) {
    return this.vendors.reject(id, dto.reason, caller(req));
  }
}

function caller(req: Request) {
  if (!req.caller) throw Errors.unauthenticated();
  return req.caller;
}
