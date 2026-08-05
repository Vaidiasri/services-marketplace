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
  unknownPermissions: (slugs: string[]) =>
    new AppError(
      'UNKNOWN_PERMISSIONS',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'One or more permission slugs do not exist.',
      { slugs },
    ),
} as const;
