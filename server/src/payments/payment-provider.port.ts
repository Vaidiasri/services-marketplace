/**
 * The port. Nothing outside this folder imports a concrete provider - PaymentsService takes
 * it by injection token, so replacing the mock with a real gateway is one adapter class and
 * one line in payments.module.ts, and no service changes at all.
 *
 * Deliberately narrow. A port that mirrored a real gateway's full surface would be a worse
 * abstraction: every method here is one this application actually calls.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type ProviderOutcome = 'SUCCESS' | 'FAILED' | 'PENDING';

export type ProviderResult = {
  providerRef: string;
  outcome: ProviderOutcome;
  failureReason?: string;
};

export type WebhookPayload = {
  eventId: string;
  providerRef: string;
  outcome: 'SUCCESS' | 'FAILED';
};

export interface PaymentProvider {
  initiate(input: {
    amountMinor: number;
    currency: string;
    token: string;
    reference: string;
  }): Promise<ProviderResult>;

  refund(input: { providerRef: string; amountMinor: number }): Promise<ProviderResult>;

  /** Over the RAW body - a re-serialised object would not reproduce the provider's bytes. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;

  parseWebhook(rawBody: Buffer): WebhookPayload | null;
}
