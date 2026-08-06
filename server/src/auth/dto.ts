import { z } from 'zod';
import { isIanaTimezone } from '../common/time';

/**
 * Every schema is `.strict()`. An unexpected key is a 422 rather than being ignored,
 * which is what makes "prices, discounts or roles trusted from the request body"
 * structurally impossible rather than a matter of remembering to strip them.
 *
 * Note there is no `role`, `roleId` or `permissions` field anywhere below. Role is set
 * server-side from the route: /register/customer means CUSTOMER, /register/vendor means
 * VENDOR. Admins are not self-registerable at all.
 */

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const fullName = z.string().trim().min(1).max(120);

export const RegisterCustomerSchema = z
  .object({ email, password, fullName })
  .strict();

export const RegisterVendorSchema = z
  .object({
    email,
    password,
    fullName,
    businessName: z.string().trim().min(1).max(160),
    contactName: z.string().trim().min(1).max(120),
    contactPhone: z.string().trim().min(5).max(32),
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(20),
    // Validated against the runtime's own tz database rather than a hand-kept list,
    // so a plausible-looking but non-existent zone cannot be stored and then break
    // every slot calculation for that vendor.
    timezone: z.string().refine(isIanaTimezone, 'Not a recognised IANA timezone'),
  })
  .strict();

export const LoginSchema = z.object({ email, password }).strict();

export type RegisterCustomerDto = z.infer<typeof RegisterCustomerSchema>;
export type RegisterVendorDto = z.infer<typeof RegisterVendorSchema>;
export type LoginDto = z.infer<typeof LoginSchema>;

/**
 * Re-exported from common/time.ts, which is the one file allowed to reason about zones.
 *
 * The previous implementation here only asked whether Intl would accept the string, which
 * accepts the abbreviation `EST` - resolved by ICU to a fixed UTC-5 zone that never
 * observes daylight saving. See the note on isIanaTimezone for why that is a silent
 * hour-wrong-for-eight-months bug rather than a cosmetic validation gap.
 */
export { isIanaTimezone };
