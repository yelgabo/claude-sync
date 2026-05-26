export type ErrorCode =
  | 'invalid_request' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'unknown_device' | 'conflict' | 'too_large' | 'too_many_requests'
  | 'quota_exceeded' | 'precondition_required' | 'gone' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  unknown_device: 400, conflict: 409, too_large: 413, too_many_requests: 429,
  quota_exceeded: 507, precondition_required: 412, gone: 410, internal: 500,
};

export class ApiError extends Error {
  constructor(public code: ErrorCode, message?: string) {
    super(message ?? code); this.name = 'ApiError';
  }
  get status(): number { return STATUS[this.code]; }
  toJSON() { return { error: { code: this.code, message: this.message } }; }
}
