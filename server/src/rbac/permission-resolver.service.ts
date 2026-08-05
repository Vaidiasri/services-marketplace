import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaService } from '../prisma/prisma.service';

export const SUPER_ADMIN = 'SUPER_ADMIN';

type RequestScope = { slugs?: Map<string, string[]> };

/**
 * The only place RolePermission is read. Also backs GET /me, so the guard and the
 * client can never disagree about what a user holds.
 */
@Injectable()
export class PermissionResolver {
  // Memoised per request, keyed by user id, so a request passing three guards makes one
  // query. There is deliberately NO cross-request cache: a 30-second cache would make
  // the brief's live revocation check appear broken for 30 seconds, and that check is
  // worth more than the query it would save.
  private readonly als = new AsyncLocalStorage<RequestScope>();

  constructor(private readonly prisma: PrismaService) {}

  runInRequestScope<T>(fn: () => T): T {
    return this.als.run({}, fn);
  }

  async getEffectiveSlugs(userId: string): Promise<string[]> {
    const store = this.als.getStore();
    const cached = store?.slugs?.get(userId);
    if (cached) return cached;

    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { users: { some: { id: userId } } } },
      select: { permission: { select: { slug: true } } },
    });
    const slugs = rows.map((r) => r.permission.slug).sort();

    if (store) {
      store.slugs ??= new Map();
      store.slugs.set(userId, slugs);
    }
    return slugs;
  }

  /**
   * SUPER_ADMIN holds no rows by design - the bypass is a role-slug short-circuit.
   * Holding-all-slugs stops being "all" the moment a permission is added, and the brief
   * says it bypasses every check.
   */
  isSuperAdmin(roleSlug: string): boolean {
    return roleSlug === SUPER_ADMIN;
  }
}
