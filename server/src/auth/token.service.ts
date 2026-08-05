import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';

/**
 * Access token payload. Deliberately carries NO permission list.
 *
 * The brief requires that revoking a permission from a role changes what the user can
 * do on their next request with no redeploy. A permission list embedded here would stay
 * stale until the token expired, so permissions are resolved from the database per
 * request instead. roleSlug is included only so the SUPER_ADMIN short-circuit does not
 * need a query.
 */
export type AccessPayload = { sub: string; roleSlug: string; jti: string };

export const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL ?? '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  issueAccessToken(userId: string, roleSlug: string): Promise<string> {
    const payload: AccessPayload = { sub: userId, roleSlug, jti: randomUUID() };
    return this.jwt.signAsync(payload, { expiresIn: ACCESS_TTL });
  }

  /**
   * Returns the raw token for the cookie. Only its SHA-256 is stored.
   *
   * SHA-256 rather than Argon2 on purpose: the token is 32 random bytes, so it is not
   * guessable and needs no work factor, and this runs on every refresh.
   */
  async issueRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
      },
    });
    return raw;
  }

  /**
   * Single-use rotation with theft detection.
   *
   * Presenting an already-revoked token is treated as theft rather than as a mistake:
   * the legitimate holder rotated it, so whoever still has the old value should not
   * keep a session. Every live token for that user is revoked.
   */
  async rotateRefreshToken(raw: string): Promise<{ userId: string; roleSlug: string; raw: string }> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { user: { include: { role: true } } },
    });

    if (!existing || existing.expiresAt <= new Date()) throw Errors.refreshInvalid();

    if (existing.revokedAt) {
      await this.revokeChain(existing.userId);
      throw Errors.refreshInvalid();
    }

    if (!existing.user.isActive) throw Errors.accountDisabled();

    const nextRaw = randomBytes(32).toString('base64url');

    // One transaction: the old token must not be usable while the new one does not
    // exist yet, and the chain link must never be half-written.
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: hashToken(nextRaw),
          expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedByTokenId: created.id },
      });
    });

    return {
      userId: existing.userId,
      roleSlug: existing.user.role.slug,
      raw: nextRaw,
    };
  }

  /** Logout. Idempotent: an unknown or already-revoked token is not an error. */
  async revokeRefreshToken(raw: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeChain(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
