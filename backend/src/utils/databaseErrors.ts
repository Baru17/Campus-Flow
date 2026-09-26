const TRANSIENT_D1_ERROR = /D1 DB is overloaded|Network connection lost|Replica disconnected from primary|Cannot resolve D1 DB due to transient issue|D1 DB reset because its code was updated|Internal error while starting up D1 DB storage caused object to be reset|Internal error in D1 DB storage caused object to be reset/i

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return [error.message, cause instanceof Error ? cause.message : String(cause || "")].join(" ");
  }
  return String(error);
}

export function isTransientD1Error(error: unknown): boolean {
  return TRANSIENT_D1_ERROR.test(getErrorMessage(error));
}

export function getErrorMessageForLog(error: unknown): string {
  return getErrorMessage(error);
}