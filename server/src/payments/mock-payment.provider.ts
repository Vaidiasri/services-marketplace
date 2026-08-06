import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  PaymentProvider,
  ProviderResult,
  WebhookPayload,
} from './payment-provider.port';

/**
 * The only file in the project that knows a payment token exists.
 *
 * Outcomes are chosen by DETERMINISTIC token, not by random failure. A reviewer has to be
 * able to trigger the failure path on demand during a walkthrough; a 10% random decline
 * cannot be demonstrated, only waited for.
 *
 * Stateless on purpose. Every piece of state lives in Payment, LedgerEntry and WebhookEvent -
 * the provider returns a decision and the service records it. A mock that remembered its own
 * payments would be the part that does not survive being replaced by a real gateway.
 */
export const MOCK_TOKENS = {
  SUCCESS: 'tok_success',
  FAIL: 'tok_fail',
  DELAY: 'tok_delay',
  REFUND_FAIL: 'tok_refund_fail',
} as const;

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  private readonly secret = process.env.MOCK_WEBHOOK_SECRET ?? 'mock-webhook-secret';

  async initiate(input: {
    amountMinor: number;
    currency: string;
    token: string;
    reference: string;
  }): Promise<ProviderResult> {
    // The reference is embedded so a webhook delivered by hand can name the payment it is
    // resolving without the caller having to look up an opaque id.
    const providerRef = `mock_${input.reference}_${randomUUID().slice(0, 8)}`;

    switch (input.token) {
      case MOCK_TOKENS.FAIL:
        return { providerRef, outcome: 'FAILED', failureReason: 'card_declined' };
      case MOCK_TOKENS.DELAY:
        // Stays INITIATED until a webhook arrives. There is no timeout sweeper: nothing in
        // the brief asks for one, and a free-tier instance sleeps anyway.
        return { providerRef, outcome: 'PENDING' };
      default:
        return { providerRef, outcome: 'SUCCESS' };
    }
  }

  async refund(input: { providerRef: string; amountMinor: number }): Promise<ProviderResult> {
    // The refund-failure token is recognised from the ref minted at initiate time, so the
    // failing path can be reached from a cancellation that happens much later.
    if (input.providerRef.includes(MOCK_TOKENS.REFUND_FAIL)) {
      return { providerRef: input.providerRef, outcome: 'FAILED', failureReason: 'refund_rejected' };
    }
    return { providerRef: input.providerRef, outcome: 'SUCCESS' };
  }

  /**
   * Real HMAC over the raw body, not decoration.
   *
   * Skipping webhook verification is precisely the thing that does not survive replacement
   * with a real provider - an unverified webhook endpoint lets anyone mark any payment paid.
   * It costs four lines, so there is no reason to leave it out of even a mock.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');

    // Compared in constant time. A plain === leaks how much of the signature was right
    // through timing, which is the standard way these comparisons are got wrong.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer): WebhookPayload | null {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as Partial<WebhookPayload>;
      if (!parsed.eventId || !parsed.providerRef) return null;
      if (parsed.outcome !== 'SUCCESS' && parsed.outcome !== 'FAILED') return null;
      return { eventId: parsed.eventId, providerRef: parsed.providerRef, outcome: parsed.outcome };
    } catch {
      return null;
    }
  }

  /** Exposed so tests and a reviewer can sign a webhook body the same way the provider would. */
  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }
}
