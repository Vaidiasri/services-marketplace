import type { VendorStatus } from '@prisma/client';

/**
 * Ambient augmentation of Express's Request, in its own .d.ts on purpose.
 *
 * It previously lived inside jwt-auth.guard.ts, which meant it only applied when that
 * file happened to be part of the compilation - fine for `nest build`, which reaches it
 * through main.ts, but it broke the moment a test compiled a guard in isolation. A
 * declaration file under src/ is always included, so the augmentation is unconditional.
 */
declare global {
  namespace Express {
    interface Request {
      /** Attached by JwtAuthGuard once a bearer token has been verified. */
      caller?: { userId: string; roleSlug: string };
      /**
       * Attached by ApprovedVendorGuard when the caller is an approved vendor, so the
       * service layer can scope ownership queries without repeating the lookup.
       */
      vendorProfileId?: string;
      /** Reserved for the same guard's status, used by M4 onward. */
      vendorStatus?: VendorStatus;
    }
  }
}
