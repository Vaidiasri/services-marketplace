import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import type { CreateCategoryDto, UpdateCategoryDto } from './catalog.dto';

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  parentId: true,
  isActive: true,
  sortOrder: true,
} satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;
type CategoryNode = CategoryRow & { children: CategoryRow[] };

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the whole tree in one query and assembles it in memory. Two levels means
   * there is no recursion to write: parents are the rows with a null parentId, and every
   * other row is somebody's child.
   */
  async list(flat: boolean): Promise<CategoryRow[] | CategoryNode[]> {
    const rows = await this.prisma.category.findMany({
      select: CATEGORY_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (flat) return rows;

    const byParent = new Map<string, CategoryRow[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const siblings = byParent.get(row.parentId) ?? [];
      siblings.push(row);
      byParent.set(row.parentId, siblings);
    }

    return rows
      .filter((r) => !r.parentId)
      .map((r) => ({ ...r, children: byParent.get(r.id) ?? [] }));
  }

  async create(dto: CreateCategoryDto): Promise<CategoryRow> {
    let parentSlug: string | null = null;

    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentId },
        select: { id: true, slug: true, parentId: true },
      });
      if (!parent) throw Errors.categoryInvalid();
      // The whole depth rule, in one line. A category that already has a parent cannot
      // become one - which is the two-level limit, enforced here rather than by a
      // database trigger that would cost more than it saves.
      if (parent.parentId) throw Errors.categoryDepthExceeded();
      parentSlug = parent.slug;
    }

    await this.assertNameFreeAmongSiblings(dto.name, dto.parentId ?? null);

    return this.prisma.category.create({
      data: {
        name: dto.name,
        slug: await this.uniqueSlug(dto.name, parentSlug),
        parentId: dto.parentId ?? null,
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
      },
      select: CATEGORY_SELECT,
    });
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryRow> {
    const current = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true, parentId: true },
    });
    if (!current) throw Errors.notFound('Category');

    if (dto.name && dto.name !== current.name) {
      await this.assertNameFreeAmongSiblings(dto.name, current.parentId, id);
    }

    // The slug is deliberately NOT regenerated on rename. It is a stable public
    // identifier; changing it would break any link a customer saved.
    return this.prisma.category.update({ where: { id }, data: dto, select: CATEGORY_SELECT });
  }

  async remove(id: string): Promise<void> {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true, _count: { select: { children: true, services: true } } },
    });
    if (!category) throw Errors.notFound('Category');

    const { children, services } = category._count;
    // Refused rather than cascaded. Deleting a category that services point at would
    // either orphan them or delete a vendor's work as a side effect of an admin tidying
    // up a taxonomy. The counts go back so the admin knows what is in the way.
    if (children > 0 || services > 0) throw Errors.categoryInUse(children, services);

    await this.prisma.category.delete({ where: { id } });
  }

  // ---------------------------------------------------------------- internals

  /**
   * The plan asked for 409 on a name collision "at the same level", which the schema
   * cannot express: `slug` is globally unique and `parentId` is nullable, so a unique
   * constraint on (name, parentId) would not even catch two top-level duplicates -
   * Postgres treats NULLs as distinct.
   *
   * So the readable 409 comes from this check, and the globally-unique slug remains the
   * backstop that makes the check safe under a concurrent double-create: two admins
   * racing both pass here, and the second one loses on the slug's unique index rather
   * than creating a duplicate.
   */
  private async assertNameFreeAmongSiblings(
    name: string,
    parentId: string | null,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: {
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw Errors.categoryExists(name);
  }

  /**
   * Slugs are parent-prefixed - `beauty-salon`, not `salon`.
   *
   * Without the prefix, "Salon" under Beauty and "Salon" under Home Care would collide on
   * the global unique index even though they are legitimately different categories, and
   * the second create would fail with a raw Prisma error instead of anything meaningful.
   */
  private async uniqueSlug(name: string, parentSlug: string | null): Promise<string> {
    const base = [parentSlug, slugify(name)].filter(Boolean).join('-');

    const taken = await this.prisma.category.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    if (!taken.some((c) => c.slug === base)) return base;

    // Only reached when a category was renamed into a slug another one already owns.
    for (let n = 2; n < 100; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.some((c) => c.slug === candidate)) return candidate;
    }
    throw Errors.categoryExists(name);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
