import { Module } from '@nestjs/common';
import { AdminServicesController } from './admin-services.controller';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { OfferingsController } from './offerings.controller';
import { OfferingsService } from './offerings.service';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { VendorServicesController } from './vendor-services.controller';

/**
 * No imports: RbacModule is @Global, so PermissionResolver injects without one. The
 * detail routes use it to ask whether a caller holds `service.read_all`, a check that
 * cannot be a guard - it does not decide whether the route runs, only whether an
 * unpublished row is visible through it, and the answer has to be 404 rather than 403.
 *
 * ServicesController owns `GET /services/:id` and its class-level @Public() applies only
 * to its own methods; the vendor and admin controllers declare their own permissions and
 * are unaffected.
 */
@Module({
  controllers: [
    CategoriesController,
    ServicesController,
    VendorServicesController,
    AdminServicesController,
    OfferingsController,
  ],
  providers: [CategoriesService, ServicesService, OfferingsService],
  exports: [ServicesService, OfferingsService],
})
export class CatalogModule {}
