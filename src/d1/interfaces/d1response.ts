export interface D1Response {
  success: boolean;
  errors: unknown[];
  messages: unknown[];
  result?: Array<{
    results: unknown[];
    success: boolean;
    meta: unknown;
  }>;
}
