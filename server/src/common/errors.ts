import { HttpException, HttpStatus } from '@nestjs/common';

/** The one error shape every non-2xx response takes. See doc/03_API_CONVENTIONS.md. */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
};

/**
 * Every deliberate failure in the codebase throws this, so the status code and the
 * machine-readable code are decided together at the throw site rather than inferred
 * later by a filter. A validation failure answering 500 is an outright fail per the
 * brief, and that happens when errors are classified far from where they occur.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: string,
    status: HttpStatus,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  // 401
  unauthenticated: () =>
    new AppError('UNAUTHENTICATED', HttpStatus.UNAUTHORIZED, 'Authentication required.'),
  tokenExpired: () =>
    new AppError('TOKEN_EXPIRED', HttpStatus.UNAUTHORIZED, 'Access token has expired.'),
  tokenInvalid: () =>
    new AppError('TOKEN_INVALID', HttpStatus.UNAUTHORIZED, 'Access token is not valid.'),
  invalidCredentials: () =>
    new AppError('INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED, 'Email or password is incorrect.'),
  refreshInvalid: () =>
    new AppError('REFRESH_INVALID', HttpStatus.UNAUTHORIZED, 'Refresh token is not valid.'),

  // 403
  forbidden: (missing: string[]) =>
    new AppError('FORBIDDEN', HttpStatus.FORBIDDEN, 'You do not have permission to do this.', {
      missing,
    }),
  accountDisabled: () =>
    new AppError('ACCOUNT_DISABLED', HttpStatus.FORBIDDEN, 'This account has been disabled.'),
  escalationBlocked: (missing: string[]) =>
    new AppError(
      'ESCALATION_BLOCKED',
      HttpStatus.FORBIDDEN,
      'You cannot grant permissions you do not hold yourself.',
      { missing },
    ),

  // 403 - the third gate. Distinct codes so the client can render the vendor's actual
  // situation rather than a generic refusal.
  notAVendor: () =>
    new AppError('NOT_A_VENDOR', HttpStatus.FORBIDDEN, 'This account is not a vendor.'),
  vendorPending: () =>
    new AppError(
      'VENDOR_PENDING_APPROVAL',
      HttpStatus.FORBIDDEN,
      'Your vendor account is awaiting approval.',
    ),
  vendorRejected: (reason: string | null) =>
    new AppError(
      'VENDOR_REJECTED',
      HttpStatus.FORBIDDEN,
      'Your vendor application was rejected.',
      { reason },
    ),

  // 404
  notFound: (what = 'Resource') =>
    new AppError('NOT_FOUND', HttpStatus.NOT_FOUND, `${what} not found.`),
  // A row exists but its file does not. Expected on Render, whose disk is ephemeral -
  // 410 says "was here, is gone" where 404 would wrongly imply it never existed.
  fileGone: () =>
    new AppError('FILE_GONE', HttpStatus.GONE, 'That file is no longer available.'),

  // 409
  emailTaken: () =>
    new AppError('EMAIL_TAKEN', HttpStatus.CONFLICT, 'That email is already registered.'),
  roleSlugTaken: () =>
    new AppError('ROLE_SLUG_TAKEN', HttpStatus.CONFLICT, 'A role with that slug already exists.'),
  systemRoleImmutable: () =>
    new AppError(
      'SYSTEM_ROLE_IMMUTABLE',
      HttpStatus.CONFLICT,
      'System roles cannot be deleted or renamed.',
    ),
  roleInUse: (userCount: number) =>
    new AppError('ROLE_IN_USE', HttpStatus.CONFLICT, 'That role is still assigned to users.', {
      userCount,
    }),
  profileLocked: (fields: string[]) =>
    new AppError(
      'PROFILE_LOCKED',
      HttpStatus.CONFLICT,
      'These fields cannot be changed after approval.',
      { fields },
    ),
  categoryExists: (name: string) =>
    new AppError('CATEGORY_EXISTS', HttpStatus.CONFLICT, 'A sibling category already has that name.', {
      name,
    }),
  categoryInUse: (childCount: number, serviceCount: number) =>
    new AppError('CATEGORY_IN_USE', HttpStatus.CONFLICT, 'That category is still in use.', {
      childCount,
      serviceCount,
    }),
  serviceInUse: (bookingCount: number) =>
    new AppError('SERVICE_IN_USE', HttpStatus.CONFLICT, 'That service has bookings and cannot be deleted.', {
      bookingCount,
    }),
  offeringInUse: (bookingCount: number) =>
    new AppError(
      'OFFERING_IN_USE',
      HttpStatus.CONFLICT,
      'That offering has bookings. Set isActive to false instead of deleting it.',
      { bookingCount },
    ),
  futureBookingsExist: (bookingCount: number) =>
    new AppError(
      'FUTURE_BOOKINGS_EXIST',
      HttpStatus.CONFLICT,
      'That service has upcoming bookings, so it cannot be withdrawn.',
      { bookingCount },
    ),
  // 409 - the clean refusal the brief requires when a seat is gone.
  slotFull: () =>
    new AppError('SLOT_FULL', HttpStatus.CONFLICT, 'That slot has just been taken.'),
  // A waiter that timed out behind another transaction's lock. Distinct from SLOT_FULL: the
  // seat may still be free, the caller simply could not get in to check.
  slotContended: () =>
    new AppError(
      'SLOT_CONTENDED',
      HttpStatus.CONFLICT,
      'That slot is being booked right now. Try again.',
    ),
  idempotencyKeyReused: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      HttpStatus.CONFLICT,
      'That Idempotency-Key was already used with a different request body.',
    ),
  wouldOrphanPublishedService: () =>
    new AppError(
      'WOULD_ORPHAN_PUBLISHED_SERVICE',
      HttpStatus.CONFLICT,
      'A published service must keep at least one availability rule. Unpublish it first.',
    ),
  lastSuperAdmin: () =>
    new AppError(
      'LAST_SUPER_ADMIN',
      HttpStatus.CONFLICT,
      'This is the only active super admin and cannot be changed.',
    ),

  // 413
  fileTooLarge: (maxBytes: number) =>
    new AppError(
      'FILE_TOO_LARGE',
      HttpStatus.PAYLOAD_TOO_LARGE,
      `That file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      { maxBytes },
    ),

  // 422 - the request was well-formed but semantically wrong
  validationFailed: (details: unknown) =>
    new AppError(
      'VALIDATION_FAILED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The request body is not valid.',
      details,
    ),
  unsupportedFileType: (allowed: string[]) =>
    new AppError(
      'UNSUPPORTED_FILE_TYPE',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That file type is not accepted.',
      { allowed },
    ),
  categoryDepthExceeded: () =>
    new AppError(
      'CATEGORY_DEPTH_EXCEEDED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Categories are two levels deep. That parent is already a subcategory.',
    ),
  categoryInvalid: () =>
    new AppError(
      'CATEGORY_INVALID',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That category does not exist or is not active.',
    ),
  noActiveOffering: () =>
    new AppError(
      'NO_ACTIVE_OFFERING',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Add at least one active offering before publishing.',
    ),
  noAvailability: () =>
    new AppError(
      'NO_AVAILABILITY',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Set at least one weekly availability rule before publishing.',
    ),
  // The boundary check that keeps the slot grid representable. See M5 for why an
  // unaligned duration cannot be laid on a shared capacity grid.
  durationNotAligned: (granularityMinutes: number) =>
    new AppError(
      'DURATION_NOT_ALIGNED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Duration must be a multiple of the service's ${granularityMinutes}-minute slot size.`,
      { granularityMinutes },
    ),
  granularityConflict: (offeringIds: string[], granularityMinutes: number) =>
    new AppError(
      'GRANULARITY_CONFLICT',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Existing offerings do not divide evenly into that slot size.',
      { offeringIds, granularityMinutes },
    ),
  // 400 rather than 422: the header is missing entirely, so there is no body to fault.
  idempotencyKeyRequired: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REQUIRED',
      HttpStatus.BAD_REQUEST,
      'This request needs an Idempotency-Key header.',
    ),

  illegalTransition: (from: string, to: string, allowed: string[]) =>
    new AppError(
      'ILLEGAL_TRANSITION',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `A ${from} booking cannot become ${to}.`,
      { from, to, allowed },
    ),
  invalidSlot: () =>
    new AppError(
      'INVALID_SLOT',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That start time is not an available slot for this offering.',
    ),
  slotInPast: () =>
    new AppError('SLOT_IN_PAST', HttpStatus.UNPROCESSABLE_ENTITY, 'That slot has already started.'),
  paymentRequired: () =>
    new AppError(
      'PAYMENT_REQUIRED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Payment has not succeeded for this booking yet.',
    ),
  tooEarlyToComplete: () =>
    new AppError(
      'TOO_EARLY_TO_COMPLETE',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The appointment has not finished yet.',
    ),
  tooEarlyForNoShow: () =>
    new AppError(
      'TOO_EARLY_FOR_NO_SHOW',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The appointment has not started yet.',
    ),

  invalidWindow: (detail: string) =>
    new AppError('INVALID_WINDOW', HttpStatus.UNPROCESSABLE_ENTITY, detail),
  dateInPast: (date: string) =>
    new AppError(
      'DATE_IN_PAST',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That date has already passed in the vendor\'s timezone.',
      { date },
    ),
  offeringRequired: () =>
    new AppError(
      'OFFERING_REQUIRED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Slots depend on how long the appointment is, so an offeringId is required.',
    ),
  rangeTooLarge: (maxDays: number) =>
    new AppError(
      'RANGE_TOO_LARGE',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Ask for at most ${maxDays} days at a time.`,
      { maxDays },
    ),
  unknownPermissions: (slugs: string[]) =>
    new AppError(
      'UNKNOWN_PERMISSIONS',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'One or more permission slugs do not exist.',
      { slugs },
    ),
} as const;
