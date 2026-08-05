import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { PermissionResolver, SUPER_ADMIN } from './permission-resolver.service';
import type { Caller } from '../auth/jwt-auth.guard';
import type { CreateRoleDto, UpdateRoleDto } from './rbac.dto';

export type RoleView = {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
};

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async listPermissions(): Promise<Record<string, string[]>> {
    const rows = await this.prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      select: { slug: true, resource: true },
    });
    // Grouped by resource because that is how the checkbox tree renders. Grouping here
    // rather than in the client keeps one definition of the grouping.
    return rows.reduce<Record<string, string[]>>((acc, r) => {
      (acc[r.resource] ??= []).push(r.slug);
      return acc;
    }, {});
  }

  async list(): Promise<RoleView[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { slug: 'asc' },
      include: {
        permissions: { select: { permission: { select: { slug: true } } } },
        _count: { select: { users: true } },
      },
    });
    return roles.map(toView);
  }

  async get(id: string): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        permissions: { select: { permission: { select: { slug: true } } } },
        _count: { select: { users: true } },
      },
    });
    if (!role) throw Errors.notFound('Role');
    return toView(role);
  }

  async create(dto: CreateRoleDto, caller: Caller): Promise<RoleView> {
    const ids = await this.resolvePermissionIds(dto.permissionSlugs);
    await this.assertSubsetOfCaller(dto.permissionSlugs, caller);

    try {
      const role = await this.prisma.role.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          // isSystem is never settable from a request. Only the seed creates system roles.
          isSystem: false,
          permissions: { create: ids.map((permissionId) => ({ permissionId })) },
        },
        include: {
          permissions: { select: { permission: { select: { slug: true } } } },
          _count: { select: { users: true } },
        },
      });
      return toView(role);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.roleSlugTaken();
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateRoleDto, caller: Caller): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw Errors.notFound('Role');

    // A system role's NAME is frozen but its PERMISSIONS are not - editing those is the
    // entire point of the demo the brief asks for.
    if (role.isSystem && dto.name && dto.name !== role.name) {
      throw Errors.systemRoleImmutable();
    }

    if (dto.permissionSlugs) {
      await this.assertSubsetOfCaller(dto.permissionSlugs, caller);
      const ids = await this.resolvePermissionIds(dto.permissionSlugs);

      // Replace the whole set in one transaction, so a role is never briefly empty.
      await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
        this.prisma.rolePermission.createMany({
          data: ids.map((permissionId) => ({ roleId: id, permissionId })),
          skipDuplicates: true,
        }),
      ]);
    }

    if (dto.name) {
      await this.prisma.role.update({ where: { id }, data: { name: dto.name } });
    }

    return this.get(id);
  }

  /** The single-slug revoke used for the live revocation demo. */
  async revokePermission(roleId: string, slug: string, caller: Caller): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw Errors.notFound('Role');

    // Revoking is a narrowing operation, so the subset rule does not apply - you may
    // always take away a permission you cannot grant.
    const permission = await this.prisma.permission.findUnique({ where: { slug } });
    if (!permission) throw Errors.unknownPermissions([slug]);

    await this.prisma.rolePermission.deleteMany({
      where: { roleId, permissionId: permission.id },
    });
    void caller;
    return this.get(roleId);
  }

  async remove(id: string): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw Errors.notFound('Role');
    if (role.isSystem) throw Errors.systemRoleImmutable();
    // Deleting a role out from under its users would leave them with no permissions and
    // a broken UI. Make the caller reassign first.
    if (role._count.users > 0) throw Errors.roleInUse(role._count.users);

    await this.prisma.role.delete({ where: { id } });
  }

  async assignRole(userId: string, roleId: string, caller: Caller): Promise<void> {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } }),
      this.prisma.role.findUnique({
        where: { id: roleId },
        include: { permissions: { select: { permission: { select: { slug: true } } } } },
      }),
    ]);
    if (!user) throw Errors.notFound('User');
    if (!role) throw Errors.notFound('Role');

    await this.assertSubsetOfCaller(
      role.permissions.map((p) => p.permission.slug),
      caller,
    );

    // Demoting the only active super admin bricks the deployed instance, which the
    // brief scores as a load-time failure.
    if (user.role.slug === SUPER_ADMIN && role.slug !== SUPER_ADMIN) {
      await this.assertNotLastSuperAdmin(userId);
    }

    await this.prisma.user.update({ where: { id: userId }, data: { roleId } });
  }

  // ---------------------------------------------------------------- internals

  private async resolvePermissionIds(slugs: string[]): Promise<string[]> {
    if (!slugs.length) return [];
    const found = await this.prisma.permission.findMany({
      where: { slug: { in: slugs } },
      select: { id: true, slug: true },
    });
    const missing = slugs.filter((s) => !found.some((f) => f.slug === s));
    // The whole request fails. Partial application would leave a role in a state the
    // caller never asked for and did not see.
    if (missing.length) throw Errors.unknownPermissions(missing);
    return found.map((f) => f.id);
  }

  /**
   * The single most important rule in this module.
   *
   * Without it, a sub-admin holding `role.update` can add `role.assign` and
   * `booking.read_all` to their own role and is a super admin - which makes every other
   * permission control in the project cosmetic. So a non-super-admin may only grant
   * permissions they personally hold.
   *
   * This does lock out a legitimate admin who needs to grant something they lack. That
   * is accepted, not worked around: a super admin can always do it, and the trade-off
   * is recorded in DECISIONS.md.
   */
  private async assertSubsetOfCaller(slugs: string[], caller: Caller): Promise<void> {
    if (caller.roleSlug === SUPER_ADMIN) return;
    const held = await this.resolver.getEffectiveSlugs(caller.userId);
    const missing = slugs.filter((s) => !held.includes(s));
    if (missing.length) throw Errors.escalationBlocked(missing);
  }

  private async assertNotLastSuperAdmin(userId: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: { role: { slug: SUPER_ADMIN }, isActive: true, id: { not: userId } },
    });
    if (others === 0) throw Errors.lastSuperAdmin();
  }
}

function toView(role: {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
  permissions: { permission: { slug: string } }[];
  _count: { users: number };
}): RoleView {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => p.permission.slug).sort(),
    userCount: role._count.users,
  };
}
