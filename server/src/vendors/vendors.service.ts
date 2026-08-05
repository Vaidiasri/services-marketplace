import { Injectable, Logger } from '@nestjs/common';
import { Prisma, VendorStatus } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { paginated, toSkipTake, type Paginated } from '../common/pagination';
import type { Caller } from '../auth/jwt-auth.guard';
import { assertOwnership } from '../rbac/ownership';
import { SUPER_ADMIN } from '../rbac/permission-resolver.service';
import { magicBytesMatch, UPLOAD_DIR, ALLOWED_MIME } from './upload.config';
import {
  APPROVED_LOCKED_FIELDS,
  type AdminVendorQuery,
  type UpdateVendorProfileDto,
} from './vendors.dto';

const PROFILE_SELECT = {
  id: true,
  businessName: true,
  contactName: true,
  contactPhone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  timezone: true,
  status: true,
  rejectionReason: true,
  reviewedAt: true,
  createdAt: true,
  documents: {
    select: {
      id: true,
      kind: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.VendorProfileSelect;

@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- vendor's own

  async getOwnProfile(caller: Caller) {
    const profile = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: PROFILE_SELECT,
    });
    if (!profile) throw Errors.notAVendor();
    return profile;
  }

  async updateOwnProfile(caller: Caller, dto: UpdateVendorProfileDto) {
    const current = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: { id: true, status: true },
    });
    if (!current) throw Errors.notAVendor();

    if (current.status === VendorStatus.APPROVED) {
      const locked = APPROVED_LOCKED_FIELDS.filter((f) => dto[f] !== undefined);
      if (locked.length) throw Errors.profileLocked([...locked]);
    }

    // Editing after a rejection returns the application to the queue and clears the old
    // reason, so a rejected vendor with a fixable problem is not a dead account. Without
    // this the vendor would edit, see REJECTED with a stale reason, and have no way back.
    const reopen =
      current.status === VendorStatus.REJECTED
        ? {
            status: VendorStatus.PENDING,
            rejectionReason: null,
            reviewedByUserId: null,
            reviewedAt: null,
          }
        : {};

    return this.prisma.vendorProfile.update({
      where: { id: current.id },
      data: { ...dto, ...reopen },
      select: PROFILE_SELECT,
    });
  }

  // ---------------------------------------------------------------- documents

  /**
   * The row is written only after the file is on disk and its bytes have been checked,
   * so a failed or forged upload never leaves a database row pointing at nothing.
   */
  async attachDocument(
    caller: Caller,
    file: Express.Multer.File,
    kind: string,
  ) {
    const profile = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: { id: true, status: true },
    });

    if (!profile) {
      await this.discard(file.path);
      throw Errors.notAVendor();
    }
    // Documents are the evidence for a decision already made, so an approved profile's
    // set is frozen - otherwise the paperwork behind an approval can be swapped later.
    if (profile.status === VendorStatus.APPROVED) {
      await this.discard(file.path);
      throw Errors.profileLocked(['documents']);
    }

    if (!magicBytesMatch(file.path, file.mimetype)) {
      // Delete first, then reject. Leaving a rejected file on disk is how an upload
      // endpoint becomes free storage for arbitrary content.
      await this.discard(file.path);
      throw Errors.unsupportedFileType(ALLOWED_MIME);
    }

    return this.prisma.vendorDocument.create({
      data: {
        vendorProfileId: profile.id,
        kind,
        originalFilename: file.originalname,
        storedFilename: file.filename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      },
      select: { id: true, kind: true, originalFilename: true, sizeBytes: true, createdAt: true },
    });
  }

  async removeDocument(caller: Caller, documentId: string): Promise<void> {
    const doc = await this.loadOwnDocument(caller, documentId);
    if (doc.vendorProfile.status === VendorStatus.APPROVED) {
      throw Errors.profileLocked(['documents']);
    }

    await this.prisma.vendorDocument.delete({ where: { id: doc.id } });
    // Row first, file second. The reverse order can leave a row whose file is gone,
    // which downloads as a 410 for something the vendor believes still exists.
    await this.discard(join(UPLOAD_DIR, doc.storedFilename));
  }

  /**
   * `readAll` lets an admin fetch any vendor's document through the same path, so there
   * is one place that resolves a document to a file and one place that decides access.
   */
  async resolveDocumentPath(
    caller: Caller,
    documentId: string,
    opts: { readAll?: boolean } = {},
  ): Promise<{ path: string; filename: string; mimeType: string }> {
    const doc = opts.readAll
      ? await this.prisma.vendorDocument.findUnique({
          where: { id: documentId },
          include: { vendorProfile: { select: { id: true, status: true, userId: true } } },
        })
      : await this.loadOwnDocument(caller, documentId);

    if (!doc) throw Errors.notFound('Document');

    const path = join(UPLOAD_DIR, doc.storedFilename);
    // Render's disk is ephemeral, so this is an expected state after a redeploy rather
    // than a bug. 410 tells the client to say "no longer available" instead of erroring.
    if (!existsSync(path)) {
      this.logger.warn(`document ${doc.id} row exists but file is missing: ${doc.storedFilename}`);
      throw Errors.fileGone();
    }

    return { path, filename: doc.originalFilename, mimeType: doc.mimeType };
  }

  // ---------------------------------------------------------------- admin

  async listForAdmin(query: AdminVendorQuery): Promise<Paginated<unknown>> {
    const where: Prisma.VendorProfileWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? { businessName: { contains: query.q, mode: 'insensitive' as const } }
        : {}),
    };

    // Both queries in one transaction so the count and the page describe the same
    // snapshot. Separately, a vendor approved between them makes total disagree with data.
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vendorProfile.findMany({
        where,
        ...toSkipTake(query),
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          businessName: true,
          city: true,
          status: true,
          createdAt: true,
          timezone: true,
          user: { select: { id: true, email: true, fullName: true } },
          _count: { select: { documents: true } },
        },
      }),
      this.prisma.vendorProfile.count({ where }),
    ]);

    return paginated(rows, total, query);
  }

  async getForAdmin(id: string) {
    const profile = await this.prisma.vendorProfile.findUnique({
      where: { id },
      select: { ...PROFILE_SELECT, user: { select: { id: true, email: true, fullName: true } } },
    });
    if (!profile) throw Errors.notFound('Vendor');
    return profile;
  }

  /** Idempotent: re-approving an already-approved vendor is not an error. */
  async approve(id: string, caller: Caller) {
    await this.requireProfile(id);
    return this.prisma.vendorProfile.update({
      where: { id },
      data: {
        status: VendorStatus.APPROVED,
        rejectionReason: null,
        reviewedByUserId: caller.userId,
        reviewedAt: new Date(),
      },
      select: PROFILE_SELECT,
    });
  }

  /**
   * Also suspends any live services. This only bites on the approve-then-revoke path,
   * but leaving services PUBLISHED under a rejected vendor would break M4's invariant
   * that the public catalogue shows only approved vendors' services.
   *
   * Confirmed bookings are deliberately untouched: existing obligations survive, new
   * bookings stop. Same rule as service suspension in M4.
   */
  async reject(id: string, reason: string, caller: Caller) {
    await this.requireProfile(id);

    const [profile] = await this.prisma.$transaction([
      this.prisma.vendorProfile.update({
        where: { id },
        data: {
          status: VendorStatus.REJECTED,
          rejectionReason: reason,
          reviewedByUserId: caller.userId,
          reviewedAt: new Date(),
        },
        select: PROFILE_SELECT,
      }),
      this.prisma.service.updateMany({
        where: { vendorProfileId: id, status: 'PUBLISHED' },
        data: { status: 'SUSPENDED', suspensionReason: reason },
      }),
    ]);

    return profile;
  }

  // ---------------------------------------------------------------- internals

  private async requireProfile(id: string): Promise<void> {
    const exists = await this.prisma.vendorProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw Errors.notFound('Vendor');
  }

  private async loadOwnDocument(caller: Caller, documentId: string) {
    const doc = await this.prisma.vendorDocument.findUnique({
      where: { id: documentId },
      include: { vendorProfile: { select: { id: true, status: true, userId: true } } },
    });
    if (!doc) throw Errors.notFound('Document');

    // 404 rather than 403 on a cross-vendor id, so Vendor A cannot use the response to
    // learn that Vendor B's document id exists.
    assertOwnership(
      { userId: doc.vendorProfile.userId },
      caller,
      { notFoundOnMismatch: true, what: 'Document' },
    );

    return doc;
  }

  private async discard(path: string): Promise<void> {
    await unlink(path).catch((err: unknown) => {
      // Worth a log but never worth failing the request: the caller's outcome does not
      // depend on whether a temporary file was cleaned up.
      this.logger.warn(`could not remove upload ${path}: ${String(err)}`);
    });
  }
}

// SUPER_ADMIN is referenced by the guard rather than here; re-exported so callers of this
// service do not need to reach into the rbac module for the constant.
export { SUPER_ADMIN };
