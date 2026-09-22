export const ApiErrorCodes = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'ITEM_NOT_FOUND',
  'ITEM_INVALID_STATE',
  'ITEM_VERSION_CONFLICT',
  'VALIDATION_FAILED',
] as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}
