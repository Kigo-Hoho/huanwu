export const ApiErrorCodes = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'ITEM_NOT_FOUND',
  'ITEM_INVALID_STATE',
  'ITEM_VERSION_CONFLICT',
  'ITEM_UNAVAILABLE',
  'PROPOSAL_NOT_FOUND',
  'PROPOSAL_INVALID_STATE',
  'PROPOSAL_VERSION_CONFLICT',
  'PROPOSAL_EXPIRED',
  'PROPOSAL_WRONG_TURN',
  'PROPOSAL_SIDE_FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'IDENTITY_PROVIDER_UNAVAILABLE',
  'VALIDATION_FAILED',
] as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}
