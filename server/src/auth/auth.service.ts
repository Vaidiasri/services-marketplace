import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PermissionResolver } from '../rbac/permission-resolver.service';
import type { LoginDto, RegisterCustomerDto, RegisterVendorDto } from './dto';

export type PublicUser = {
  id: string;
  email: string;
  fullName: string;
  role: { slug: string; name: string };
};

export type MeResponse = PublicUser & {
  permissions: string[];
  vendorProfile?: { id: string; status: string; rejectionReason: string | null; timezone: string };
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly resolver: PermissionResolver,
  ) {}

  async registerCustomer(dto: RegisterCustomerDto): Promise<{ user: PublicUser; access: string; refresh: string }> {
    // Role comes from the route, never the body. There is no code path by which a
    // registration request can choose its own role.
    const role = await this.requireRole('CUSTOMER');
    const passwordHash = await this.passwords.hash(dto.password);

    const user = await this.createUser({
      email: dto.email,
      fullName: dto.fullName,
      passwordHash,
      roleId: role.id,
    });

    return this.session(user.id, role.slug, { ...user, role });
  }

  async registerVendor(dto: RegisterVendorDto): Promise<{
    user: PublicUser;
    vendorProfile: { id: string; status: string };
    access: string;
    refresh: string;
  }> {
    const role = await this.requireRole('VENDOR');
    const passwordHash = await this.passwords.hash(dto.password);

    // One transaction. A crash between the two writes would leave a vendor who can
    // sign in but has no profile, and therefore no status page and no way forward.
    const created = await this.tx(() =>
      this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email,
            fullName: dto.fullName,
            passwordHash,
            roleId: role.id,
          },
          select: { id: true, email: true, fullName: true },
        });
        const profile = await tx.vendorProfile.create({
          data: {
            userId: user.id,
            businessName: dto.businessName,
            contactName: dto.contactName,
            contactPhone: dto.contactPhone,
            addressLine1: dto.addressLine1,
            addressLine2: dto.addressLine2,
            city: dto.city,
            state: dto.state,
            postalCode: dto.postalCode,
            timezone: dto.timezone,
            // status defaults to PENDING. Not settable from the body.
          },
          select: { id: true, status: true },
        });
        return { user, profile };
      }),
    );

    const session = await this.session(created.user.id, role.slug, { ...created.user, role });
    return {
      ...session,
      vendorProfile: { id: created.profile.id, status: created.profile.status },
    };
  }

  async login(dto: LoginDto): Promise<{ user: PublicUser; access: string; refresh: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { role: true },
    });

    // Burn equivalent CPU on an unknown email so response time does not disclose
    // whether the address is registered.
    if (!user) {
      await this.passwords.burn(dto.password);
      throw Errors.invalidCredentials();
    }

    const ok = await this.passwords.verify(user.passwordHash, dto.password);
    if (!ok) throw Errors.invalidCredentials();

    // Checked after the password, so a disabled account is not disclosed to someone
    // who does not already know the password.
    if (!user.isActive) throw Errors.accountDisabled();

    return this.session(user.id, user.role.slug, {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: { slug: user.role.slug, name: user.role.name },
    });
  }

  async refresh(raw: string): Promise<{ access: string; refresh: string }> {
    const rotated = await this.tokens.rotateRefreshToken(raw);
    return {
      access: await this.tokens.issueAccessToken(rotated.userId, rotated.roleSlug),
      refresh: rotated.raw,
    };
  }

  async logout(raw: string | undefined): Promise<void> {
    if (raw) await this.tokens.revokeRefreshToken(raw);
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true, vendorProfile: true },
    });
    // The token verified, so the user existed when it was minted. Being gone now means
    // deleted mid-session - treat as unauthenticated, not as a 500.
    if (!user) throw Errors.unauthenticated();

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: { slug: user.role.slug, name: user.role.name },
      // Resolved live from the database. This is what makes a revoked permission
      // disappear from the client's navigation on the next refetch.
      permissions: this.resolver.isSuperAdmin(user.role.slug)
        ? ['*']
        : await this.resolver.getEffectiveSlugs(user.id),
      vendorProfile: user.vendorProfile
        ? {
            id: user.vendorProfile.id,
            status: user.vendorProfile.status,
            rejectionReason: user.vendorProfile.rejectionReason,
            timezone: user.vendorProfile.timezone,
          }
        : undefined,
    };
  }

  // ---------------------------------------------------------------- internals

  private async session(
    userId: string,
    roleSlug: string,
    user: PublicUser,
  ): Promise<{ user: PublicUser; access: string; refresh: string }> {
    return {
      user,
      access: await this.tokens.issueAccessToken(userId, roleSlug),
      refresh: await this.tokens.issueRefreshToken(userId),
    };
  }

  private async requireRole(slug: string): Promise<{ id: string; slug: string; name: string }> {
    const role = await this.prisma.role.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true },
    });
    // Means the seed did not run. Fail loudly rather than creating a role on the fly,
    // which would produce a user with no permissions and a confusing empty UI.
    if (!role) throw new Error(`Seed incomplete: role ${slug} is missing`);
    return role;
  }

  private async createUser(data: Prisma.UserUncheckedCreateInput) {
    return this.tx(() =>
      this.prisma.user.create({
        data,
        select: { id: true, email: true, fullName: true },
      }),
    );
  }

  /**
   * Translates the unique-index violation into 409.
   *
   * Deliberately a catch rather than a pre-read: "does this email exist" followed by
   * "insert it" races two concurrent registrations, and the loser gets a 500 from the
   * database. The index is the only reliable arbiter.
   */
  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.emailTaken();
      }
      throw e;
    }
  }
}
