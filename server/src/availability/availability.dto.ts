import { z } from 'zod';
import { MINUTES_IN_DAY } from '../common/time';

/** The cap the plan sets, and the reason the slots endpoint needs no pagination. */
export const MAX_RANGE_DAYS = 62;

/** How far ahead the slots endpoint looks when the caller gives no range. */
export const DEFAULT_RANGE_DAYS = 14;

/**
 * A local calendar date, never an instant.
 *
 * `from=2026-08-10` means the vendor's local day. Treated as UTC it would be the wrong day
 * for a customer far enough east or west, which is the sort of off-by-one nobody notices
 * until a booking lands on the wrong date.
 */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a local calendar date, YYYY-MM-DD');

const minuteOfDay = z.number().int().min(0).max(MINUTES_IN_DAY);

const RuleSchema = z
  .object({
    // 0 = Sunday, matching AvailabilityRule.weekday in the schema.
    weekday: z.number().int().min(0).max(6),
    startMinute: minuteOfDay,
    endMinute: minuteOfDay,
    // Capacity is how many bookings may share one slot, so zero would mean "open but
    // unbookable" - a state with no use, and one that reads as a mistake.
    capacity: z.number().int().min(1).max(1000),
  })
  .strict();

/**
 * Full replacement rather than per-rule CRUD.
 *
 * A weekly schedule is edited as a whole - the vendor drags windows around and saves - and
 * replacement means the client never has to compute which rows to create, update and
 * delete. It also makes the request idempotent.
 *
 * Overlapping windows on the same weekday are accepted, not rejected: the generator lays
 * them on a shared grid and takes the roomiest capacity per cell. Documented as a decision
 * rather than left as an oversight.
 */
export const ReplaceRulesSchema = z
  .object({
    rules: z.array(RuleSchema).max(100),
  })
  .strict();

export const CreateExceptionSchema = z
  .object({
    date: localDate,
    type: z.enum(['CLOSURE', 'OPEN_WINDOW']),
    startMinute: minuteOfDay.optional(),
    endMinute: minuteOfDay.optional(),
    capacity: z.number().int().min(1).max(1000).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  // An OPEN_WINDOW with no window is meaningless; a CLOSURE with one is a contradiction.
  // Caught here rather than in the service so the message names the field.
  .refine((e) => e.type !== 'OPEN_WINDOW' || (e.startMinute !== undefined && e.endMinute !== undefined), {
    message: 'An OPEN_WINDOW needs startMinute and endMinute',
    path: ['startMinute'],
  })
  .refine((e) => e.type !== 'CLOSURE' || (e.startMinute === undefined && e.endMinute === undefined), {
    message: 'A CLOSURE covers the whole date, so it takes no window',
    path: ['startMinute'],
  });

export const ExceptionQuerySchema = z
  .object({ from: localDate.optional(), to: localDate.optional() })
  .strict();

export const SlotQuerySchema = z
  .object({
    // Required, because duration is an input to the arithmetic. Absent, there is no
    // correct answer to give - so 422 rather than a guess at the cheapest offering.
    offeringId: z.string().cuid().optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .strict();

export const NextAvailableQuerySchema = z
  .object({ offeringId: z.string().cuid().optional() })
  .strict();

export type ReplaceRulesDto = z.infer<typeof ReplaceRulesSchema>;
export type CreateExceptionDto = z.infer<typeof CreateExceptionSchema>;
export type ExceptionQuery = z.infer<typeof ExceptionQuerySchema>;
export type SlotQuery = z.infer<typeof SlotQuerySchema>;
export type NextAvailableQuery = z.infer<typeof NextAvailableQuerySchema>;
