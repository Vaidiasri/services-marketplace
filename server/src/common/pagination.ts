import { z } from 'zod';

/** The one list envelope every paginated endpoint returns. See doc/03_API_CONVENTIONS.md. */
export type Paginated<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

const MAX_PAGE_SIZE = 100;

/**
 * Coerced from strings because query parameters always arrive as strings, and clamped
 * rather than rejected: `?pageSize=5000` is a client being greedy, not a malformed
 * request, and answering 422 for it would be pedantic. The clamp is what stops it from
 * being a cheap way to pull the whole table.
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).catch(MAX_PAGE_SIZE).default(20),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export function toSkipTake(q: PageQuery): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function paginated<T>(data: T[], total: number, q: PageQuery): Paginated<T> {
  return {
    data,
    meta: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    },
  };
}
