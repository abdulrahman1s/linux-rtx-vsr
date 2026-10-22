// Browser exceptions, rejected native replies and thrown values share one
// human-readable recovery path without weakening strict catch typing.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
