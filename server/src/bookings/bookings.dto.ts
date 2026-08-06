import { z } from 'zod';
import { PageQuerySchema } from '../common/pagination';

/**
 * Note what is ABSENT from every schema below: `priceMinor`, `status`, `customerUserId`,
 * `vendorProfileId`, `cancellationFeeMinor`. Combined with `.strict()`, sending any of them
 * is a 422 rather than something quietly trusted. That is the structural answer to the
 * brief's "prices, discounts or roles trusted from the request body" deduction - the fields
 * do not exist at the boundary, so there is nothing to remember to strip.
 */
export const CreateBookingSchema = z
  .object({
    serviceId: z.string().cuid(),
    offeringId: z.string().cuid(),
    // An instant, not a local time. The client picked it from the slots endpoint, which
    // returns UTC - and it must match a generated slot start exactly.
    startUtc: z.string().datetime(),
    paymentMode: z.enum(['PAY_NOW', 'PAY_AFTER']),
  })
  .strict();

export const RescheduleSchema = z.object({ startUtc: z.string().datetime() }).strict();

export const CancelSchema = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict();

/** The brief requires a reason whenever a vendor or admin acts against the customer. */
export const ReasonRequiredSchema = z
  .object({
    reason: z.string().trim().min(10, 'Give at least 10 characters explaining why').max(1000),
  })
  .strict();

export const BookingQuerySchema = PageQuerySchema.extend({
  status: z
    .enum(['PENDING', 'CONFIRMED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();

export const AdminBookingQuerySchema = BookingQuerySchema.extend({
  vendorId: z.string().cuid().optional(),
  customerId: z.string().cuid().optional(),
}).strict();

export type CreateBookingDto = z.infer<typeof CreateBookingSchema>;
export type RescheduleDto = z.infer<typeof RescheduleSchema>;
export type CancelDto = z.infer<typeof CancelSchema>;
export type ReasonRequiredDto = z.infer<typeof ReasonRequiredSchema>;
export type BookingQuery = z.infer<typeof BookingQuerySchema>;
export type AdminBookingQuery = z.infer<typeof AdminBookingQuerySchema>;
