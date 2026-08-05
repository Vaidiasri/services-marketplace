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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { zodBody } from '../common/zod.pipe';
import { Errors } from '../common/errors';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { VendorsService } from './vendors.service';
import { ALLOWED_MIME, multerOptions } from './upload.config';
import {
  UpdateVendorProfileSchema,
  UploadDocumentSchema,
  type UpdateVendorProfileDto,
  type UploadDocumentDto,
} from './vendors.dto';

/**
 * A pending or rejected vendor's entire surface.
 *
 * Deliberately NOT behind @RequireApprovedVendor: these routes are how a vendor learns
 * their status, so gating them on being approved would trap a pending vendor on a screen
 * that cannot load. Ownership is implicit - every route resolves the caller's own
 * profile, so there is no id in the path to tamper with.
 */
@Controller('vendors/me')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @RequirePermissions('vendor.read')
  get(@Req() req: Request) {
    return this.vendors.getOwnProfile(caller(req));
  }

  @Patch()
  @RequirePermissions('vendor.update')
  update(
    @Req() req: Request,
    @Body(zodBody(UpdateVendorProfileSchema)) dto: UpdateVendorProfileDto,
  ) {
    return this.vendors.updateOwnProfile(caller(req), dto);
  }

  @Post('documents')
  @RequirePermissions('vendor.update')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', multerOptions))
  upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query(zodBody(UploadDocumentSchema)) query: UploadDocumentDto,
  ) {
    // multer's fileFilter refuses a disallowed type by simply not producing a file, so an
    // absent file here means either nothing was sent or the declared type was refused.
    if (!file) throw Errors.unsupportedFileType(ALLOWED_MIME);
    return this.vendors.attachDocument(caller(req), file, query.kind);
  }

  @Delete('documents/:id')
  @RequirePermissions('vendor.update')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.vendors.removeDocument(caller(req), id);
  }

  @Get('documents/:id/download')
  @RequirePermissions('vendor.read')
  async download(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.vendors.resolveDocumentPath(caller(req), id);
    streamAttachment(res, file);
  }
}

function caller(req: Request) {
  if (!req.caller) throw Errors.unauthenticated();
  return req.caller;
}

/**
 * Always an attachment, never inline, and with nosniff.
 *
 * A vendor-supplied PDF or image rendered inline would be a stored-XSS vector on the
 * API's own origin. Forcing a download and refusing content sniffing removes it.
 */
export function streamAttachment(
  res: Response,
  file: { path: string; filename: string; mimeType: string },
): void {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The original name is client-supplied, so quote it and strip the characters that
  // would let it break out of the header.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/["\\\r\n]/g, '_')}"`,
  );
  createReadStream(file.path).pipe(res);
}
