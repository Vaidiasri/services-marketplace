import { z } from 'zod';
import { isIanaTimezone } from '../auth/dto';
import { PageQuerySchema } from '../common/pagination';

/**
 * Fields an APPROVED vendor may still change.
 *
 * The plan originally locked the whole profile once approved, which is a dead end: no
 * admin edit route exists, and `timezone` lives here. A vendor approved with the wrong
 * timezone would have every slot on every one of their services computed wrongly,
 * silently, with no way to fix it.
 *
 * So the lock covers only what approval was actually granted against - the business
 * identity and address a reviewer checked. Contact details and timezone stay editable,
 * because getting those wrong is an operational mistake rather than a way to launder an
 * approval. Recorded in DECISIONS.md as a judgement call.
 */
export const APPROVED_LOCKED_FIELDS = [
  'businessName',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
] as const;

export const UpdateVendorProfileSchema = z
  .object({
    businessName: z.string().trim().min(1).max(160).optional(),
    contactName: z.string().trim().min(1).max(120).optional(),
    contactPhone: z.string().trim().min(5).max(32).optional(),
    addressLine1: z.string().trim().min(1).max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    postalCode: z.string().trim().min(1).max(20).optional(),
    timezone: z.string().refine(isIanaTimezone, 'Not a recognised IANA timezone').optional(),
  })
  .strict()
  // status, rejectionReason and reviewedBy are absent from this schema, so .strict()
  // rejects any attempt to send them. A vendor cannot approve themselves by PATCH.
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field to update');

export const UploadDocumentSchema = z
  .object({
    // Free text rather than an enum: the brief does not prescribe document types, and a
    // fixed list would reject a legitimate one a reviewer asks for during the walkthrough.
    kind: z.string().trim().min(1).max(60).default('OTHER'),
  })
  .strict();

/** The brief requires a reason on rejection, so it is not optional. */
export const RejectVendorSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Give the vendor at least 10 characters explaining why')
      .max(1000),
  })
  .strict();

export const AdminVendorQuerySchema = PageQuerySchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  q: z.string().trim().max(120).optional(),
}).strict();

export type UpdateVendorProfileDto = z.infer<typeof UpdateVendorProfileSchema>;
export type UploadDocumentDto = z.infer<typeof UploadDocumentSchema>;
export type RejectVendorDto = z.infer<typeof RejectVendorSchema>;
export type AdminVendorQuery = z.infer<typeof AdminVendorQuerySchema>;
