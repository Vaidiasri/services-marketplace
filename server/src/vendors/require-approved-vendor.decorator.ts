import { SetMetadata } from '@nestjs/common';

export const REQUIRE_APPROVED_VENDOR = 'requireApprovedVendor';

/**
 * The third gate, orthogonal to permission and ownership.
 *
 * A decorator rather than a condition inside a service method, for two reasons: it is
 * visible on the route when reading the controller, and it is discoverable by
 * reflection - so the route-coverage test can be extended to assert that every vendor
 * write route carries it, the same way it asserts permissions today.
 *
 * Holding `service.publish` is not sufficient to publish. Permission, ownership and
 * vendor status are three independent checks.
 */
export const RequireApprovedVendor = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_APPROVED_VENDOR, true);
