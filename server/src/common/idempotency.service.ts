import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';

export type Replay = { responseStatus: number; responseBody: unknown };

/**
 * Idempotency for POST /bookings, and reused by M7's payment confirm.
 *
 * Keys are scoped `(userId, scope, key)`, so one user's key cannot collide with another's -
 * a key guessed or stolen from someone else matches nothing. The request body is hashed and
 * stored, so replaying a key with a DIFFERENT body is a 409 rather than silently returning
 * a response that does not describe what was asked for.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  static hash(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  /**
   * Returns the stored response when this exact request has already been answered, null when
   * it is new. Throws 409 when the key is being reused for something else.
   *
   * A record with no stored response means a previous attempt reserved the key and then
   * failed - the transaction rolled back and the record went with it, so in practice this is
   * only reachable if a response was never recorded. Treated as new rather than blocking the
   * user forever on a key their client will keep retrying.
   */
  async check(
    userId: string,
    scope: string,
    key: string,
    body: unknown,
  ): Promise<Replay | null> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId, scope, key } },
      select: { requestHash: true, responseStatus: true, responseBody: true },
    });
    if (!existing) return null;

    if (existing.requestHash !== IdempotencyService.hash(body)) {
      throw Errors.idempotencyKeyReused();
    }
    if (existing.responseStatus === null) return null;

    return { responseStatus: existing.responseStatus, responseBody: existing.responseBody };
  }

  /**
   * Written INSIDE the caller's transaction, on purpose. If the booking commits, so does the
   * key; if the booking rolls back, the key vanishes with it and the client's retry is
   * treated as a first attempt. Recording it afterwards would leave a key claiming success
   * for a booking that does not exist.
   */
  record(
    tx: Prisma.TransactionClient,
    userId: string,
    scope: string,
    key: string,
    body: unknown,
    responseStatus: number,
    responseBody: unknown,
  ) {
    return tx.idempotencyKey.create({
      data: {
        userId,
        scope,
        key,
        requestHash: IdempotencyService.hash(body),
        responseStatus,
        responseBody: responseBody as never,
      },
    });
  }
}
