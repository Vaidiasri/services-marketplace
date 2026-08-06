import { Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock-payment.provider';
import { PAYMENT_PROVIDER } from './payment-provider.port';
import { PaymentsController, WebhookController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * The single line that decides which gateway this application talks to.
 *
 * Replacing the mock with a real provider is: write the adapter, change `useClass` below.
 * No service imports a concrete provider, so nothing else in the codebase moves.
 */
@Module({
  controllers: [PaymentsController, WebhookController],
  providers: [PaymentsService, { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider }, MockPaymentProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
