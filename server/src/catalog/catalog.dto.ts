import { z } from 'zod';
import { PageQuerySchema } from '../common/pagination';

// ---------------------------------------------------------------- categories

export const CreateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    // Two levels only. A third level is refused by the service, not by the schema -
    // whether a parent is itself a child is a database fact, not a shape fact.
    parentId: z.string().cuid().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

/**
 * `parentId` is absent on purpose. Moving a subtree would have to revalidate the depth
 * limit for every descendant and re-slug them, for a feature an admin can achieve by
 * creating the category in the right place.
 */
export const UpdateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field to update');

export const CategoryQuerySchema = z
  .object({
    // Coerced from the string a query parameter always is. `?flat` with no value counts
    // as true, which is how a human types it.
    flat: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .optional()
      .transform((v) => v === 'true' || v === ''),
  })
  .strict();

// ---------------------------------------------------------------- services

const GRANULARITY_CHOICES = [10, 15, 20, 30, 60] as const;

/**
 * Cancellation policy is required, not defaulted.
 *
 * The columns carry defaults so old rows stay valid, but a vendor creating a service
 * states its policy explicitly - inheriting "50% inside 24 hours" silently is the kind
 * of term a customer later disputes, and the brief makes the policy per service.
 */
const ServiceBody = {
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(4000),
  categoryId: z.string().cuid(),
  slotGranularityMinutes: z
    .number()
    .int()
    .refine((n) => (GRANULARITY_CHOICES as readonly number[]).includes(n), {
      message: `Must be one of ${GRANULARITY_CHOICES.join(', ')} minutes`,
    })
    .optional(),
  freeCancellationHours: z.number().int().min(0).max(720),
  cancellationFeePercent: z.number().int().min(0).max(100),
};

export const CreateServiceSchema = z.object(ServiceBody).strict();

/**
 * `status` is absent, and `.strict()` turns sending it into a 422. That is what stops a
 * vendor publishing - or unsuspending themselves - with a PATCH. Status only ever moves
 * through the dedicated publish/unpublish/suspend routes, each with its own permission.
 */
export const UpdateServiceSchema = z
  .object({
    title: ServiceBody.title.optional(),
    description: ServiceBody.description.optional(),
    categoryId: ServiceBody.categoryId.optional(),
    slotGranularityMinutes: ServiceBody.slotGranularityMinutes,
    freeCancellationHours: ServiceBody.freeCancellationHours.optional(),
    cancellationFeePercent: ServiceBody.cancellationFeePercent.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field to update');

/**
 * The sort allowlist is `createdAt` and `title` only.
 *
 * The plan also listed `minPrice`. Prisma cannot order by an aggregate over a relation,
 * so it would need the page's ids resolved by raw SQL and then re-ordered - a second
 * query path around the visibility builder, which is the one thing this module refuses
 * to have. Price *filtering* is the part the brief grades and it is supported below.
 * Recorded in DECISIONS.md.
 */
export const PublicServiceQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().min(1).max(120).optional(),
  categoryId: z.string().cuid().optional(),
  minPriceMinor: z.coerce.number().int().min(0).optional(),
  maxPriceMinor: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['createdAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})
  .strict()
  .refine(
    (q) =>
      q.minPriceMinor === undefined ||
      q.maxPriceMinor === undefined ||
      q.minPriceMinor <= q.maxPriceMinor,
    { message: 'minPriceMinor cannot exceed maxPriceMinor', path: ['minPriceMinor'] },
  );

export const VendorServiceQuerySchema = PageQuerySchema.extend({
  status: z.enum(['DRAFT', 'PUBLISHED', 'SUSPENDED']).optional(),
}).strict();

export const AdminServiceQuerySchema = PageQuerySchema.extend({
  status: z.enum(['DRAFT', 'PUBLISHED', 'SUSPENDED']).optional(),
  vendorId: z.string().cuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
}).strict();

/** The brief requires a reason on every admin action that restricts a vendor. */
export const SuspendServiceSchema = z
  .object({
    reason: z.string().trim().min(10, 'Give at least 10 characters explaining why').max(1000),
  })
  .strict();

// ---------------------------------------------------------------- offerings

export const CreateOfferingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    durationMinutes: z.number().int().min(5).max(1440),
    // Minor units, integer. There is no Float anywhere in this codebase, and a price
    // arriving as 19.99 would be a 422 rather than something rounded silently.
    priceMinor: z.number().int().min(0).max(100_000_000),
    currency: z.string().trim().length(3).toUpperCase().optional(),
  })
  .strict();

export const UpdateOfferingSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    priceMinor: z.number().int().min(0).max(100_000_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field to update');

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;
export type CategoryQuery = z.infer<typeof CategoryQuerySchema>;
export type CreateServiceDto = z.infer<typeof CreateServiceSchema>;
export type UpdateServiceDto = z.infer<typeof UpdateServiceSchema>;
export type PublicServiceQuery = z.infer<typeof PublicServiceQuerySchema>;
export type VendorServiceQuery = z.infer<typeof VendorServiceQuerySchema>;
export type AdminServiceQuery = z.infer<typeof AdminServiceQuerySchema>;
export type SuspendServiceDto = z.infer<typeof SuspendServiceSchema>;
export type CreateOfferingDto = z.infer<typeof CreateOfferingSchema>;
export type UpdateOfferingDto = z.infer<typeof UpdateOfferingSchema>;
